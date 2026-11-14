import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import * as tagApi from '@/api/tag-service'
import type { Evidence, ReportRead, ScopeObject, TagDetail, TagListRow, TagVersion } from '@/api/tag-service'

const PARENT_NONE = '（不挂父标签）'

function statusClass(status: string): string {
  if (status === '已启用') return 'chip chip-on'
  if (status === '已停用') return 'chip chip-off'
  if (status === '已发布') return 'chip chip-on'
  if (status === '已替代') return 'chip chip-muted'
  if (status === '计算中') return 'chip chip-busy'
  if (status === '失败' || status === '已中断') return 'chip chip-bad'
  return 'chip chip-idle'
}

function evidenceClass(kind: Evidence['kind']): string {
  if (kind === 'duplicate-hit') return 'ev ev-info'
  if (kind === 'deleted-object' || kind === 'missing-object') return 'ev ev-muted'
  if (kind === 'abnormal-object' || kind === 'expired' || kind === 'outside-parent' || kind === 'cycle') return 'ev ev-bad'
  return 'ev'
}

function scopeStateLabel(object: ScopeObject): string {
  if (object.state === '已删除') return '对象已删除'
  if (object.state === '异常') return '异常对象'
  if (object.state === '不存在') return '对象不存在'
  return '正常'
}

/** 同一对象还被哪些子标签覆盖（只作来源说明，不重复计数） */
function childTagsOf(object: ScopeObject): string[] {
  return [
    ...new Set(
      object.sources
        .map((source) => source.fromChildTagCode)
        .filter((code): code is string => !!code),
    ),
  ]
}

function versionLabel(version: TagVersion): string {
  const finished = version.finishedAt ? new Date(version.finishedAt).toLocaleString('zh-CN') : '未完成'
  return `v${version.version} · ${version.status} · ${finished}`
}

