import { createSeedState } from './tag-seed'
import { evaluateExpression, findObject, objectKeyOf, parseExpression } from './tag-expr'
import { EVIDENCE_LABELS, emptyCounts } from './tag-types'
import type {
  CoverageCounts,
  CoverageEntry,
  CoverageSource,
  DatasetObject,
  Evidence,
  EvidenceKind,
  FilterHitRow,
  FilterRun,
  ObjectType,
  ReportRead,
  ScopeChild,
  ScopeObject,
  ScopeResult,
  TagActionResult,
  TagDefinition,
  TagDetail,
  TagListRow,
  TagReport,
  TagState,
  TagStats,
  TagVersion,
  ValidationResult,
} from './tag-types'
import { persistTagState, readTagState } from './tag-store'

/**
 * 标签领域引擎：以数据筛选任务产出的命中行为输入，逐版本计算覆盖范围。
 *
 * 关键约束：
 * 1. 每次回算冻结表达式 / 值域 / 数据源快照，编辑不会中途替换正在回算的版本；
 * 2. 父标签 = 自身命中 ∪ 生效子标签版本，按对象去重，子集校验保证父范围包含子范围；
 * 3. 已发布版本不可变，报告引用 versionId，表达式调整后旧报告仍读旧结果；
 * 4. 已删除对象保留来源快照但不进入新覆盖统计；异常对象不算已覆盖；
 * 5. 值域为空、重复命中、标签失效等情况逐条给出未命中证据。
 */

const DAY_MS = 24 * 60 * 60 * 1000

let state: TagState | null = null
let versionSequence = 0
let bootstrapped = false

function nowIso(): string {
  return new Date().toISOString()
}

function now(): number {
  return Date.now()
}

function nextVersionId(): string {
  versionSequence += 1
  return `VER-${Date.now().toString(36).toUpperCase()}-${String(versionSequence).padStart(3, '0')}`
}

function nextToken(): string {
  return `TOKEN-${Math.random().toString(36).slice(2, 10).toUpperCase()}`
}

function commit(): void {
  persistTagState(stateNow())
}

/** 仅用于测试与恢复：清掉内存态，下一次读取会重新从 localStorage 恢复。 */
export function setTagState(next: TagState | null): void {
  state = next
  bootstrapped = false
  versionSequence = 0
}

/** 首次读取：优先本地持久化，否则用示例数据并跑出初始版本。 */
export function ensureTagState(): TagState {
  if (state !== null && bootstrapped) return state
  const stored = readTagState()
  if (stored) {
    state = stored
    versionSequence = stored.versions.length
    bootstrapped = true
    return state
  }
  state = createSeedState()
  versionSequence = 0
  bootstrapVersions()
  bootstrapped = true
  commit()
  return state
}

function stateNow(): TagState {
  if (state === null) {
    state = createSeedState()
    bootstrapVersions()
    bootstrapped = true
    commit()
  }
  return state
}

export function isExpired(version: TagVersion | null | undefined, definition: TagDefinition): boolean {
  if (!version || !version.finishedAt) return false
  const basis = Date.parse(version.finishedAt)
  if (Number.isNaN(basis)) return false
  return now() - basis > definition.expireDays * DAY_MS
}

function isUsableVersion(version: TagVersion | null | undefined): boolean {
  return !!version && (version.status === '已发布' || version.status === '已替代')
}

export function findDefinition(code: string): TagDefinition | undefined {
  return stateNow().definitions.find((item) => item.code === code)
}

export function childrenOf(code: string): TagDefinition[] {
  return stateNow().definitions.filter((item) => item.parentCode === code)
}

export function versionsOf(code: string): TagVersion[] {
  return stateNow()
    .versions.filter((item) => item.tagCode === code)
    .sort((a, b) => a.version - b.version)
}

export function computingVersionOf(code: string): TagVersion | null {
  return stateNow().versions.find((item) => item.tagCode === code && item.status === '计算中') ?? null
}

/** 当前有效版本：最近一次已发布结果（被后续成功版本替代后仍为历史有效版本）。 */
export function currentVersionOf(code: string): TagVersion | null {
  const versions = versionsOf(code).filter((item): item is TagVersion => isUsableVersion(item))
  return versions.length > 0 ? versions[versions.length - 1] : null
}

/** 最近一次尝试（含失败 / 中断），用于空态与重试入口。 */
export function latestVersionOf(code: string): TagVersion | null {
  const versions = versionsOf(code)
  return versions.length > 0 ? versions[versions.length - 1] : null
}

export function findVersion(versionId: string): TagVersion | undefined {
  return stateNow().versions.find((item) => item.id === versionId)
}

export function findFilterRun(runId: string): FilterRun | undefined {
  return stateNow().filterRuns.find((item) => item.runId === runId)
}

export function findReport(reportId: string): TagReport | undefined {
  return stateNow().reports.find((item) => item.id === reportId)
}

function evidence(kind: EvidenceKind, message: string, extra: Partial<Evidence> = {}): Evidence {
  return { kind, label: EVIDENCE_LABELS[kind] ?? kind, message, ...extra }
}

function pushUnique(list: Evidence[], item: Evidence): void {
  const key = `${item.kind}|${item.objectId ?? ''}|${item.sourceTagCode ?? ''}|${item.message}`
  if (
    list.some(
      (existing) =>
        `${existing.kind}|${existing.objectId ?? ''}|${existing.sourceTagCode ?? ''}|${existing.message}` === key,
    )
  ) {
    return
  }
  list.push(item)
}

type OwnBucket = {
  objectId: string
  objectType: ObjectType
  name: string
  sources: CoverageSource[]
  hitCount: number
  state: DatasetObject['state'] | '不存在'
  reason?: string
  value?: string
  evidence: EvidenceKind[]
}

