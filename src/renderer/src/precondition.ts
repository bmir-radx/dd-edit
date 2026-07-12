/**
 * Client-side support for the spec's precondition grammar:
 *
 *   expression := clause ( ("and" | "or") clause )*     (and binds tighter)
 *   clause     := predicate | "(" expression ")"
 *   predicate  := fieldId ("=" | "<>" | "<" | "<=" | ">" | ">=") literal
 *               | fieldId "<>" ""
 *               | fieldId "in" "{" literal ("," literal)* "}"
 *               | fieldId "contains" literal
 *   literal    := "quoted string" | bare numeral
 *
 * Three pure pieces, shared by the inspector's precondition field:
 *   - parse():   tokenizer + recursive-descent parser → AST or a positioned error
 *   - analyze(): semantic warnings against the open document (unknown field,
 *                ordering op on an unordered datatype, contains on a
 *                single-cardinality field, value outside an enumeration)
 *   - suggest(): context-aware completions at a cursor position
 *
 * The Python validator stays the authority; this exists for instant feedback
 * and type-ahead while editing.
 */
import type { DataElement, EnumItem } from './types/document'

// ---------------------------------------------------------------- tokens

export type TokenKind =
  | 'ident' // field id
  | 'kw' // and / or / in / contains (case-insensitive)
  | 'string'
  | 'number'
  | 'op' // = <> < <= > >=
  | 'lparen'
  | 'rparen'
  | 'lbrace'
  | 'rbrace'
  | 'comma'
  | 'error' // unterminated string / stray character

export interface Token {
  kind: TokenKind
  text: string
  start: number
  end: number
}

const KEYWORDS = new Set(['and', 'or', 'in', 'contains'])
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_.-]*/
const NUMBER_RE = /^-?\d+(\.\d+)?/

export function tokenize(text: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (/\s/.test(ch)) {
      i++
      continue
    }
    const push = (kind: TokenKind, len: number) => {
      tokens.push({ kind, text: text.slice(i, i + len), start: i, end: i + len })
      i += len
    }
    if (ch === '"') {
      const close = text.indexOf('"', i + 1)
      if (close === -1) {
        push('error', text.length - i) // unterminated string
      } else {
        push('string', close - i + 1)
      }
    } else if (ch === '(') push('lparen', 1)
    else if (ch === ')') push('rparen', 1)
    else if (ch === '{') push('lbrace', 1)
    else if (ch === '}') push('rbrace', 1)
    else if (ch === ',') push('comma', 1)
    else if (text.startsWith('<>', i) || text.startsWith('<=', i) || text.startsWith('>=', i))
      push('op', 2)
    else if (ch === '=' || ch === '<' || ch === '>') push('op', 1)
    else {
      const rest = text.slice(i)
      const num = NUMBER_RE.exec(rest)
      const id = IDENT_RE.exec(rest)
      if (id) {
        const kind = KEYWORDS.has(id[0].toLowerCase()) ? 'kw' : 'ident'
        push(kind, id[0].length)
      } else if (num) {
        push('number', num[0].length)
      } else {
        push('error', 1)
      }
    }
  }
  return tokens
}

// ------------------------------------------------------------------- AST

export interface Literal {
  raw: string // token text, quotes included for strings
  value: string // unquoted value
  quoted: boolean
}

export interface PredNode {
  kind: 'pred'
  field: string
  op: string // lowercased: = <> < <= > >= in contains
  values: Literal[]
}
export interface BoolNode {
  kind: 'bool'
  op: 'and' | 'or'
  parts: ExprNode[]
}
export interface GroupNode {
  kind: 'group'
  inner: ExprNode
}
export type ExprNode = PredNode | BoolNode | GroupNode

export type ParseResult =
  | { ok: true; ast: ExprNode }
  | { ok: false; message: string; pos: number }