export default function TagView() {
  ensureTagStateOnce()
  const initial = useMemo(() => readWorkspace('TAG-0001'), [])
  // 初始选中优先落在第一个标签上，避免示例编号被改动后页面空白

  const [rows, setRows] = useState<TagListRow[]>(initial.rows)
  const [stats, setStats] = useState<tagApi.TagStats>(initial.stats)
  const [reports, setReports] = useState<ReportRead[]>(initial.reports)
  const [selected, setSelected] = useState<string>(initial.detail?.definition.code ?? 'TAG-0001')
  const selectedRef = useRef(selected)
  const activeTokenRef = useRef('')
  const [detail, setDetail] = useState<TagDetail | null>(initial.detail)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [keyword, setKeyword] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [activeTab, setActiveTab] = useState<'scope' | 'evidence' | 'versions' | 'reports' | 'edit'>('scope')
  const [scopeOnlyUncovered, setScopeOnlyUncovered] = useState(false)
  const [selectedVersionId, setSelectedVersionId] = useState('')
  const [previewVersion, setPreviewVersion] = useState<TagVersion | null>(null)

  const [confirmReparent, setConfirmReparent] = useState<{ parentCode: string | null; message: string } | null>(null)

  const refresh = useCallback((code = selectedRef.current, resetVersion = false) => {
    const workspace = readWorkspace(code)
    setRows(workspace.rows)
    setStats(workspace.stats)
    setReports(workspace.reports)
    setDetail(workspace.detail)
    if (workspace.error) {
      setError(workspace.error)
    }
    if (resetVersion) {
      setSelectedVersionId(workspace.detail?.currentVersion?.id ?? workspace.detail?.latestVersion?.id ?? '')
    }
  }, [])

  useEffect(() => {
    selectedRef.current = selected
    refresh(selected, true)
    setPreviewVersion(null)
  }, [refresh, selected])

  function applyResult(result: tagApi.TagActionResult) {
    setError('')
    setMessage(result.message)
    if (!result.ok) {
      setError(result.message)
    }
    setPreviewVersion(null)
    refresh()
  }

  async function runCompute(code: string) {
    // 先启动版本，冻结当前表达式 / 值域 / 数据源快照
    const started = tagApi.beginCompute(code)
    if (!started.ok || !started.token) {
      setMessage('')
      setError(started.message)
      refresh()
      return
    }
    activeTokenRef.current = started.token
    setMessage(`已锁定表达式与数据源快照（版本 v${started.versionNo}），回算中…`)
    refresh()
    // 让出主线程，期间对定义的编辑会被冻结快照挡下，也可以点「中断回算」
    await new Promise((resolve) => setTimeout(resolve, 700))
    if (activeTokenRef.current !== started.token) {
      // 本次回算已被中断（中断原因已记录在版本里）
      return
    }
    activeTokenRef.current = ''
    applyResult(tagApi.finishCompute(code, started.token))
  }

  function runInterrupt(code: string) {
    const reason = window.prompt('请填写中断回算的原因（会记录在版本证据里）', '调度窗口关闭，暂停本次回算')
    if (reason === null) return
    activeTokenRef.current = ''
    applyResult(tagApi.abortCompute(code, reason))
  }

  function runRetry(code: string) {
    applyResult(tagApi.retryTag(code))
  }

  function runEnable(code: string) {
    const result = tagApi.enable(code)
    if (result.ok) {
      applyResult(result)
      return
    }
    // 校验拒绝时把完整原因留在通知区，避免只看到第一条
    setMessage('')
    setError(`${result.message}${result.validation && result.validation.errors.length > 1 ? `（共 ${result.validation.errors.length} 项）` : ''}`)
    refresh()
  }

  function runDisable(code: string) {
    applyResult(tagApi.disable(code))
  }

  function runSubmit(code: string) {
    applyResult(tagApi.submitValidation(code))
  }

  function runCheck(code: string) {
    const result = tagApi.checkTag(code)
    setMessage(result.message)
    setError(result.ok ? '' : result.message)
    refresh()
  }

  function runExport(code: string) {
    const file = tagApi.exportScopeCsv(code)
    tagApi.download(file)
    setMessage(`已导出「${file.filename}」，含来源筛选任务与命中行`)
  }

  function runFreezeReport(code: string, versionId: string) {
    const name = window.prompt('报告名称', `${code} 覆盖报告`)
    if (name === null) return
    applyResult(tagApi.freezeReport(name, code, versionId))
  }

  function runReparent(code: string, parentCode: string | null) {
    const result = tagApi.changeParent(code, parentCode)
    if (result.confirmNeeded) {
      // 已发布成员不会被改写：先让用户确认影响，再决定是否调整层级
      setConfirmReparent({ parentCode, message: result.message })
      return
    }
    applyResult(result)
  }

  function confirmReparentNow() {
    if (!confirmReparent) return
    const pending = confirmReparent
    setConfirmReparent(null)
    applyResult(tagApi.changeParent(selected, pending.parentCode, true))
  }

  const visibleRows = useMemo(() => {
    return rows.filter((row) => {
      if (statusFilter && row.status !== statusFilter) return false
      if (keyword.trim() === '') return true
      const text = `${row.code} ${row.name} ${row.expression} ${row.parentCode ?? ''}`
      return text.includes(keyword.trim())
    })
  }, [rows, keyword, statusFilter])

  const parentOptions = useMemo(() => {
    return rows
      .filter((row) => row.code !== selected)
      .map((row) => ({ code: row.code, name: row.name, level: row.level }))
  }, [rows, selected])

  const previewScope = useMemo(() => {
    if (!detail || !previewVersion || previewVersion.id === detail.scope.versionId) return null
    return tagApi.scopeOfVersion(detail.definition.code, previewVersion.id)
  }, [detail, previewVersion])

  const shownScope = previewScope ?? detail?.scope ?? null
  const shownObjects = useMemo(() => {
    if (!shownScope) return []
    if (!scopeOnlyUncovered) return shownScope.objects
    return shownScope.objects.filter((object) => !object.included)
  }, [shownScope, scopeOnlyUncovered])

  if (!detail) {
    return (
      <section className="page" data-module="tag">
        <header className="page-head">
          <div>
            <h2>数据标签管理</h2>
            <p className="page-desc">标签覆盖范围、版本与证据。</p>
          </div>
        </header>
        <p className="empty-state">{error || '标签数据加载中…'}</p>
      </section>
    )
  }

  const validation = detail.validation
  const computing = detail.computingVersion
  const scope = detail.scope
  const latest = detail.latestVersion
  const latestTrouble =
    latest && !['已发布', '已替代'].includes(latest.status)
      ? latest
      : latest?.staleDefinition
        ? latest
        : null

  return (
    <section className="page" data-module="tag">
      <header className="page-head">
        <div>
          <h2>数据标签管理</h2>
          <p className="page-desc">
            以数据筛选任务产出的命中行为输入，逐版本计算覆盖范围；父标签范围包含子标签且按对象去重，报告按版本冻结读取。
          </p>
        </div>
        <div className="page-actions">
          <button className="btn" type="button" onClick={() => refresh()}>重新读取</button>
          <button className="btn" type="button" onClick={() => runExport(selected)}>导出覆盖范围清单</button>
          <button
            className="btn ghost"
            type="button"
            onClick={() => {
              if (!window.confirm('恢复示例数据会清掉本地已有的标签版本与报告，确认继续？')) return
              tagApi.resetWorkspace()
              setSelected('TAG-0001')
              setPreviewVersion(null)
              setMessage('已恢复示例标签数据')
              setError('')
              refresh('TAG-0001', true)
            }}
          >
            恢复示例数据
          </button>
        </div>
      </header>

      <div className="stat-row">
        <article className="stat-card"><span className="stat-label">标签定义总数</span><strong className="stat-value">{stats.total}</strong></article>
        <article className="stat-card"><span className="stat-label">已启用标签</span><strong className="stat-value">{stats.enabled}</strong></article>
        <article className="stat-card"><span className="stat-label">待校验标签</span><strong className="stat-value">{stats.pending}</strong></article>
        <article className="stat-card"><span className="stat-label">当前覆盖对象</span><strong className="stat-value">{stats.activeCoverage}</strong></article>
        <article className="stat-card"><span className="stat-label">未命中证据</span><strong className="stat-value">{stats.evidence}</strong></article>
      </div>

      {(message || error) && (
        <div className={error ? 'notice notice-bad' : 'notice notice-ok'}>
          {error || message}
        </div>
      )}

      {latestTrouble && !computing && (
        <div className={latestTrouble.status === '失败' ? 'notice notice-bad' : 'notice'}>
          最近一次回算 v{latestTrouble.version} 为「{latestTrouble.status}」：
          {latestTrouble.interruptedReason ?? latestTrouble.failureReason ?? '未提供原因'}
          {latestTrouble.retryable ? '（可重试，重试会生成新版本）' : ''}
          {latestTrouble.retryable && (
            <button className="link" type="button" onClick={() => runRetry(selected)}>重试回算</button>
          )}
        </div>
      )}

      <div className="tag-layout">
        <div className="tag-list-pane">
          <div className="filter-bar">
            <label className="filter-item">
              <span>标签检索</span>
              <input value={keyword} placeholder="按编号 / 名称 / 表达式检索" onChange={(event) => setKeyword(event.target.value)} />
            </label>
            <label className="filter-item">
              <span>状态</span>
              <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
                <option value="">全部状态</option>
                {['草稿', '待校验', '已启用', '已停用'].map((status) => (
                  <option key={status} value={status}>{status}</option>
                ))}
              </select>
            </label>
          </div>
          <table className="data-table tag-table">
            <thead>
              <tr>
                <th>标签</th>
                <th>层级 / 父标签</th>
                <th>结果版本</th>
                <th>覆盖对象</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => (
                <tr
                  key={row.code}
                  className={row.code === selected ? 'tag-row tag-row-active' : 'tag-row'}
                  onClick={() => {
                    setSelected(row.code)
                  }}
                >
                  <td>
                    <strong>{row.name}</strong>
                    <div className="tag-sub">{row.code} · {row.expression}</div>
                  </td>
                  <td>{row.level} 级{row.parentCode ? ` → ${row.parentCode}` : '（无父标签）'}</td>
                  <td>
                    {row.versionNo === null ? '—' : `v${row.versionNo}`}
                    <div className="tag-sub">
                      {row.versionStatus ?? '无结果'}
                      {row.expired ? ' · 已失效' : ''}
                    </div>
                  </td>
                  <td>
                    {row.coverageCount}
                    <div className="tag-sub">版本内 {row.versionCovered}</div>
                  </td>
                  <td><span className={statusClass(row.status)}>{row.status}</span></td>
                </tr>
              ))}
              {visibleRows.length === 0 && (
                <tr>
                  <td className="empty-state" colSpan={5}>没有符合条件的标签，调整检索条件或重置</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="tag-detail-pane">
          <div className="detail-head">
            <div>
              <h3>{detail.definition.name}</h3>
              <p className="tag-sub">
                {detail.definition.code} · {detail.definition.objectType} · 层级 {detail.definition.level}
                {detail.definition.parentCode ? ` · 父标签 ${detail.definition.parentCode}` : ''}
              </p>
              <p className="tag-sub">
                输入筛选任务：{detail.definition.sourceRunId}
                {detail.sourceRun?.ruleCode ? `（${detail.sourceRun.ruleCode} · ${detail.sourceRun.dataset}）` : ''}
              </p>
            </div>
            <div className="detail-actions">
              {computing ? (
                <>
                  <span className="chip chip-busy">v{computing.version} 回算中</span>
                  <button className="btn" type="button" onClick={() => runInterrupt(selected)}>中断回算</button>
                </>
              ) : (
                <button className="btn primary" type="button" onClick={() => runCompute(selected)}>按当前口径回算</button>
              )}
              <button className="btn" type="button" onClick={() => runCheck(selected)}>校验层级</button>
              {detail.definition.status === '已启用' ? (
                <button className="btn" type="button" onClick={() => runDisable(selected)}>停用标签</button>
              ) : (
                <button className="btn primary" type="button" onClick={() => runEnable(selected)}>启用标签</button>
              )}
              <button className="btn ghost" type="button" onClick={() => runSubmit(selected)}>提交校验</button>
            </div>
          </div>

          {(validation.errors.length > 0 || validation.warnings.length > 0) && (
            <div className="validation-box">
              {validation.errors.map((item) => <p key={item} className="error-text">✕ {item}</p>)}
              {validation.warnings.map((item) => <p key={item} className="warn-text">! {item}</p>)}
            </div>
          )}

          <div className="summary-grid">
            <div><span>生效覆盖对象</span><strong>{shownScope?.total ?? 0}</strong></div>
            <div><span>自身命中</span><strong>{shownScope?.ownCount ?? 0}</strong></div>
            <div><span>子标签并入</span><strong>{shownScope?.fromChildren ?? 0}</strong></div>
            <div><span>按对象去重</span><strong>{shownScope?.deduped ?? 0}</strong></div>
            <div><span>已删除 / 异常</span><strong>{(shownScope?.excludedDeleted ?? 0) + (shownScope?.excludedAbnormal ?? 0)}</strong></div>
            <div><span>值域</span><strong>{detail.definition.valueDomain.join(' / ') || '空'}</strong></div>
          </div>

          {detail.versions.length > 0 && (
            <div className="version-picker">
              <label className="filter-item">
                <span>查看版本结果</span>
                <select
                  value={previewVersion?.id ?? selectedVersionId}
                  onChange={(event) => {
                    const id = event.target.value
                    setSelectedVersionId(id)
                    const found = detail.versions.find((item) => item.id === id) ?? null
                    setPreviewVersion(found)
                  }}
                >
                  {detail.versions.map((version) => (
                    <option key={version.id} value={version.id}>{versionLabel(version)}</option>
                  ))}
                </select>
              </label>
              {previewVersion && previewVersion.id !== detail.scope.versionId && (
                <span className="chip chip-muted">预览历史版本，不跟随当前定义</span>
              )}
            </div>
          )}

          {!shownScope || shownScope.versionId === null ? (
            <div className="empty-block">
              <p>标签暂时没有覆盖结果。</p>
              {detail.latestVersion ? (
                <p className="tag-sub">
                  最近一次 v{detail.latestVersion.version} 为「{detail.latestVersion.status}」：
                  {detail.latestVersion.failureReason ?? detail.latestVersion.interruptedReason ?? '未提供原因'}
                </p>
              ) : (
                <p className="tag-sub">还没有发起过回算。</p>
              )}
              {detail.latestVersion?.retryable && (
                <button className="btn primary" type="button" onClick={() => runRetry(selected)}>重试回算</button>
              )}
            </div>
          ) : null}

          <div className="tab-bar">
            {([
              ['scope', `覆盖范围 (${shownScope?.objects.length ?? 0})`],
              ['evidence', `证据 (${shownScope?.evidence.length ?? 0})`],
              ['versions', `版本历史 (${detail.versions.length})`],
              ['reports', `报告 (${detail.reports.length})`],
              ['edit', '表达式与层级'],
            ] as const).map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={activeTab === key ? 'tab tab-active' : 'tab'}
                onClick={() => setActiveTab(key)}
              >
                {label}
              </button>
            ))}
          </div>

          {activeTab === 'scope' && (
            <>
              <label className="inline-check">
                <input
                  type="checkbox"
                  checked={scopeOnlyUncovered}
                  onChange={(event) => setScopeOnlyUncovered(event.target.checked)}
                />
                只看未覆盖 / 被排除对象
              </label>
              {shownScope && shownScope.versionId !== null && shownScope.total === 0 && (
                <div className="empty-block">
                  <p>这个版本没有覆盖任何对象。</p>
                  <p className="tag-sub">
                    {shownScope.evidence[0]?.message ??
                      '命中行可能没有满足表达式或值域，切换到「证据」查看逐条未命中原因。'}
                  </p>
                  <button className="btn" type="button" onClick={() => setActiveTab('evidence')}>查看未命中证据</button>
                </div>
              )}
              <table className="data-table">
                <thead>
                  <tr>
                    <th>对象</th>
                    <th>来源</th>
                    <th>计入覆盖</th>
                    <th>当前状态</th>
                    <th>来源命中行</th>
                    <th>说明</th>
                  </tr>
                </thead>
                <tbody>
                  {shownObjects.map((object) => (
                    <tr key={object.key} className={object.included ? '' : 'row-excluded'}>
                      <td>
                        {object.name}
                        <div className="tag-sub">{object.objectType} · {object.objectId}{object.value ? ` · 值 ${object.value}` : ''}</div>
                      </td>
                      <td>
                        {object.origin}
                        {childTagsOf(object).length > 0 && (
                          <div className="tag-sub">另被子标签 {childTagsOf(object).join('、')} 覆盖</div>
                        )}
                      </td>
                      <td>{object.included ? '是' : '否'}</td>
                      <td><span className={object.state === '正常' ? 'chip chip-on' : 'chip chip-bad'}>{scopeStateLabel(object)}</span></td>
                      <td className="tag-sub">
                        {tagApi.provenanceOf({
                          origin: object.origin,
                          sources: object.sources,
                        } as tagApi.CoverageEntry).join('，')}
                      </td>
                      <td className="tag-sub">{object.reason ?? '—'}</td>
                    </tr>
                  ))}
                  {shownObjects.length === 0 && (
                    <tr>
                      <td className="empty-state" colSpan={6}>
                        {shownScope?.total === 0 ? '当前版本没有覆盖任何对象，可查看证据了解未命中原因' : '没有未覆盖对象'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </>
          )}

          {activeTab === 'evidence' && (
            <div className="evidence-list">
              {(shownScope?.evidence ?? []).map((item, index) => (
                <article key={`${item.kind}-${index}`} className={evidenceClass(item.kind)}>
                  <strong>{item.label}</strong>
                  <p>{item.message}</p>
                  <div className="tag-sub">
                    {item.objectId ? `对象 ${item.objectId} · ` : ''}
                    {item.sourceRunId ? `筛选任务 ${item.sourceRunId} · ` : ''}
                    {item.sourceTagCode ? `来源标签 ${item.sourceTagCode} · ` : ''}
                    {item.sourceRowId ? `命中行 ${item.sourceRowId}` : ''}
                  </div>
                </article>
              ))}
              {(shownScope?.evidence.length ?? 0) === 0 && (
                <p className="empty-state">当前版本没有未命中证据</p>
              )}
            </div>
          )}

          {activeTab === 'versions' && (
            <table className="data-table">
              <thead>
                <tr>
                  <th>版本</th>
                  <th>状态</th>
                  <th>表达式快照</th>
                  <th>覆盖对象</th>
                  <th>证据</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {detail.versions.map((version) => (
                  <tr key={version.id}>
                    <td>
                      v{version.version}
                      <div className="tag-sub">{version.id}</div>
                    </td>
                    <td><span className={statusClass(version.status)}>{version.status}</span></td>
                    <td className="tag-sub">{version.expressionSnapshot || '—'}</td>
                    <td>{version.counts.covered}</td>
                    <td>{version.evidence.length}</td>
                    <td className="row-actions">
                      {(version.status === '已发布' || version.status === '已替代') && (
                        <>
                          <button className="link" type="button" onClick={() => { setPreviewVersion(version); setSelectedVersionId(version.id); setActiveTab('scope') }}>
                            查看结果
                          </button>
                          <button className="link" type="button" onClick={() => runFreezeReport(selected, version.id)}>
                            冻结为报告
                          </button>
                        </>
                      )}
                      {version.retryable && (
                        <button className="link" type="button" onClick={() => runRetry(selected)}>重试</button>
                      )}
                    </td>
                  </tr>
                ))}
                {detail.versions.length === 0 && (
                  <tr><td className="empty-state" colSpan={6}>还没有回算版本</td></tr>
                )}
              </tbody>
            </table>
          )}

          {activeTab === 'reports' && (
            <ReportPanel
              reports={reports.filter((item) => item.report.tagCode === selected)}
              onRemove={(reportId) => applyResult(tagApi.removeReport(reportId))}
            />
          )}

          {activeTab === 'edit' && (
            <EditPanel
              key={detail.definition.code}
              detail={detail}
              parentOptions={parentOptions}
              computing={computing}
              onSave={(input) => applyResult(tagApi.updateTag(input))}
              onReparent={(parentCode) => runReparent(selected, parentCode)}
            />
          )}
        </div>
      </div>

      <footer className="page-foot">
        <span>{scope.children.length} 个子标签；父标签范围 = 自身命中 ∪ 子标签当前版本，按对象去重</span>
        <span>{stats.evidence} 条证据；报告引用版本 id，不跟随新口径</span>
      </footer>

      {confirmReparent && (
        <div className="confirm-mask">
          <div className="confirm-box">
            <h4>确认调整层级？</h4>
            <p>{confirmReparent.message}</p>
            <div className="detail-actions">
              <button className="btn" type="button" onClick={() => setConfirmReparent(null)}>取消</button>
              <button className="btn primary" type="button" onClick={confirmReparentNow}>我已知晓，仍然调整</button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

function ReportPanel({ reports, onRemove }: { reports: ReportRead[]; onRemove: (reportId: string) => void }) {
  if (reports.length === 0) {
    return <p className="empty-state">还没有报告引用这个标签的版本，可在版本历史里冻结某个已发布版本</p>
  }
  return (
    <div className="report-list">
      {reports.map((item) => (
        <article key={item.report.id} className="report-card">
          <header>
            <strong>{item.report.name}</strong>
            <span className={statusClass(item.superseded ? '已替代' : item.version?.status ?? '')}>
              引用 v{item.report.versionNo}
            </span>
            <button className="link" type="button" onClick={() => onRemove(item.report.id)}>删除报告</button>
          </header>
          <p className="tag-sub">{item.note}</p>
          <p className="tag-sub">
            冻结于 {new Date(item.report.createdAt).toLocaleString('zh-CN')} · 覆盖 {item.report.frozenCounts.covered} 个对象
            {item.expired ? ' · 引用的标签版本已失效' : ''}
          </p>
          <table className="data-table">
            <thead>
              <tr><th>对象</th><th>来源筛选任务</th><th>来源命中行</th><th>当前状态</th><th>说明</th></tr>
            </thead>
            <tbody>
              {item.objects.map((object) => (
                <tr key={object.objectId}>
                  <td>{object.name}<div className="tag-sub">{object.objectType} · {object.objectId}</div></td>
                  <td>{object.sourceRunId ?? '—'}{object.sourceRuleCode ? `（${object.sourceRuleCode}）` : ''}</td>
                  <td>{object.sourceRowId ?? '—'}</td>
                  <td>{object.currentState}</td>
                  <td className="tag-sub">{object.note}</td>
                </tr>
              ))}
              {item.objects.length === 0 && (
                <tr><td className="empty-state" colSpan={5}>该版本当时没有覆盖对象</td></tr>
              )}
            </tbody>
          </table>
        </article>
      ))}
    </div>
  )
}

function EditPanel({
  detail,
  parentOptions,
  computing,
  onSave,
  onReparent,
}: {
  detail: TagDetail
  parentOptions: { code: string; name: string; level: number }[]
  computing: TagVersion | null
  onSave: (input: Parameters<typeof tagApi.updateTag>[0]) => void
  onReparent: (parentCode: string | null) => void
}) {
  const [expression, setExpression] = useState(detail.definition.expression)
  const [boundary, setBoundary] = useState(detail.definition.boundaryExpression)
  const [domain, setDomain] = useState(detail.definition.valueDomain.join(', '))
  const [sourceRunId, setSourceRunId] = useState(detail.definition.sourceRunId)
  const [parentCode, setParentCode] = useState(detail.definition.parentCode ?? PARENT_NONE)
  const [expireDays, setExpireDays] = useState(String(detail.definition.expireDays))

  return (
    <div className="edit-panel">
      {computing && (
        <div className="notice notice-bad">
          版本 v{computing.version} 正在回算，表达式与值域已冻结，保存会被拒绝；等待完成或中断后再编辑。
        </div>
      )}
      <label className="edit-item">
        <span>计算表达式</span>
        <input value={expression} onChange={(event) => setExpression(event.target.value)} />
        <small>示例：totalAmount &gt;= 100000 并且 level == A；可用 并且 / 或者 / 括号，字段可写中文名。</small>
      </label>
      <label className="edit-item">
        <span>父标签范围边界（子标签成员必须满足）</span>
        <input value={boundary} disabled={!detail.definition.parentCode} placeholder="为空时退回父标签自身表达式" onChange={(event) => setBoundary(event.target.value)} />
        <small>用于校验子标签不得超出父范围；父标签自身回算仍按上面的计算表达式。</small>
      </label>
      <label className="edit-item">
        <span>值域范围（逗号分隔，对应 {detail.definition.valueField}）</span>
        <input value={domain} placeholder="上海, 南京, 杭州" onChange={(event) => setDomain(event.target.value)} />
        <small>值域为空时不会产生任何标签结果，全部命中行都会记为未命中。</small>
      </label>
      <label className="edit-item">
        <span>输入筛选任务</span>
        <input value={sourceRunId} onChange={(event) => setSourceRunId(event.target.value)} />
      </label>
      <label className="edit-item">
        <span>失效天数</span>
        <input value={expireDays} onChange={(event) => setExpireDays(event.target.value)} />
      </label>
      <div className="detail-actions">
        <button
          className="btn primary"
          type="button"
          disabled={!!computing}
          onClick={() =>
            onSave({
              code: detail.definition.code,
              name: detail.definition.name,
              expression,
              boundaryExpression: boundary,
              valueDomain: domain.split(','),
              sourceRunId,
              expireDays: Number(expireDays) || detail.definition.expireDays,
            })
          }
        >
          保存定义（需重新回算生效）
        </button>
      </div>

      <div className="reparent-box">
        <label className="edit-item">
          <span>父标签归属</span>
          <select value={parentCode} onChange={(event) => setParentCode(event.target.value)}>
            <option value={PARENT_NONE}>{PARENT_NONE}</option>
            {parentOptions.map((item) => (
              <option key={item.code} value={item.code}>{item.code} · {item.name}（{item.level} 级）</option>
            ))}
          </select>
        </label>
        <button
          className="btn"
          type="button"
          disabled={!!computing}
          onClick={() => onReparent(parentCode === PARENT_NONE ? null : parentCode)}
        >
          调整父标签（已发布子标签成员不变）
        </button>
        <small>修改父标签不会自动改写已发布子标签的成员；层级绕回会被拒绝。</small>
      </div>
    </div>
  )
}

function readWorkspace(code: string): {
  rows: TagListRow[]
  stats: tagApi.TagStats
  reports: ReportRead[]
  detail: TagDetail | null
  error: string
} {
  try {
    const workspace = tagApi.loadWorkspace()
    return {
      rows: workspace.rows,
      stats: workspace.stats,
      reports: workspace.reports,
      detail: tagApi.openTag(code),
      error: '',
    }
  } catch (cause) {
    return {
      rows: [],
      stats: { total: 0, enabled: 0, pending: 0, evidence: 0, activeCoverage: 0 },
      reports: [],
      detail: null,
      error: cause instanceof Error ? cause.message : '数据标签列表读取失败',
    }
  }
}

let bootstrapped = false
function ensureTagStateOnce() {
  if (bootstrapped) return
  bootstrapped = true
  try {
    tagApi.ensureTagState()
  } catch {
    /* 初始化失败由页面读取时的错误提示兜底 */
  }
}