/** 计算标签自身命中范围：输入是筛选任务命中行，未覆盖对象逐条记录证据。 */
function computeOwnCoverage(
  definition: TagDefinition,
  version: TagVersion,
  outEvidence: Evidence[],
): { buckets: Map<string, OwnBucket>; counts: CoverageCounts } {
  const buckets = new Map<string, OwnBucket>()
  const counts = emptyCounts()
  const run = findFilterRun(version.sourceRunIdSnapshot)

  if (!run) {
    pushUnique(
      outEvidence,
      evidence('filter-failure', `输入筛选任务 ${version.sourceRunIdSnapshot} 不存在，没有命中行可作为输入`, {
        sourceRunId: version.sourceRunIdSnapshot,
      }),
    )
    return { buckets, counts }
  }
  if (run.status === '失败') {
    pushUnique(
      outEvidence,
      evidence('filter-failure', `筛选任务 ${run.runId} 执行失败：${run.failureReason ?? '未提供原因'}`, {
        sourceRunId: run.runId,
      }),
    )
    return { buckets, counts }
  }
  if (run.status === '已中断') {
    pushUnique(
      outEvidence,
      evidence('interrupted', `筛选任务 ${run.runId} 被中断：${run.failureReason ?? '未提供原因'}`, {
        sourceRunId: run.runId,
      }),
    )
    return { buckets, counts }
  }
  if (run.status !== '已完成') {
    pushUnique(
      outEvidence,
      evidence('filter-failure', `筛选任务 ${run.runId} 状态为「${run.status}」，暂时没有结果`, {
        sourceRunId: run.runId,
      }),
    )
    return { buckets, counts }
  }
  if (run.hitRows.length === 0) {
    pushUnique(outEvidence, evidence('no-hit-rows', `筛选任务 ${run.runId} 已完成但没有命中任何行`, { sourceRunId: run.runId }))
    return { buckets, counts }
  }

  counts.hitRows = run.hitRows.length
  if (version.valueDomainSnapshot.length === 0) {
    counts.emptyDomain = run.hitRows.length
    pushUnique(
      outEvidence,
      evidence('empty-domain', '值域范围为空，命中行无法落到任何标签值，全部未命中', {
        sourceRunId: run.runId,
        count: run.hitRows.length,
      }),
    )
    return { buckets, counts }
  }

  try {
    parseExpression(version.expressionSnapshot)
  } catch (error) {
    pushUnique(outEvidence, evidence('parse-error', error instanceof Error ? error.message : '计算表达式无法解析'))
    return { buckets, counts }
  }

  const rowsByObject = new Map<string, FilterHitRow[]>()
  for (const row of run.hitRows) {
    const key = objectKeyOf(row.objectType, row.objectId)
    const list = rowsByObject.get(key)
    if (list) list.push(row)
    else rowsByObject.set(key, [row])
  }

  for (const [key, rows] of rowsByObject) {
    const first = rows[0]
    counts.uniqueObjects += 1
    if (rows.length > 1) {
      counts.duplicates += rows.length - 1
      pushUnique(
        outEvidence,
        evidence(
          'duplicate-hit',
          `对象 ${first.objectId} 在筛选命中结果中出现 ${rows.length} 次，按对象去重后只计一次`,
          {
            objectId: first.objectId,
            sourceRunId: run.runId,
            sourceRowId: rows.map((row) => row.rowId).join(','),
            count: rows.length,
          },
        ),
      )
    }

    const object = findObject(stateNow(), first.objectType, first.objectId)
    const bucket: OwnBucket = {
      objectId: first.objectId,
      objectType: first.objectType,
      name: object?.name ?? `已删除对象 ${first.objectId}`,
      sources: rows.map((row) => ({
        tagCode: definition.code,
        versionId: version.id,
        runId: run.runId,
        rowId: row.rowId,
        ruleCode: run.ruleCode,
      })),
      hitCount: rows.length,
      state: object ? object.state : '不存在',
      reason: object?.stateNote,
      evidence: [],
    }

    if (!object) {
      counts.missingObject += 1
      bucket.evidence.push('missing-object')
      pushUnique(
        outEvidence,
        evidence('missing-object', `命中行引用的对象 ${first.objectId} 已不存在，不能伪装成已覆盖`, {
          objectId: first.objectId,
          sourceRunId: run.runId,
        }),
      )
      buckets.set(key, bucket)
      continue
    }

    const raw = object.attributes[version.valueFieldSnapshot]
    const value = raw === undefined ? undefined : String(raw)
    bucket.value = value
    if (value === undefined || !version.valueDomainSnapshot.includes(value)) {
      counts.outOfDomain += 1
      bucket.evidence.push('out-of-domain')
      pushUnique(
        outEvidence,
        evidence(
          'out-of-domain',
          `对象 ${first.objectId} 的值「${value ?? '空'}」不在值域 [${version.valueDomainSnapshot.join(', ')}] 内`,
          { objectId: first.objectId, sourceRunId: run.runId },
        ),
      )
      buckets.set(key, bucket)
      continue
    }

    let matches = false
    try {
      matches = evaluateExpression(version.expressionSnapshot, object.attributes)
    } catch {
      matches = false
    }
    if (!matches) {
      counts.missedExpression += 1
      bucket.evidence.push('filter-miss')
      pushUnique(
        outEvidence,
        evidence(
          'filter-miss',
          `对象 ${first.objectId}（值 ${value}）未命中计算表达式「${version.expressionSnapshot}」`,
          { objectId: first.objectId, sourceRunId: run.runId },
        ),
      )
    }

    if (object.state === '已删除') {
      counts.deleted += 1
      bucket.evidence.push('deleted-object')
      pushUnique(
        outEvidence,
        evidence('deleted-object', `对象 ${first.objectId} 已删除，旧结果保留来源但不再参与新覆盖统计`, {
          objectId: first.objectId,
          sourceRunId: run.runId,
        }),
      )
    } else if (object.state === '异常') {
      counts.abnormal += 1
      bucket.evidence.push('abnormal-object')
      pushUnique(
        outEvidence,
        evidence('abnormal-object', `对象 ${first.objectId} 处于异常状态（${object.stateNote ?? '未说明'}），不计入已覆盖`, {
          objectId: first.objectId,
          sourceRunId: run.runId,
        }),
      )
    }
    buckets.set(key, bucket)
  }

  return { buckets, counts }
}

function bucketIncluded(bucket: OwnBucket): boolean {
  return bucket.state === '正常' && !bucket.evidence.includes('filter-miss') && !bucket.evidence.includes('out-of-domain')
}

/** 父标签范围边界：显式边界优先，否则退回父标签自身表达式。 */
function boundaryOf(parent: TagDefinition): string {
  return parent.boundaryExpression.trim() || parent.expression.trim()
}

function satisfyBoundary(parent: TagDefinition, entry: CoverageEntry): boolean {
  const boundary = boundaryOf(parent)
  if (boundary === '') return true
  const object = findObject(stateNow(), entry.objectType, entry.objectId)
  if (!object) return false
  try {
    return evaluateExpression(boundary, object.attributes)
  } catch {
    return false
  }
}