export function parse(text: string): ParseResult {
  const tokens = tokenize(text)
  let i = 0

  const peek = () => tokens[i]
  const fail = (message: string, at?: Token): ParseResult => ({
    ok: false,
    message,
    pos: at ? at.start : text.length,
  })

  function literal(): Literal | ParseResult {
    const t = peek()
    if (t === undefined) return fail('expected a value ("…" or a number)')
    if (t.kind === 'string') {
      i++
      return { raw: t.text, value: t.text.slice(1, -1), quoted: true }
    }
    if (t.kind === 'number') {
      i++
      return { raw: t.text, value: t.text, quoted: false }
    }
    if (t.kind === 'error' && t.text.startsWith('"')) return fail('unterminated string', t)
    return fail('expected a value ("…" or a number)', t)
  }

  function predicate(): ExprNode | ParseResult {
    const f = peek()
    if (f === undefined) return fail('expected a field Id')
    if (f.kind !== 'ident') return fail('expected a field Id', f)
    i++
    const op = peek()
    if (op === undefined) return fail('expected an operator (= <> < <= > >= in contains)')
    if (op.kind === 'op') {
      i++
      const lit = literal()
      if ('ok' in lit) return lit
      return { kind: 'pred', field: f.text, op: op.text, values: [lit] }
    }
    if (op.kind === 'kw' && op.text.toLowerCase() === 'in') {
      i++
      const brace = peek()
      if (brace === undefined || brace.kind !== 'lbrace') return fail('expected {', brace)
      i++
      const values: Literal[] = []
      for (;;) {
        const lit = literal()
        if ('ok' in lit) return lit
        values.push(lit)
        const sep = peek()
        if (sep !== undefined && sep.kind === 'comma') {
          i++
          continue
        }
        if (sep !== undefined && sep.kind === 'rbrace') {
          i++
          break
        }
        return fail('expected , or }', sep)
      }
      return { kind: 'pred', field: f.text, op: 'in', values }
    }
    if (op.kind === 'kw' && op.text.toLowerCase() === 'contains') {
      i++
      const lit = literal()
      if ('ok' in lit) return lit
      return { kind: 'pred', field: f.text, op: 'contains', values: [lit] }
    }
    return fail('expected an operator (= <> < <= > >= in contains)', op)
  }

  function clause(): ExprNode | ParseResult {
    const t = peek()
    if (t !== undefined && t.kind === 'lparen') {
      i++
      const inner = orExpr()
      if ('ok' in inner) return inner
      const close = peek()
      if (close === undefined || close.kind !== 'rparen') return fail('expected )', close)
      i++
      return { kind: 'group', inner }
    }
    return predicate()
  }

  function level(op: 'and' | 'or', next: () => ExprNode | ParseResult): ExprNode | ParseResult {
    const first = next()
    if ('ok' in first) return first
    const parts = [first]
    while (peek() !== undefined && peek().kind === 'kw' && peek().text.toLowerCase() === op) {
      i++
      const part = next()
      if ('ok' in part) return part
      parts.push(part)
    }
    return parts.length === 1 ? parts[0] : { kind: 'bool', op, parts }
  }

  const andExpr = () => level('and', clause)
  const orExpr = () => level('or', andExpr)

  const result = orExpr()
  if ('ok' in result) return result
  const trailing = peek()
  if (trailing !== undefined) return fail('expected and / or, or the end', trailing)
  return { ok: true, ast: result }
}

// ------------------------------------------------------------- semantics

/** Datatypes the ordering predicates are legal on (numeric + temporal). */
export function isOrderedDatatype(datatype: string): boolean {
  return /(int|float|decimal|double|number|date|time|year)/i.test(datatype)
}

/** Shape check for literals compared against a field of this datatype. */
function datatypeChecker(
  datatype: string,
): { hint: string; ok: (v: string) => boolean } | null {
  const s = datatype.toLowerCase()
  if (/int/.test(s)) return { hint: 'an integer', ok: (v) => /^-?\d+$/.test(v) }
  if (/(float|decimal|double|number)/.test(s))
    return { hint: 'a number', ok: (v) => /^-?\d+(\.\d+)?$/.test(v) }
  if (/datetime/.test(s))
    return { hint: 'a dateTime (YYYY-MM-DDThh:mm:ss)', ok: (v) => /^\d{4}-\d{2}-\d{2}T/.test(v) }
  if (/date/.test(s))
    return { hint: 'a date (YYYY-MM-DD)', ok: (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) }
  if (/time/.test(s)) return { hint: 'a time (hh:mm)', ok: (v) => /^\d{2}:\d{2}/.test(v) }
  if (/bool/.test(s))
    return { hint: 'a boolean (0/1/true/false)', ok: (v) => /^(0|1|true|false)$/i.test(v) }
  return null
}

