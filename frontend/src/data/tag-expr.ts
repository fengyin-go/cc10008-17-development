import { FIELD_LABELS, OBJECT_FIELDS } from './tag-types'
import type { DatasetObject, FilterHitRow, ObjectAttributes, ObjectType, TagState } from './tag-types'

/**
 * 标签表达式求值。
 *
 * 语法刻意保持很小：`字段 运算符 值`，可用 `并且` / `或者` 连接，支持括号。
 * 运算符：= == != <> > >= < <= 包含 不包含。
 * 标识符可写字段英文名（city）或中文名（城市）。值可以是数字、带引号字符串或裸词。
 */

export type ExprNode =
  | { type: 'compare'; field: string; op: string; value: string }
  | { type: 'and'; items: ExprNode[] }
  | { type: 'or'; items: ExprNode[] }

const OPERATORS = ['>=', '<=', '!=', '<>', '==', '=', '>', '<', '包含', '不包含']

/** 中英文运算符的容错写法 → 归一化操作符 */
const OPERATOR_ALIASES: Record<string, string> = {
  '===': '==',
  '=': '==',
  '==': '==',
  '!==': '!=',
  '<>': '!=',
  '!=': '!=',
  '>=': '>=',
  '<=': '<=',
  '>': '>',
  '<': '<',
  包含: '包含',
  包括: '包含',
  不包含: '!=包含',
  不含: '!=包含',
}

export type Token = { kind: 'word' | 'string' | 'symbol' | 'op' | 'connector'; value: string }

export class ExpressionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExpressionError'
  }
}

function isWordChar(char: string): boolean {
  return /[\p{L}\p{N}_.$-]/u.test(char)
}

export function tokenize(input: string): Token[] {
  const tokens: Token[] = []
  let index = 0
  while (index < input.length) {
    const char = input[index]
    if (/\s/.test(char)) {
      index += 1
      continue
    }
    if (char === '(' || char === ')') {
      tokens.push({ kind: 'symbol', value: char })
      index += 1
      continue
    }
    if (char === '"' || char === "'") {
      const quote = char
      let text = ''
      index += 1
      while (index < input.length && input[index] !== quote) {
        text += input[index]
        index += 1
      }
      if (index >= input.length) {
        throw new ExpressionError('字符串值缺少结束引号')
      }
      index += 1
      tokens.push({ kind: 'string', value: text })
      continue
    }
    if (/[=<>!]/.test(char)) {
      let text = ''
      while (index < input.length && /[=<>!]/.test(input[index])) {
        text += input[index]
        index += 1
      }
      tokens.push({ kind: 'op', value: text })
      continue
    }
    if (isWordChar(char)) {
      let text = ''
      while (index < input.length && isWordChar(input[index])) {
        text += input[index]
        index += 1
      }
      if (AND_WORDS.has(text) || OR_WORDS.has(text)) {
        tokens.push({ kind: 'connector', value: text })
      } else {
        tokens.push({ kind: 'word', value: text })
      }
      continue
    }
    throw new ExpressionError(`无法识别的字符「${char}」`)
  }
  return tokens
}

const AND_WORDS = new Set(['并且', '且', 'AND', 'and'])
const OR_WORDS = new Set(['或者', '或', 'OR', 'or'])

function operatorOf(token: Token | undefined): string | null {
  if (!token) return null
  if ((token.kind === 'word' || token.kind === 'op') && OPERATOR_ALIASES[token.value]) {
    return OPERATOR_ALIASES[token.value]
  }
  return null
}