function childContribution(
  child: TagDefinition,
  parent: TagDefinition,
  version: TagVersion,
  coverage: CoverageEntry[],
  counts: CoverageCounts,
  outEvidence: Evidence[],
): string[] {
  const childVersion = currentVersionOf(child.code)
  if (!childVersion) {
    pushUnique(
      outEvidence,
      evidence('no-child-version', `子标签 ${child.code} 没有已发布版本，其对象未并入父标签范围`, {
        sourceTagCode: child.code,
      }),
    )
    return []
  }
  if (child.status !== '已启用') {
    pushUnique(
      outEvidence,
      evidence('inactive', `子标签 ${child.code} 当前状态为「${child.status}」，其对象未并入父标签范围`, {
        sourceTagCode: child.code,
      }),
    )
    return []
  }
  if (isExpired(childVersion, child)) {
    pushUnique(
      outEvidence,
      evidence('expired', `子标签 ${child.code} 的结果已失效，其对象未并入父标签范围`, {
        sourceTagCode: child.code,
        count: childVersion.coverage.length,
      }),
    )
    return []
  }

  const added: string[] = []
  for (const entry of childVersion.coverage) {
    counts.childObjectRefs += 1
    const key = objectKeyOf(entry.objectType, entry.objectId)
    const existing = coverage.find((item) => objectKeyOf(item.objectType, item.objectId) === key)
    const outsideParent = entry.included && !satisfyBoundary(parent, entry)
    if (existing) {
      // 只有真正计入覆盖的重复命中才算去重；未覆盖对象不改变父标签结果
      if (!entry.included) continue
      if (outsideParent) {
        pushUnique(
          outEvidence,
          evidence(
            'outside-parent',
            `子标签 ${child.code} 的对象 ${entry.objectId} 不满足父标签 ${parent.code} 的范围边界「${boundaryOf(parent)}」，未并入父范围`,
            { objectId: entry.objectId, sourceTagCode: child.code },
          ),
        )
        continue
      }
      for (const source of entry.sources) {
        mergeSource(existing.sources, { ...source, fromChildTagCode: child.code })
      }
      if (existing.included) {
        counts.dedupedWithChildren += 1
        pushUnique(
          outEvidence,
          evidence(
            'duplicate-hit',
            `对象 ${entry.objectId} 同时被标签 ${parent.code} 与子标签 ${child.code} 覆盖，按对象去重只计一次`,
            { objectId: entry.objectId, sourceTagCode: child.code },
          ),
        )
        continue
      }
      // 父标签自身没覆盖上、但子标签覆盖上了：按子标签并入，计入一次
      const current = findObject(stateNow(), entry.objectType, entry.objectId)
      const currentState = current?.state ?? '不存在'
      if (
        currentState === '正常' &&
        child.status === '已启用' &&
        !isExpired(childVersion, child) &&
        !isExpired(version, parent)
      ) {
        existing.included = true
        existing.origin = '子标签'
        existing.reason = undefined
        // 自身未命中的证据不再成立：该对象是靠子标签范围进来的
        const wasMissed = existing.evidence.includes('filter-miss')
        const wasOutsideDomain = existing.evidence.includes('out-of-domain')
        existing.evidence = existing.evidence.filter(
          (kind) => kind !== 'filter-miss' && kind !== 'out-of-domain',
        )
        if (wasMissed) counts.missedExpression = Math.max(0, counts.missedExpression - 1)
        if (wasOutsideDomain) counts.outOfDomain = Math.max(0, counts.outOfDomain - 1)
        for (let index = outEvidence.length - 1; index >= 0; index -= 1) {
          const item = outEvidence[index]
          if (
            item.objectId === entry.objectId &&
            (item.kind === 'filter-miss' || item.kind === 'out-of-domain')
          ) {
            outEvidence.splice(index, 1)
          }
        }
        counts.fromChildren += 1
        added.push(key)
      }
      continue
    }

    // 子标签自身都没覆盖上的对象（表达式未命中 / 值域外）不能并入父范围
    if (!entry.included && entry.stateAtCompute === '正常') {
      continue
    }
    const current = findObject(stateNow(), entry.objectType, entry.objectId)
    const currentState = current?.state ?? '不存在'
    if (outsideParent) {
      // 子标签超出父标签自身范围：拒绝并入，并留下证据供启用校验使用
      pushUnique(
        outEvidence,
        evidence(
          'outside-parent',
          `子标签 ${child.code} 的对象 ${entry.objectId} 不满足父标签 ${parent.code} 的范围边界「${boundaryOf(parent)}」，未并入父范围`,
          { objectId: entry.objectId, sourceTagCode: child.code },
        ),
      )
    }
    const included =
      entry.included &&
      !outsideParent &&
      currentState === '正常' &&
      child.status === '已启用' &&
      !isExpired(childVersion, child) &&
      !isExpired(version, parent)

    coverage.push({
      objectId: entry.objectId,
      objectType: entry.objectType,
      name: current?.name ?? entry.name,
      origin: '子标签',
      sources: entry.sources.map((source) => ({
        ...source,
        fromChildTagCode: source.fromChildTagCode ?? child.code,
      })),
      hitCount: entry.hitCount,
      included,
      stateAtCompute: currentState,
      reason:
        currentState === '已删除'
          ? '对象已删除，旧结果保留来源但不再参与新覆盖统计'
          : currentState === '异常'
            ? '对象处于异常状态，不计入已覆盖'
            : undefined,
      value: entry.value,
      evidence: [...entry.evidence],
    })
    if (included) {
      counts.fromChildren += 1
      added.push(key)
    }
  }
  return added
}

function mergeSource(list: CoverageSource[], source: CoverageSource): void {
  const exists = list.some(
    (item) =>
      item.tagCode === source.tagCode &&
      item.versionId === source.versionId &&
      item.runId === source.runId &&
      item.rowId === source.rowId,
  )
  if (!exists) list.push(source)
}

/** 回算核心：自身命中 ∪ 子标签有效版本，按对象去重。 */
function computeVersion(definition: TagDefinition, attempt: TagVersion): TagVersion {
  const version: TagVersion = {
    ...attempt,
    coverage: [],
    evidence: [],
    counts: emptyCounts(),
    childVersionSnapshot: {},
  }
  const outEvidence: Evidence[] = []
  const { buckets, counts } = computeOwnCoverage(definition, version, outEvidence)

  const coverage: CoverageEntry[] = []
  for (const bucket of buckets.values()) {
    coverage.push({
      objectId: bucket.objectId,
      objectType: bucket.objectType,
      name: bucket.name,
      origin: '自身',
      sources: bucket.sources,
      hitCount: bucket.hitCount,
      included: bucketIncluded(bucket),
      stateAtCompute: bucket.state,
      reason: bucket.reason,
      value: bucket.value,
      evidence: bucket.evidence,
    })
  }
  counts.selfCovered = coverage.filter((item) => item.included).length

  for (const child of childrenOf(definition.code)) {
    const childVersion = currentVersionOf(child.code)
    if (childVersion) {
      version.childVersionSnapshot[child.code] = childVersion.id
    }
    childContribution(child, definition, version, coverage, counts, outEvidence)
  }

  counts.covered = coverage.filter((item) => item.included).length
  counts.deleted = coverage.filter((item) => item.stateAtCompute === '已删除').length
  counts.abnormal = coverage.filter((item) => item.stateAtCompute === '异常').length
  version.coverage = coverage
  version.counts = counts
  version.evidence = outEvidence
  return version
}