export interface Warning {
  message: string
}

export function analyze(ast: ExprNode, elements: readonly DataElement[]): Warning[] {
  const byId = new Map(elements.map((e) => [e.id, e]))
  const warnings: Warning[] = []
  const seen = new Set<string>()
  const warn = (message: string) => {
    if (!seen.has(message)) {
      seen.add(message)
      warnings.push({ message })
    }
  }

  const visit = (node: ExprNode): void => {
    if (node.kind === 'bool') return node.parts.forEach(visit)
    if (node.kind === 'group') return visit(node.inner)
    const el = byId.get(node.field)
    if (el === undefined) {
      warn(`“${node.field}” is not a field Id in this dictionary`)
      return
    }
    const ordering = ['<', '<=', '>', '>='].includes(node.op)
    if (ordering && !isOrderedDatatype(el.datatype)) {
      warn(`“${node.op}” needs an ordered datatype — ${node.field} is ${el.datatype || 'text'}`)
    }
    if (node.op === 'contains' && el.cardinality !== 'multiple') {
      warn(`“contains” needs Cardinality multiple — ${node.field} is single`)
    }
    const enumeration = (el.enumeration ?? []) as EnumItem[]
    // The `<> ""` blank test is always fine; skip its value everywhere.
    const values = node.values.filter((v) => !(node.op === '<>' && v.value === ''))
    if (!ordering && enumeration.length > 0) {
      // Equality-style ops on an enumerated field: the value must be one of
      // the field's codes (=, <>, in, contains all compare against them).
      const legal = new Set(enumeration.map((e) => e.value))
      for (const v of values) {
        if (!legal.has(v.value)) {
          warn(`“${v.value}” is not in ${node.field}'s enumeration`)
        }
      }
    } else {
      // No enumeration to check against (or an ordering threshold): the
      // literal must at least fit the field's datatype value space.
      const checker = datatypeChecker(el.datatype)
      if (checker !== null) {
        for (const v of values) {
          if (!checker.ok(v.value)) {
            warn(`“${v.value}” is not ${checker.hint} — ${node.field} is ${el.datatype}`)
          }
        }
      }
    }
  }
  visit(ast)
  return warnings
}

// ------------------------------------------------------------ completion

export interface Suggestion {
  /** Text to insert in place of the current partial token. */
  insert: string
  /** Primary display text. */
  display: string
  /** Secondary text (field label, enum label, operator description). */
  detail?: string
  kind: 'field' | 'op' | 'value' | 'kw'
}

/** Operators offered for a field, respecting its datatype / cardinality. */
function operatorSuggestions(el: DataElement | undefined): Suggestion[] {
  const ops: Suggestion[] = [
    { insert: '= ', display: '=', detail: 'equals', kind: 'op' },
    { insert: '<> ', display: '<>', detail: 'does not equal (with "" : is not blank)', kind: 'op' },
    { insert: 'in {', display: 'in { … }', detail: 'is one of', kind: 'op' },
  ]
  if (el === undefined || el.cardinality === 'multiple') {
    ops.push({ insert: 'contains ', display: 'contains', detail: 'multi-value field holds', kind: 'op' })
  }
  if (el === undefined || isOrderedDatatype(el.datatype)) {
    for (const [op, desc] of [
      ['<', 'less than'],
      ['<=', 'at most'],
      ['>', 'greater than'],
      ['>=', 'at least'],
    ] as const) {
      ops.push({ insert: `${op} `, display: op, detail: desc, kind: 'op' })
    }
  }
  return ops
}

function valueSuggestions(el: DataElement | undefined, allowBlankTest: boolean): Suggestion[] {
  const out: Suggestion[] = []
  if (allowBlankTest) {
    out.push({ insert: '"" ', display: '""', detail: 'blank — with <>: field has any value', kind: 'value' })
  }
  for (const item of (el?.enumeration ?? []) as EnumItem[]) {
    out.push({ insert: `"${item.value}" `, display: `"${item.value}"`, detail: item.label, kind: 'value' })
  }
  return out
}

