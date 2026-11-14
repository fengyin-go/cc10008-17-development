import {
  completeRecompute,
  createReport,
  deleteReport,
  disableTag,
  enableTag,
  ensureTagState,
  findDefinition,
  interruptRecompute,
  listReports,
  listTagRows,
  loadTagDetail,
  markPendingValidation,
  readReport,
  recomputeNow,
  reparentTag,
  resolveScope,
  resetTagState,
  retryRecompute,
  saveDefinition,
  startRecompute,
  tagStats,
  validateTag,
} from '@/data/tag-engine'
import type { CoverageEntry, TagActionResult } from '@/data/tag-types'

// 标签页面统一走这里：页面不做业务判断，只负责展示与触发动作。
export { ensureTagState }
export type * from '@/data/tag-types'

export function loadWorkspace() {
  ensureTagState()
  return {
    rows: listTagRows(),
    stats: tagStats(),
    reports: listReports().map((report) => readReport(report.id)!),
  }
}

export function scopeOfVersion(code: string, versionId: string) {
  const definition = findDefinition(code)
  if (!definition) return null
  return resolveScope(definition, { versionId, preview: true })
}

export function openTag(code: string) {
  ensureTagState()
  return loadTagDetail(code)
}

export function beginCompute(code: string): TagActionResult {
  const definition = findDefinition(code)
  if (!definition) return { ok: false, message: `标签 ${code} 不存在` }
  return startRecompute(definition)
}

export function finishCompute(code: string, token: string): TagActionResult {
  return completeRecompute(code, token)
}

export function abortCompute(code: string, reason: string): TagActionResult {
  return interruptRecompute(code, reason)
}

export function retryTag(code: string): TagActionResult {
  return retryRecompute(code)
}

export function enable(code: string): TagActionResult {
  return enableTag(code)
}

export function disable(code: string): TagActionResult {
  return disableTag(code)
}

export function submitValidation(code: string): TagActionResult {
  return markPendingValidation(code)
}

export function checkTag(code: string): TagActionResult {
  const validation = validateTag(code)
  return {
    ok: validation.ok,
    message: validation.ok
      ? `校验通过，可启用（${validation.warnings.length} 条提示）`
      : `校验未通过：${validation.errors[0]}`,
    validation,
  }
}

export function updateTag(input: Parameters<typeof saveDefinition>[0]): TagActionResult {
  return saveDefinition(input)
}

export function changeParent(code: string, parentCode: string | null, confirmMismatch = false): TagActionResult {
  return reparentTag(code, parentCode, confirmMismatch)
}

export function freezeReport(name: string, tagCode: string, versionId: string): TagActionResult {
  return createReport({ name, tagCode, versionId })
}

export function removeReport(reportId: string): TagActionResult {
  return deleteReport(reportId)
}

export function resetWorkspace(): void {
  resetTagState()
}

export function exportScopeCsv(code: string): { filename: string; content: string } {
  const detail = openTag(code)
  if (!detail) return { filename: `${code}-覆盖范围.csv`, content: '' }
  const header = ['对象类型', '对象编号', '对象名称', '来源', '是否计入覆盖', '当前状态', '来源筛选任务', '来源命中行', '说明']
  const lines = [header.join(',')]
  for (const object of detail.scope.objects) {
    const source = object.sources[0]
    lines.push(
      [
        object.objectType,
        object.objectId,
        object.name,
        object.origin,
        object.included ? '是' : '否',
        object.state,
        source?.runId ?? '',
        source?.rowId ?? '',
        object.reason ?? '',
      ]
        .map((value) => `"${String(value).replace(/"/g, '""')}"`)
        .join(','),
    )
  }
  return { filename: `${detail.definition.code}-${detail.definition.name}-覆盖范围.csv`, content: `﻿${lines.join('\n')}` }
}

/**
 * 覆盖对象的来源说明：同一个对象的命中行去重后逐条列出。
 * 仅当对象整体来自子标签时，标注是哪条并入路径带进来的。
 */
export function provenanceOf(entry: CoverageEntry): string[] {
  const rows = [...new Set(entry.sources.map((source) => `${source.runId ?? ''}/${source.rowId ?? ''}`))]
  if (entry.origin !== '子标签') return rows
  const childTags = [
    ...new Set(entry.sources.map((source) => source.fromChildTagCode).filter((code): code is string => !!code)),
  ]
  return childTags.length > 0 ? rows.map((row) => `${row}（经 ${childTags.join('、')} 并入）`) : rows
}

export function download(file: { filename: string; content: string }): void {
  const blob = new Blob([file.content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = file.filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}