function snapshotFor(
  definition: TagDefinition,
): Pick<
  TagVersion,
  | 'expressionSnapshot'
  | 'valueDomainSnapshot'
  | 'sourceRunIdSnapshot'
  | 'objectTypeSnapshot'
  | 'valueFieldSnapshot'
  | 'boundarySnapshot'
> {
  return {
    expressionSnapshot: definition.expression,
    boundarySnapshot: boundaryOf(definition),
    valueDomainSnapshot: [...definition.valueDomain],
    sourceRunIdSnapshot: definition.sourceRunId,
    objectTypeSnapshot: definition.objectType,
    valueFieldSnapshot: definition.valueField,
  }
}

function updateVersion(versionId: string, patch: Partial<TagVersion>): TagVersion | undefined {
  const s = stateNow()
  const index = s.versions.findIndex((item) => item.id === versionId)
  if (index < 0) return undefined
  s.versions[index] = { ...s.versions[index], ...patch }
  return s.versions[index]
}

/**
 * 启动回算：冻结当前定义快照，落一条「计算中」版本。
 * 同一标签同时只允许一个计算中版本，后续编辑不会替换它的快照。
 */
export function startRecompute(definition: TagDefinition): TagActionResult {
  const computing = computingVersionOf(definition.code)
  if (computing) {
    return {
      ok: false,
      message: `标签 ${definition.code} 的版本 v${computing.version} 正在回算，请等待完成或先中断，不能中途替换`,
      version: computing,
    }
  }
  const previous = latestVersionOf(definition.code)
  const attempt: TagVersion = {
    id: nextVersionId(),
    tagCode: definition.code,
    version: previous ? previous.version + 1 : 1,
    status: '计算中',
    definitionRevision: definition.revision,
    token: nextToken(),
    startedAt: nowIso(),
    coverage: [],
    evidence: [],
    counts: emptyCounts(),
    childVersionSnapshot: {},
    ...snapshotFor(definition),
  }
  stateNow().versions.push(attempt)
  commit()
  return {
    ok: true,
    message: `已开始回算版本 v${attempt.version}，表达式与数据源已冻结`,
    version: attempt,
    versionId: attempt.id,
    token: attempt.token,
    versionNo: attempt.version,
  }
}

/** 完成回算并发布；令牌必须与启动时一致，避免被并发操作替换。 */
export function completeRecompute(tagCode: string, token: string): TagActionResult {
  const computing = computingVersionOf(tagCode)
  if (!computing) return { ok: false, message: `标签 ${tagCode} 没有正在回算的版本` }
  if (computing.token !== token) {
    return {
      ok: false,
      message: `回算令牌不匹配，版本 v${computing.version} 已被替换或不属于本次计算`,
      version: computing,
    }
  }
  const definition = findDefinition(tagCode)
  if (!definition) return { ok: false, message: `标签 ${tagCode} 不存在` }

  const run = findFilterRun(computing.sourceRunIdSnapshot)
  if (!run || run.status !== '已完成') {
    const reason = !run
      ? `输入筛选任务 ${computing.sourceRunIdSnapshot} 不存在`
      : `筛选任务 ${run.runId} 状态为「${run.status}」：${run.failureReason ?? '未完成'}，回算失败`
    const failed: TagVersion = {
      ...computing,
      status: '失败',
      finishedAt: nowIso(),
      coverage: [],
      counts: emptyCounts(),
      evidence: [
        evidence(run?.status === '已中断' ? 'interrupted' : 'filter-failure', reason, {
          sourceRunId: computing.sourceRunIdSnapshot,
        }),
      ],
      failureReason: reason,
      retryable: true,
    }
    updateVersion(computing.id, failed)
    commit()
    return { ok: false, message: reason, version: failed }
  }

  const currentFingerprint = snapshotFor(definition)
  const fingerprintChanged =
    computing.expressionSnapshot !== currentFingerprint.expressionSnapshot ||
    computing.boundarySnapshot !== currentFingerprint.boundarySnapshot ||
    computing.sourceRunIdSnapshot !== currentFingerprint.sourceRunIdSnapshot ||
    computing.objectTypeSnapshot !== currentFingerprint.objectTypeSnapshot ||
    computing.valueFieldSnapshot !== currentFingerprint.valueFieldSnapshot ||
    computing.valueDomainSnapshot.join('\u0000') !== currentFingerprint.valueDomainSnapshot.join('\u0000')
  if (fingerprintChanged) {
    const reason = '回算期间标签定义已被修改，本版快照作废，请按新口径重新回算'
    const stale: TagVersion = {
      ...computing,
      status: '失败',
      finishedAt: nowIso(),
      coverage: [],
      counts: emptyCounts(),
      evidence: [evidence('stale-definition', reason)],
      failureReason: reason,
      retryable: true,
      staleDefinition: true,
    }
    updateVersion(computing.id, stale)
    commit()
    return { ok: false, message: reason, version: stale }
  }

  let computed: TagVersion
  try {
    computed = computeVersion(definition, computing)
  } catch (error) {
    const reason = error instanceof Error ? error.message : '回算失败'
    const failed: TagVersion = {
      ...computing,
      status: '失败',
      finishedAt: nowIso(),
      coverage: [],
      counts: emptyCounts(),
      evidence: [evidence('parse-error', reason)],
      failureReason: reason,
      retryable: true,
    }
    updateVersion(computing.id, failed)
    commit()
    return { ok: false, message: reason, version: failed }
  }

  const previousCurrent = currentVersionOf(tagCode)
  const published: TagVersion = { ...computed, status: '已发布', finishedAt: nowIso() }
  updateVersion(computing.id, published)
  if (previousCurrent && previousCurrent.id !== computing.id) {
    updateVersion(previousCurrent.id, { status: '已替代', supersededBy: computing.version })
  }
  commit()
  return {
    ok: true,
    message: `标签 ${tagCode} 已回算并发布 v${computing.version}，覆盖 ${published.counts.covered} 个对象`,
    version: published,
    versionId: computing.id,
    versionNo: computing.version,
  }
}

/** 同步回算：启动后立即完成，失败时保留版本与重试入口。 */
export function recomputeNow(definition: TagDefinition): TagActionResult {
  const started = startRecompute(definition)
  if (!started.ok || !started.token) return started
  return completeRecompute(definition.code, started.token)
}