export function parseExpression(input: string): ExprNode {
  const tokens = tokenize(input.trim())
  if (tokens.length === 0) {
    throw new ExpressionError('计算表达式为空')
  }
  let position = 0

  function peek(): Token | undefined {
    return tokens[position]
  }

  function parseOr(): ExprNode {
    const items: ExprNode[] = [parseAnd()]
    for (let token = peek(); token && token.kind === 'connector' && OR_WORDS.has(token.value); token = peek()) {
      position += 1
      items.push(parseAnd())
    }
    return items.length === 1 ? items[0] : { type: 'or', items }
  }

  function parseAnd(): ExprNode {
    const items: ExprNode[] = [parseAtom()]
    for (let token = peek(); token && token.kind === 'connector' && AND_WORDS.has(token.value); token = peek()) {
      position += 1
      items.push(parseAtom())
    }
    return items.length === 1 ? items[0] : { type: 'and', items }
  }

  function parseAtom(): ExprNode {
    const token = peek()
    if (token && token.kind === 'symbol' && token.value === '(') {
      position += 1
      const node = parseOr()
      const close = peek()
      if (!close || close.kind !== 'symbol' || close.value !== ')') {
        throw new ExpressionError('括号不匹配')
      }
      position += 1
      return node
    }
    return parseCompare()
  }

  function parseCompare(): ExprNode {
    const fieldToken = peek()
    if (!fieldToken || fieldToken.kind === 'symbol') {
      throw new ExpressionError('缺少比较字段')
    }
    position += 1
    const opToken = peek()
    const op = operatorOf(opToken)
    if (!op) {
      throw new ExpressionError(`字段「${fieldToken.value}」后缺少比较运算符`)
    }
    position += 1
    const valueToken = peek()
    if (!valueToken || valueToken.kind === 'symbol' || valueToken.kind === 'op' || valueToken.kind === 'connector') {
      throw new ExpressionError(`运算符「${opToken!.value}」后缺少比较值`)
    }
    position += 1
    return {
      type: 'compare',
      field: fieldToken.value,
      op: op === '!=包含' ? '不包含' : op,
      value: valueToken.value,
    }
  }

  const node = parseOr()
  if (position < tokens.length) {
    const extra = tokens[position]
    throw new ExpressionError(`表达式在「${extra.value}」之后无法解析`)
  }
  return node
}

/** 把中文字段名归一化成属性键，同时接受属性键本身。 */
export function fieldKeyOf(field: string): string {
  const trimmed = field.trim()
  for (const [key, label] of Object.entries(FIELD_LABELS)) {
    if (label === trimmed) return key
  }
  return trimmed
}

function normalize(value: string | number | boolean): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return String(value)
}

function numeric(value: string | number | boolean): number | null {
  if (typeof value === 'number') return Number.isNaN(value) ? null : value
  const text = String(value).trim()
  if (text === '') return null
  const parsed = Number(text)
  return Number.isNaN(parsed) ? null : parsed
}

export function nodeMatches(node: ExprNode, attributes: ObjectAttributes): boolean {
  if (node.type === 'and') {
    return node.items.every((item) => nodeMatches(item, attributes))
  }
  if (node.type === 'or') {
    return node.items.some((item) => nodeMatches(item, attributes))
  }
  const key = fieldKeyOf(node.field)
  const actual = attributes[key]
  const expected = node.value
  switch (node.op) {
    case '==':
      return actual !== undefined && normalize(actual) === expected
    case '!=':
      return actual === undefined || normalize(actual) !== expected
    case '>':
    case '>=':
    case '<':
    case '<=': {
      if (actual === undefined) return false
      const left = numeric(actual)
      const right = numeric(expected)
      if (left === null || right === null) {
        return node.op === '>' ? false : false
      }
      if (node.op === '>') return left > right
      if (node.op === '>=') return left >= right
      if (node.op === '<') return left < right
      return left <= right
    }
    case '包含':
      return actual !== undefined && normalize(actual).includes(expected)
    case '不包含':
      return actual === undefined || !normalize(actual).includes(expected)
    default:
      return false
  }
}

export function evaluateExpression(input: string, attributes: ObjectAttributes): boolean {
  return nodeMatches(parseExpression(input), attributes)
}

/** 供页面展示的字段提示。 */
export function fieldHint(objectType: ObjectType): string {
  return OBJECT_FIELDS[objectType]
    .map((key) => `${key}(${FIELD_LABELS[key] ?? key})`)
    .join('、')
}

/** 按对象 id 聚拢命中行，保留每一行的来源信息以便给出重复命中证据。 */
export function groupHitRows(rows: FilterHitRow[]): Map<string, FilterHitRow[]> {
  const groups = new Map<string, FilterHitRow[]>()
  for (const row of rows) {
    const key = row.objectId
    const group = groups.get(key)
    if (group) {
      group.push(row)
    } else {
      groups.set(key, [row])
    }
  }
  return groups
}

export function objectKeyOf(objectType: ObjectType, objectId: string): string {
  return `${objectType}:${objectId}`
}

export function findObject(state: TagState, objectType: ObjectType, objectId: string): DatasetObject | undefined {
  return state.objects.find((item) => objectKeyOf(item.objectType, item.objectId) === objectKeyOf(objectType, objectId))
}

