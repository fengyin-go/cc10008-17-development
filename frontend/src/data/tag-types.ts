/**
 * 数据标签领域的类型定义。
 *
 * 标签从「数据筛选任务产出的命中行」出发，按计算表达式得到对象集合；
 * 每次回算都会冻结一份版本（表达式快照 + 覆盖范围 + 证据），
 * 报告引用版本 id，因此表达式调整后旧报告仍然读取旧结果。
 */

export type ObjectType = '客户' | '订单'
export type ObjectState = '正常' | '已删除' | '异常'
export type TagStatus = '草稿' | '待校验' | '已启用' | '已停用'
export type VersionStatus = '计算中' | '已发布' | '已替代' | '失败' | '已中断'

export type ObjectAttributes = Record<string, string | number | boolean>

export type DatasetObject = {
  objectId: string
  objectType: ObjectType
  name: string
  attributes: ObjectAttributes
  state: ObjectState
  stateNote?: string
}

export type FilterHitRow = {
  rowId: string
  objectId: string
  objectType: ObjectType
  attributes: ObjectAttributes
}

export type FilterRun = {
  runId: string
  ruleCode: string
  dataset: string
  status: '已完成' | '执行中' | '失败' | '已中断'
  finishedAt: string
  hitRows: FilterHitRow[]
  failureReason?: string
}

export type TagDefinition = {
  id: number
  code: string
  name: string
  expression: string
  /** 父标签范围边界：子标签成员必须满足它；为空时退回父标签自身表达式 */
  boundaryExpression: string
  sourceRunId: string
  objectType: ObjectType
  valueField: string
  valueDomain: string[]
  level: number
  parentCode: string | null
  refresh: string
  expireDays: number
  status: TagStatus
  revision: number
  createdAt: string
  updatedAt: string
}

export type EvidenceKind =
  | 'empty-domain'
  | 'duplicate-hit'
  | 'expired'
  | 'deleted-object'
  | 'abnormal-object'
  | 'missing-object'
  | 'out-of-domain'
  | 'filter-miss'
  | 'no-hit-rows'
  | 'outside-parent'
  | 'cycle'
  | 'parse-error'
  | 'filter-failure'
  | 'interrupted'
  | 'stale-definition'
  | 'no-child-version'
  | 'inactive'
  | 'no-version'

export type Evidence = {
  kind: EvidenceKind
  label: string
  message: string
  objectId?: string
  sourceTagCode?: string
  sourceRunId?: string
  sourceRowId?: string
  count?: number
}

export type CoverageSource = {
  tagCode: string
  versionId: string
  runId?: string
  rowId?: string
  ruleCode?: string
  /** 来源标签的覆盖链路，父标签并入子标签时保留 */
  fromChildTagCode?: string
}

export type CoverageEntry = {
  objectId: string
  objectType: ObjectType
  name: string
  /** 自身命中 / 仅从子标签并入 */
  origin: '自身' | '子标签'
  sources: CoverageSource[]
  hitCount: number
  included: boolean
  stateAtCompute: ObjectState | '不存在'
  reason?: string
  value?: string
  evidence: EvidenceKind[]
}

export type CoverageCounts = {
  hitRows: number
  uniqueObjects: number
  covered: number
  selfCovered: number
  childObjectRefs: number
  fromChildren: number
  dedupedWithChildren: number
  duplicates: number
  deleted: number
  abnormal: number
  outOfDomain: number
  emptyDomain: number
  missedExpression: number
  missingObject: number
}

export type TagVersion = {
  id: string
  tagCode: string
  version: number
  status: VersionStatus
  /** 启动回算时的表达式 / 值域 / 数据源快照，后续编辑不能替换它 */
  expressionSnapshot: string
  valueDomainSnapshot: string[]
  sourceRunIdSnapshot: string
  boundarySnapshot: string
  objectTypeSnapshot: ObjectType
  valueFieldSnapshot: string
  definitionRevision: number
  token: string
  startedAt: string
  finishedAt?: string
  coverage: CoverageEntry[]
  evidence: Evidence[]
  counts: CoverageCounts
  /** 回算时并入的子标签版本，用于提示父标签结果是否已落后 */
  childVersionSnapshot: Record<string, string>
  failureReason?: string
  retryable?: boolean
  interruptedReason?: string
  supersededBy?: number
  staleDefinition?: boolean
}

export type FrozenReportObject = {
  objectId: string
  objectType: ObjectType
  name: string
  sourceRunId?: string
  sourceRowId?: string
  sourceRuleCode?: string
}

export type TagReport = {
  id: string
  name: string
  tagCode: string
  tagName: string
  versionId: string
  versionNo: number
  createdAt: string
  frozenCounts: CoverageCounts
  frozenObjects: FrozenReportObject[]
}