export interface SuggestResult {
  /** Replace [from, to) of the text with the chosen suggestion's insert. */
  from: number
  to: number
  items: Suggestion[]
}

/**
 * Completions for the token being typed at `cursor`. Field positions offer the
 * dictionary's Ids; operator positions the ops legal for that field; value
 * positions the field's enumeration (labels searchable); after a complete
 * predicate, and / or.
 */
export function suggest(
  text: string,
  cursor: number,
  elements: readonly DataElement[],
  selfId?: string,
): SuggestResult {
  const before = text.slice(0, cursor)

  // The partial token under the cursor: an ident-ish word or an open string.
  const partialString = /"[^"]*$/.exec(before)
  const partialWord = partialString ? null : /[A-Za-z0-9_.-]*$/.exec(before)
  const partial = partialString?.[0] ?? partialWord?.[0] ?? ''
  const from = cursor - partial.length
  const done = tokenize(before.slice(0, from))
  const last = done[done.length - 1]

  const byId = new Map(elements.map((e) => [e.id, e]))
  /** The field a value at the current position belongs to. */
  const fieldForValue = (): DataElement | undefined => {
    for (let j = done.length - 1; j >= 0; j--) {
      const t = done[j]
      if (t.kind === 'op' || (t.kind === 'kw' && ['in'].includes(t.text.toLowerCase()))) {
        const f = done[j - 1]
        return f !== undefined && f.kind === 'ident' ? byId.get(f.text) : undefined
      }
      if (t.kind === 'kw' && ['and', 'or'].includes(t.text.toLowerCase())) return undefined
    }
    return undefined
  }

  let items: Suggestion[] = []
  const lastKw = last?.kind === 'kw' ? last.text.toLowerCase() : null

  if (last === undefined || lastKw === 'and' || lastKw === 'or' || last.kind === 'lparen') {
    // Field position. The element being edited goes last — self-reference is
    // legal but rarely what's wanted.
    const fields = [...elements].sort((a, b) => Number(a.id === selfId) - Number(b.id === selfId))
    items = fields
      .filter((e) => e.id !== '')
      .map((e) => ({
        insert: `${e.id} `,
        display: e.id,
        detail: e.label || undefined,
        kind: 'field' as const,
      }))
  } else if (last.kind === 'ident') {
    items = operatorSuggestions(byId.get(last.text))
  } else if (last.kind === 'op') {
    const f = done[done.length - 2]
    const el = f !== undefined && f.kind === 'ident' ? byId.get(f.text) : undefined
    items = valueSuggestions(el, last.text === '<>')
  } else if (lastKw === 'in') {
    items = [{ insert: '{', display: '{', detail: 'start the value set', kind: 'op' }]
  } else if (lastKw === 'contains') {
    items = valueSuggestions(fieldForValue(), false)
  } else if (last.kind === 'lbrace' || last.kind === 'comma') {
    // Inside an `in { … }` set: don't re-offer values already listed.
    const used = new Set<string>()
    for (let j = done.length - 1; j >= 0 && done[j].kind !== 'lbrace'; j--) {
      const t = done[j]
      if (t.kind === 'string') used.add(t.text.slice(1, -1))
      if (t.kind === 'number') used.add(t.text)
    }
    items = valueSuggestions(fieldForValue(), false).filter(
      (s) => !used.has(s.display.replace(/^"|"$/g, '')),
    )
  } else if (
    last.kind === 'string' ||
    last.kind === 'number' ||
    last.kind === 'rbrace' ||
    last.kind === 'rparen'
  ) {
    items = [
      { insert: 'and ', display: 'and', detail: 'both must hold', kind: 'kw' },
      { insert: 'or ', display: 'or', detail: 'either may hold', kind: 'kw' },
    ]
  }

  // Filter by the typed prefix — for values, the enum label matches too.
  const needle = (partialString ? partial.slice(1) : partial).toLowerCase()
  if (needle !== '') {
    items = items.filter(
      (s) =>
        s.display.toLowerCase().includes(needle) ||
        (s.detail !== undefined && s.detail.toLowerCase().includes(needle)),
    )
  }
  return { from, to: cursor, items }
}