/** 中断回算：写清中断原因，不发布结果，不影响上一已发布版本。 */
export function interruptRecompute(tagCode: string, reason: string): TagActionResult {
  const computing = computingVersionOf(tagCode)
  if (!computing) return { ok: false, message: `标签 ${tagCode} 没有正在回算的版本` }
  const text = reason.trim() === '' ? '未填写中断原因，默认按用户手动中断处理' : reason.trim()
  updateVersion(computing.id, {
    status: '已中断',
    finishedAt: nowIso(),
    coverage: [],
    counts: emptyCounts(),
    evidence: [evidence('interrupted', `回算被中断：${text}`)],
    failureReason: text,
    interruptedReason: text,
    retryable: true,
  })
  commit()
  return { ok: true, message: `已中断版本 v${computing.version} 的回算，上一已发布版本保持不变` }
}

/** 失败 / 中断后重试：沿用当前定义，生成新版本。 */
export function retryRecompute(tagCode: string): TagActionResult {
  const definition = findDefinition(tagCode)
  if (!definition) return { ok: false, message: `标签 ${tagCode} 不存在` }
  return recomputeNow(definition)
}

/**
 * 当前覆盖范围：只读取指定版本已冻结的 coverage，不跟随最新定义。
 * 当前对象状态变化（删除 / 异常）会据此调整是否计入覆盖。
 */
export function resolveScope(
  definition: TagDefinition,
  options: { versionId?: string; preview?: boolean } = {},
): ScopeResult {
  const version = options.versionId ? findVersion(options.versionId) ?? null : currentVersionOf(definition.code)
  const inactive = definition.status !== '已启用'
  const expired = isExpired(version, definition)
  const evidenceList: Evidence[] = []
  const snapshot = version?.childVersionSnapshot ?? {}
  const children: ScopeChild[] = childrenOf(definition.code).map((child) => {
    const childVersion = currentVersionOf(child.code)
    const drifted = !!version && !!childVersion && !!snapshot[child.code] && snapshot[child.code] !== childVersion.id
    return {
      tagCode: child.code,
      name: child.name,
      versionId: childVersion?.id ?? null,
      versionNo: childVersion?.version ?? null,
      count: childVersion?.counts.covered ?? 0,
      status: child.status,
      expired: isExpired(childVersion, child),
      drifted,
      note: !childVersion
        ? '没有已发布版本'
        : child.status !== '已启用'
          ? '子标签已停用，不并入父范围'
          : isExpired(childVersion, child)
            ? '子标签结果已失效，不并入父范围'
            : drifted
              ? `子标签已回算出 v${childVersion.version}，当前父标签结果并入的仍是旧版本，需要重新回算`
              : undefined,
    }
  })

  const base = {
    tagCode: definition.code,
    tagName: definition.name,
    versionId: version?.id ?? null,
    versionNo: version?.version ?? null,
    versionStatus: version?.status ?? null,
    preview: options.preview ?? false,
    finishedAt: version?.finishedAt,
    expired,
    inactive,
    childObjectRefs: children.reduce((sum, item) => sum + item.count, 0),
    deduped: version?.counts.dedupedWithChildren ?? 0,
    children,
  }

  if (!version) {
    const attempt = latestVersionOf(definition.code)
    const attemptEvidence: Evidence[] = attempt
      ? [
          evidence(
            attempt.status === '已中断' ? 'interrupted' : attempt.status === '失败' ? 'filter-failure' : 'no-version',
            attempt.status === '已中断'
              ? `回算被中断：${attempt.interruptedReason ?? attempt.failureReason ?? '未说明原因'}`
              : attempt.status === '失败'
                ? `回算失败：${attempt.failureReason ?? '未提供原因'}（可重试）`
                : `v${attempt.version} 正在回算，完成后才有覆盖结果`,
            { sourceTagCode: definition.code, sourceRunId: attempt.sourceRunIdSnapshot },
          ),
        ]
      : []
    return {
      ...base,
      objects: [],
      ownCount: 0,
      fromChildren: 0,
      total: 0,
      excludedDeleted: 0,
      excludedAbnormal: 0,
      evidence: [
        evidence('no-version', `标签 ${definition.code} 还没有可用结果，请先回算并发布`),
        ...attemptEvidence,
        ...(inactive
          ? [evidence('inactive', `标签 ${definition.code} 当前状态为「${definition.status}」，尚未启用，没有可用的生效范围`)]
          : []),
      ],
    }
  }

  if (version.status === '计算中') {
    pushUnique(evidenceList, evidence('no-version', `标签 ${definition.code} 的 v${version.version} 正在回算，完成后才有覆盖结果`))
  } else if (version.status === '失败') {
    pushUnique(
      evidenceList,
      evidence('filter-failure', `标签结果计算失败：${version.failureReason ?? '未提供原因'}，可重试`, { sourceTagCode: definition.code }),
    )
  } else if (version.status === '已中断') {
    pushUnique(
      evidenceList,
      evidence('interrupted', `标签回算被中断：${version.interruptedReason ?? version.failureReason ?? '未说明原因'}`, { sourceTagCode: definition.code }),
    )
  }
  if (inactive) {
    pushUnique(evidenceList, evidence('inactive', `标签 ${definition.code} 当前状态为「${definition.status}」，结果不参与有效覆盖`))
  }
  if (expired) {
    pushUnique(
      evidenceList,
      evidence('expired', `标签结果已失效（最近回算 ${version.finishedAt ?? '未知'}，失效天数 ${definition.expireDays}），不能作为有效覆盖`, {
        sourceTagCode: definition.code,
      }),
    )
  }

  const objects: ScopeObject[] = []
  let excludedDeleted = 0
  let excludedAbnormal = 0
  for (const entry of version.coverage) {
    const current = findObject(stateNow(), entry.objectType, entry.objectId)
    const currentState = current?.state ?? '不存在'
    const included =
      entry.included &&
      isUsableVersion(version) &&
      !inactive &&
      !expired &&
      currentState === '正常'
    let note = entry.reason
    if (currentState === '已删除') {
      excludedDeleted += 1
      note = '对象已删除：旧结果保留来源但不再参与新覆盖统计'
      pushUnique(evidenceList, evidence('deleted-object', `对象 ${entry.objectId} 已删除，旧结果保留来源但不再参与新覆盖统计`, { objectId: entry.objectId }))
    } else if (currentState === '异常') {
      excludedAbnormal += 1
      note = '对象处于异常状态，不计入已覆盖'
      pushUnique(evidenceList, evidence('abnormal-object', `对象 ${entry.objectId} 处于异常状态，不计入已覆盖`, { objectId: entry.objectId }))
    } else if (currentState === '不存在') {
      note = '对象已不存在，不能算作已覆盖'
      pushUnique(evidenceList, evidence('missing-object', `对象 ${entry.objectId} 已不存在，不能算作已覆盖`, { objectId: entry.objectId }))
    } else if (expired) {
      note = '标签已失效，结果不参与有效覆盖'
    } else if (inactive) {
      note = '标签已停用，结果不参与有效覆盖'
    }
    objects.push({
      key: objectKeyOf(entry.objectType, entry.objectId),
      objectId: entry.objectId,
      objectType: entry.objectType,
      name: current?.name ?? entry.name,
      origin: entry.origin,
      included,
      state: currentState,
      reason: note,
      value: entry.value,
      sources: entry.sources.map((source) => ({ ...source })),
    })
  }

  for (const item of objects) {
    if (item.included) continue
    const present = evidenceList.some((item2) => item2.objectId === item.objectId)
    if (!present && item.state === '不存在') {
      pushUnique(evidenceList, evidence('missing-object', `对象 ${item.objectId} 已不存在，不能算作已覆盖`, { objectId: item.objectId }))
    }
  }

  return {
    ...base,
    objects,
    ownCount: objects.filter((item) => item.included && item.origin === '自身').length,
    fromChildren: objects.filter((item) => item.included && item.origin === '子标签').length,
    total: objects.filter((item) => item.included).length,
    excludedDeleted,
    excludedAbnormal,
    evidence: evidenceList,
  }
}