export type TagState = {
  schemaVersion: number
  definitions: TagDefinition[]
  objects: DatasetObject[]
  filterRuns: FilterRun[]
  versions: TagVersion[]
  reports: TagReport[]
}

export type ValidationResult = {
  ok: boolean
  errors: string[]
  warnings: string[]
}

export type ScopeSource = {
  tagCode: string
  versionId: string
  runId?: string
  rowId?: string
  ruleCode?: string
  fromChildTagCode?: string
}

export type ScopeObject = {
  key: string
  objectId: string
  objectType: ObjectType
  name: string
  origin: '自身' | '子标签'
  included: boolean
  state: ObjectState | '不存在'
  reason?: string
  value?: string
  sources: ScopeSource[]
}

export type ScopeChild = {
  tagCode: string
  name: string
  versionId: string | null
  versionNo: number | null
  count: number
  status: TagStatus
  expired: boolean
  /** 子标签当前版本与父标签回算时并入的版本不一致 */
  drifted: boolean
  note?: string
}

export type ScopeResult = {
  tagCode: string
  tagName: string
  versionId: string | null
  versionNo: number | null
  versionStatus: VersionStatus | null
  preview: boolean
  finishedAt?: string
  expired: boolean
  inactive: boolean
  objects: ScopeObject[]
  ownCount: number
  childObjectRefs: number
  fromChildren: number
  deduped: number
  total: number
  excludedDeleted: number
  excludedAbnormal: number
  evidence: Evidence[]
  children: ScopeChild[]
}

export type TagListRow = {
  code: string
  name: string
  level: number
  parentCode: string | null
  status: TagStatus
  expression: string
  boundaryExpression: string
  valueDomain: string[]
  expireDays: number
  sourceRunId: string
  sourceRuleCode: string
  versionNo: number | null
  versionStatus: VersionStatus | null
  computingVersionId: string | null
  /** 版本内计算出的覆盖数（不随当前启用/失效状态变化） */
  versionCovered: number
  /** 当前生效的覆盖数 */
  coverageCount: number
  reportCount: number
  expired: boolean
}

export type TagDetail = {
  definition: TagDefinition
  versions: TagVersion[]
  latestVersion: TagVersion | null
  currentVersion: TagVersion | null
  computingVersion: TagVersion | null
  scope: ScopeResult
  reports: TagReport[]
  validation: ValidationResult
  sourceRun: FilterRun | null
}

export type ReportRead = {
  report: TagReport
  version: TagVersion | null
  expired: boolean
  superseded: boolean
  objects: {
    objectId: string
    objectType: ObjectType
    name: string
    sourceRunId?: string
    sourceRowId?: string
    sourceRuleCode?: string
    currentState: ObjectState | '不存在'
    note: string
  }[]
  note: string
}

export type TagStats = {
  total: number
  enabled: number
  pending: number
  evidence: number
  activeCoverage: number
}

export type TagActionResult = {
  ok: boolean
  message: string
  /** 需要用户确认后才会执行（例如改层级会导致子标签与父范围不一致） */
  confirmNeeded?: boolean
  validation?: ValidationResult
  version?: TagVersion
  versionId?: string
  token?: string
  versionNo?: number
}

export const OBJECT_FIELDS: Record<ObjectType, string[]> = {
  客户: ['city', 'level', 'totalAmount'],
  订单: ['amount', 'channel', 'customerId', 'refunded'],
}

export const FIELD_LABELS: Record<string, string> = {
  city: '城市',
  level: '客户等级',
  totalAmount: '累计消费',
  amount: '订单金额',
  channel: '渠道',
  customerId: '关联客户',
  refunded: '是否退款',
}

export const EVIDENCE_LABELS: Record<EvidenceKind, string> = {
  'empty-domain': '值域为空',
  'duplicate-hit': '对象重复命中',
  expired: '标签已失效',
  'deleted-object': '覆盖对象已删除',
  'abnormal-object': '异常对象',
  'missing-object': '覆盖对象不存在',
  'out-of-domain': '超出值域范围',
  'filter-miss': '未命中计算表达式',
  'no-hit-rows': '无命中行',
  'outside-parent': '超出父标签范围',
  cycle: '标签层级绕回',
  'parse-error': '计算表达式错误',
  'filter-failure': '筛选任务未产出命中行',
  interrupted: '回算已中断',
  'stale-definition': '回算期间定义已变更',
  'no-child-version': '子标签无有效版本',
  inactive: '标签已停用',
  'no-version': '标签无有效版本',
}

export function emptyCounts(): CoverageCounts {
  return {
    hitRows: 0,
    uniqueObjects: 0,
    covered: 0,
    selfCovered: 0,
    childObjectRefs: 0,
    fromChildren: 0,
    dedupedWithChildren: 0,
    duplicates: 0,
    deleted: 0,
    abnormal: 0,
    outOfDomain: 0,
    emptyDomain: 0,
    missedExpression: 0,
    missingObject: 0,
  }
}
