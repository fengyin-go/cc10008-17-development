import type { TagState } from './tag-types'

/** 标签模块的独立持久化 key：与通用业务清单分开，版本与报告体积更大。 */
export const TAG_STORAGE_KEY = 'interactive-analytics-lab:tags'

export function readTagState(): TagState | null {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null
  }
  const raw = window.localStorage.getItem(TAG_STORAGE_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as TagState
    if (!parsed || !Array.isArray(parsed.definitions) || !Array.isArray(parsed.versions)) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

export function persistTagState(state: TagState): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }
  window.localStorage.setItem(TAG_STORAGE_KEY, JSON.stringify(state))
}

export function clearTagState(): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }
  window.localStorage.removeItem(TAG_STORAGE_KEY)
}

export function tagStateExists(): boolean {
  if (typeof window === 'undefined' || !window.localStorage) {
    return false
  }
  return window.localStorage.getItem(TAG_STORAGE_KEY) !== null
}