/** 层级校验：绕回、子标签超出父范围、失效、表达式错误、筛选任务不可用。 */
export function validateTag(code: string): ValidationResult {
  const errors: string[] = []
  const warnings: string[] = []
  const definition = findDefinition(code)
  if (!definition) return { ok: false, errors: [`标签 ${code} 不存在`], warnings }

  const computing = computingVersionOf(code)
  if (computing) {
    errors.push(`标签 ${code} 正在回算 v${computing.version}，完成前不能启用`)
  }
  const lastAttempt = latestVersionOf(code)
  if (lastAttempt && lastAttempt.status === '失败') {
    errors.push(`最近一次回算 v${lastAttempt.version} 失败：${lastAttempt.failureReason ?? '未提供原因'}，请先重试`)
  } else if (lastAttempt && lastAttempt.status === '已中断') {
    errors.push(`最近一次回算 v${lastAttempt.version} 被中断：${lastAttempt.interruptedReason ?? '未提供原因'}，请先重试`)
  }

  const chain: string[] = []
  let cursor: TagDefinition | undefined = definition
  while (cursor?.parentCode) {
    if (chain.includes(cursor.code) || cursor.parentCode === cursor.code) {
      errors.push(`标签层级出现绕回：${[...chain, cursor.code, cursor.parentCode].filter(Boolean).join(' → ')}`)
      break
    }
    chain.push(cursor.code)
    const parent = findDefinition(cursor.parentCode)
    if (!parent) {
      errors.push(`父标签 ${cursor.parentCode} 不存在`)
      break
    }
    if (parent.code === definition.code) {
      errors.push(`标签层级出现绕回：${chain.join(' → ')} → ${parent.code}`)
      break
    }
    cursor = parent
  }

  try {
    parseExpression(definition.expression)
  } catch (error) {
    errors.push(`计算表达式无法解析：${error instanceof Error ? error.message : '未知错误'}`)
  }
  if (definition.valueDomain.length === 0) {
    warnings.push('值域范围为空，启用后不会有任何对象得到标签结果')
  }
  if (definition.expireDays <= 0) {
    warnings.push('失效天数为 0 或负数，结果会立即失效')
  }

  const sourceRun = findFilterRun(definition.sourceRunId)
  if (!sourceRun) {
    errors.push(`输入筛选任务 ${definition.sourceRunId} 不存在`)
  } else if (sourceRun.status !== '已完成') {
    errors.push(`输入筛选任务 ${sourceRun.runId} 状态为「${sourceRun.status}」，无法启用`)
  }

  const latest = currentVersionOf(code)
  if (latest) {
    const scope = resolveScope(definition, { versionId: latest.id })
    for (const item of scope.evidence) {
      if (item.kind === 'cycle') errors.push(item.message)
    }
  } else {
    errors.push(`标签 ${code} 还没有可用的回算结果，请先回算并发布`)
  }

  const parent = definition.parentCode ? findDefinition(definition.parentCode) : undefined
  if (parent) {
    if (latest) {
      const outside = latest.coverage
        .filter((entry) => entry.included && !satisfyBoundary(parent, entry))
        .slice(0, 5)
      for (const entry of outside) {
        errors.push(
          `子标签范围超出父标签 ${parent.code}：对象 ${entry.objectId} 不满足范围边界「${boundaryOf(parent)}」`,
        )
      }
    }
  }

  for (const child of childrenOf(code)) {
    const childVersion = currentVersionOf(child.code)
    if (!childVersion) {
      warnings.push(`子标签 ${child.code} 尚无已发布结果，暂未校验范围包含关系`)
      continue
    }
    if (latest?.counts.childObjectRefs === 0) {
      warnings.push(`子标签 ${child.code} 的对象没有并入当前版本，无法校验范围包含关系`)
      continue
    }
    const outside = childVersion.coverage
      .filter((entry) => entry.included && !satisfyBoundary(definition, entry))
      .slice(0, 5)
    for (const entry of outside) {
      errors.push(
        `子标签 ${child.code} 的对象 ${entry.objectId} 超出父标签 ${code} 的范围边界「${boundaryOf(definition)}」`,
      )
    }
  }

  return { ok: errors.length === 0, errors, warnings }
}

export function saveDefinition(
  input: Partial<TagDefinition> & Pick<TagDefinition, 'code' | 'name'>,
): TagActionResult {
  const s = stateNow()
  const existing = findDefinition(input.code)
  if (existing) {
    const computing = computingVersionOf(existing.code)
    if (computing) {
      return {
        ok: false,
        message: `标签 ${existing.code} 的版本 v${computing.version} 正在回算，冻结快照不能被后续编辑替换；请等待完成或先中断`,
        version: computing,
      }
    }
  }
  const valueDomain = (input.valueDomain ?? existing?.valueDomain ?? [])
    .map((item) => item.trim())
    .filter((item) => item !== '')
  const parentCode =
    input.parentCode === undefined ? existing?.parentCode ?? null : input.parentCode === '' ? null : input.parentCode
  const definition: TagDefinition = {
    id: existing?.id ?? s.definitions.reduce((max, item) => Math.max(max, item.id), 0) + 1,
    code: input.code,
    name: input.name,
    expression: input.expression ?? existing?.expression ?? '',
    boundaryExpression: input.boundaryExpression ?? existing?.boundaryExpression ?? '',
    sourceRunId: input.sourceRunId ?? existing?.sourceRunId ?? '',
    objectType: input.objectType ?? existing?.objectType ?? '客户',
    valueField: input.valueField ?? existing?.valueField ?? 'city',
    valueDomain,
    level: input.level ?? existing?.level ?? 0,
    parentCode,
    refresh: input.refresh ?? existing?.refresh ?? '每日',
    expireDays: input.expireDays ?? existing?.expireDays ?? 30,
    status: input.status ?? existing?.status ?? '草稿',
    revision: (existing?.revision ?? 0) + 1,
    createdAt: existing?.createdAt ?? nowIso(),
    updatedAt: nowIso(),
  }
  if (existing) {
    // 原地更新，保证持有该定义的调用方看到最新快照
    Object.assign(existing, definition)
  } else {
    s.definitions.push(definition)
  }
  commit()
  const childCount = childrenOf(definition.code).length
  const current = currentVersionOf(definition.code)
  return {
    ok: true,
    message: existing
      ? `标签 ${definition.code} 已更新（新口径需重新回算生效）${
          childCount > 0
            ? `；修改父标签不会自动改写 ${childCount} 个已发布子标签的成员${current ? `（当前 v${current.version} 保持原样）` : ''}`
            : ''
        }`
      : `标签 ${definition.code} 已登记`,
    versionId: current?.id,
  }
}

/** 启用前跑校验；绕回 / 子标签超出父范围 / 无结果都会被拒绝。 */
export function enableTag(code: string): TagActionResult {
  const definition = findDefinition(code)
  if (!definition) return { ok: false, message: `标签 ${code} 不存在` }
  const validation = validateTag(code)
  if (!validation.ok) {
    return { ok: false, message: `拒绝启用：${validation.errors[0]}`, validation }
  }
  const current = currentVersionOf(code)
  if (!current) {
    return { ok: false, message: `标签 ${code} 还没有可用的回算结果，请先回算`, validation }
  }
  definition.status = '已启用'
  definition.revision += 1
  definition.updatedAt = nowIso()
  commit()
  return { ok: true, message: `标签 ${code} 已启用，当前版本 v${current.version} 覆盖 ${current.counts.covered} 个对象`, validation, version: current }
}

export function disableTag(code: string): TagActionResult {
  const definition = findDefinition(code)
  if (!definition) return { ok: false, message: `标签 ${code} 不存在` }
  if (definition.status === '已停用') return { ok: false, message: `标签 ${code} 已经停用` }
  definition.status = '已停用'
  definition.revision += 1
  definition.updatedAt = nowIso()
  commit()
  return { ok: true, message: `标签 ${code} 已停用，已发布版本保留但不再参与父标签覆盖` }
}

export function markPendingValidation(code: string): TagActionResult {
  const definition = findDefinition(code)
  if (!definition) return { ok: false, message: `标签 ${code} 不存在` }
  definition.status = '待校验'
  definition.revision += 1
  definition.updatedAt = nowIso()
  commit()
  return { ok: true, message: `标签 ${code} 已提交校验` }
}

/**
 * 调整层级归属。只改定义上的 parentCode，不触碰子标签已发布版本成员。
 */
export function reparentTag(code: string, parentCode: string | null, confirmMismatch = false): TagActionResult {
  const definition = findDefinition(code)
  if (!definition) return { ok: false, message: `标签 ${code} 不存在` }
  if (parentCode === code) return { ok: false, message: '标签不能以自己为父标签' }
  if (parentCode && !findDefinition(parentCode)) {
    return { ok: false, message: `父标签 ${parentCode} 不存在` }
  }
  if (computingVersionOf(code)) {
    return { ok: false, message: `标签 ${code} 正在回算，暂不能调整层级` }
  }
  if (parentCode) {
    const seen = new Set<string>([code])
    let cursor: TagDefinition | undefined = findDefinition(parentCode)
    while (cursor) {
      if (seen.has(cursor.code)) {
        return { ok: false, message: `调整后标签层级会出现绕回：${[...seen].join(' → ')} → ${cursor.code}` }
      }
      seen.add(cursor.code)
      if (!cursor.parentCode) break
      cursor = findDefinition(cursor.parentCode)
    }
  }
  const previousParent = definition.parentCode
  const currentBefore = currentVersionOf(code)
  if (parentCode && currentBefore) {
    const parent = findDefinition(parentCode)!
    const outside = currentBefore.coverage.filter((entry) => entry.included && !satisfyBoundary(parent, entry))
    if (outside.length > 0 && !confirmMismatch) {
      return {
        ok: false,
        confirmNeeded: true,
        message: `已发布版本 v${currentBefore.version} 有 ${outside.length} 个对象不满足父标签 ${parent.code} 的范围边界「${boundaryOf(parent)}」；已发布子标签的成员不会被自动改写，确认后将拒绝该标签在父范围中启用，需按新口径回算`,
        validation: {
          ok: false,
          errors: outside.map(
            (entry) => `对象 ${entry.objectId} 不满足父标签 ${parent.code} 的范围边界「${boundaryOf(parent)}」`,
          ),
          warnings: ['挂载成功后父标签在该子标签启用时会被拒绝，请先回算子标签'],
        },
        version: currentBefore,
      }
    }
  }
  definition.parentCode = parentCode
  definition.revision += 1
  definition.updatedAt = nowIso()
  commit()
  const current = currentVersionOf(code)
  return {
    ok: true,
    message: `标签 ${code} 的父标签已从「${previousParent ?? '无'}」调整为「${parentCode ?? '无'}」；${
      current ? `已发布版本 v${current.version} 的成员保持不变` : '尚未发布结果'
    }`,
  }
}

/** 报告冻结引用：生成时锁定 versionId 与对象来源快照。 */
export function createReport(input: { name: string; tagCode: string; versionId: string }): TagActionResult {
  const definition = findDefinition(input.tagCode)
  const version = findVersion(input.versionId)
  if (!definition) return { ok: false, message: `标签 ${input.tagCode} 不存在` }
  if (!version) return { ok: false, message: `版本 ${input.versionId} 不存在` }
  if (!isUsableVersion(version)) {
    return { ok: false, message: `版本 v${version.version} 状态为「${version.status}」，只有已发布结果可以被报告引用` }
  }
  const report: TagReport = {
    id: `RPT-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
    name: input.name.trim() || `${definition.name} 覆盖报告`,
    tagCode: definition.code,
    tagName: definition.name,
    versionId: version.id,
    versionNo: version.version,
    createdAt: nowIso(),
    frozenCounts: { ...version.counts },
    frozenObjects: version.coverage
      .filter((item) => item.included)
      .map((item) => ({
        objectId: item.objectId,
        objectType: item.objectType,
        name: item.name,
        sourceRunId: item.sources[0]?.runId,
        sourceRowId: item.sources[0]?.rowId,
        sourceRuleCode: item.sources[0]?.ruleCode,
      })),
  }
  stateNow().reports.push(report)
  commit()
  return { ok: true, message: `报告已创建并冻结引用 v${version.version}（${report.frozenObjects.length} 个对象）`, versionId: version.id }
}

export function readReport(reportId: string): ReportRead | null {
  const report = findReport(reportId)
  if (!report) return null
  const version = findVersion(report.versionId) ?? null
  const definition = findDefinition(report.tagCode)
  const expired = definition ? isExpired(version, definition) : false
  const superseded = version?.status === '已替代'
  const objects = report.frozenObjects.map((object) => {
    const current = findObject(stateNow(), object.objectType, object.objectId)
    const currentState: DatasetObject['state'] | '不存在' = current?.state ?? '不存在'
    let note = '与冻结结果一致'
    if (currentState === '已删除') note = '对象已删除：报告保留冻结来源，但不再参与新覆盖统计'
    else if (currentState === '异常') note = '对象当前为异常状态，冻结结果不据此改写'
    else if (currentState === '不存在') note = '对象已不存在，不能伪装成已覆盖'
    return {
      objectId: object.objectId,
      objectType: object.objectType,
      name: current?.name ?? object.name,
      sourceRunId: object.sourceRunId,
      sourceRowId: object.sourceRowId,
      sourceRuleCode: object.sourceRuleCode,
      currentState,
      note,
    }
  })
  return {
    report,
    version,
    expired,
    superseded,
    objects,
    note: superseded
      ? `该报告引用 v${report.versionNo}，标签已按新口径回算；报告仍读取旧版本冻结结果`
      : expired
        ? '引用的标签版本已失效：报告保留冻结结果并标注失效'
        : '报告读取冻结的版本结果',
  }
}

export function deleteReport(reportId: string): TagActionResult {
  const s = stateNow()
  const index = s.reports.findIndex((item) => item.id === reportId)
  if (index < 0) return { ok: false, message: `报告 ${reportId} 不存在` }
  s.reports.splice(index, 1)
  commit()
  return { ok: true, message: '报告已删除' }
}

export function listTagRows(): TagListRow[] {
  const s = stateNow()
  return s.definitions.map((definition) => {
    const current = currentVersionOf(definition.code)
    const computing = computingVersionOf(definition.code)
    const run = findFilterRun(definition.sourceRunId)
    const effective = resolveScope(definition, { versionId: current?.id }).total
    return {
      code: definition.code,
      name: definition.name,
      level: definition.level,
      parentCode: definition.parentCode,
      status: definition.status,
      expression: definition.expression,
      boundaryExpression: definition.boundaryExpression,
      valueDomain: definition.valueDomain,
      expireDays: definition.expireDays,
      sourceRunId: definition.sourceRunId,
      sourceRuleCode: run?.ruleCode ?? '—',
      versionNo: current?.version ?? null,
      versionStatus: computing ? '计算中' : current?.status ?? latestVersionOf(definition.code)?.status ?? null,
      computingVersionId: computing?.id ?? null,
      versionCovered: current?.counts.covered ?? 0,
      coverageCount: effective,
      reportCount: s.reports.filter((report) => report.tagCode === definition.code).length,
      expired: isExpired(current, definition),
    }
  })
}

export function loadTagDetail(code: string): TagDetail | null {
  const definition = findDefinition(code)
  if (!definition) return null
  const versions = versionsOf(code).slice().reverse()
  const latest = latestVersionOf(code)
  const current = currentVersionOf(code)
  const computing = computingVersionOf(code)
  return {
    definition,
    versions,
    latestVersion: latest,
    currentVersion: current,
    computingVersion: computing,
    // 没有已发布结果时不拿失败 / 中断版本冒充覆盖范围
    scope: resolveScope(definition, { versionId: current?.id, preview: !current }),
    reports: stateNow()
      .reports.filter((report) => report.tagCode === code)
      .slice()
      .reverse(),
    validation: validateTag(code),
    sourceRun: findFilterRun(definition.sourceRunId) ?? null,
  }
}

export function tagStats(): TagStats {
  const rows = listTagRows()
  const evidenceCount = stateNow().versions.reduce(
    (sum, version) => sum + version.evidence.filter((item) => item.kind !== 'duplicate-hit').length,
    0,
  )
  return {
    total: rows.length,
    enabled: rows.filter((row) => row.status === '已启用').length,
    pending: rows.filter((row) => row.status === '待校验').length,
    evidence: evidenceCount,
    activeCoverage: rows.reduce((sum, row) => sum + row.coverageCount, 0),
  }
}

export function listReports(): TagReport[] {
  return stateNow().reports.slice().reverse()
}

export function resetTagState(): void {
  state = createSeedState()
  versionSequence = 0
  bootstrapVersions()
  bootstrapped = true
  commit()
}

/** 示例数据的初始版本与报告：演示旧报告读旧版本、删除对象、生效范围。 */
function bootstrapVersions(): void {
  const s = stateNow()
  const find = (code: string) => s.definitions.find((item) => item.code === code)

  // 先算子标签再算父标签，父标签的初始版本才能并入子范围。
  // 失败 / 中断的筛选任务会留下失败版本与重试入口。
  const ordered = s.definitions.slice().sort((a, b) => b.level - a.level)
  for (const definition of ordered) {
    recomputeNow(definition)
  }

  const parent = find('TAG-0001')
  if (parent) {
    const parentV1 = currentVersionOf(parent.code)
    if (parentV1) {
      createReport({ name: '2026-10 华东活跃客户覆盖报告', tagCode: parent.code, versionId: parentV1.id })
    }
  }
  // 父标签初始版本的合并快照走一遍已发布子标签；随后子标签再回算，演示父标签「需重新回算」
  const shanghai = find('TAG-0002')
  if (shanghai) {
    const v1 = currentVersionOf(shanghai.code)
    if (v1) {
      createReport({ name: '上海活跃客户周报（v1 口径）', tagCode: shanghai.code, versionId: v1.id })
    }
  }

  // 对象被删除：旧报告保留来源，新回算不再计数
  const deleted = s.objects.find((item) => item.objectId === 'C-1006')
  if (deleted) {
    deleted.state = '已删除'
    deleted.stateNote = '客户注销，对象已删除'
  }

  // 表达式按新口径收紧并回算：v1 报告仍然引用旧版本结果
  if (shanghai) {
    saveDefinition({
      code: shanghai.code,
      name: shanghai.name,
      expression: 'totalAmount >= 100000 并且 level == A 并且 city == 上海',
    })
    recomputeNow(shanghai)
  }
  // 父标签保持初始 v1：子标签回算后父标签会出现「需重新回算」提示

  // 限时标签：回算完成时间往前挪 5 天，演示失效证据
  const limited = find('TAG-0008')
  if (limited) {
    const version = currentVersionOf(limited.code)
    if (version) {
      version.finishedAt = new Date(now() - 5 * DAY_MS).toISOString()
    }
  }
}

