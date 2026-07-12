import { describe, expect, it } from 'vitest'
import { analyze, isOrderedDatatype, parse, suggest, tokenize } from './precondition'
import type { BoolNode, PredNode } from './precondition'
import type { DataElement } from './types/document'

// Minimal elements for the semantic checks and completions.
const el = (over: Partial<DataElement> & Pick<DataElement, 'id'>): DataElement =>
  ({
    label: '',
    datatype: 'string',
    cardinality: 'single',
    required: false,
    ...over,
  }) as DataElement

const ELEMENTS: DataElement[] = [
  el({ id: 'age', datatype: 'integer' }),
  el({
    id: 'sex',
    datatype: 'integer',
    enumeration: [
      { value: '1', label: 'Male', iri: null },
      { value: '2', label: 'Female', iri: null },
    ],
  }),
  el({
    id: 'symptoms',
    datatype: 'integer',
    cardinality: 'multiple',
    enumeration: [
      { value: '1', label: 'Fever', iri: null },
      { value: '2', label: 'Cough', iri: null },
      { value: '3', label: 'Fatigue', iri: null },
    ],
  }),
  el({ id: 'name', label: 'Full name' }),
]

// ---------------------------------------------------------------- tokenize

describe('tokenize', () => {
  it('classifies the token kinds', () => {
    const kinds = tokenize('f <> "x" and n >= 2 in { } ( ) ,').map((t) => t.kind)
    expect(kinds).toEqual([
      'ident', 'op', 'string', 'kw', 'ident', 'op', 'number',
      'kw', 'lbrace', 'rbrace', 'lparen', 'rparen', 'comma',
    ])
  })

  it('lexes two-character operators as one token', () => {
    expect(tokenize('a <= 1')[1]).toMatchObject({ kind: 'op', text: '<=' })
    expect(tokenize('a <> ""')[1]).toMatchObject({ kind: 'op', text: '<>' })
  })

  it('treats keywords case-insensitively', () => {
    expect(tokenize('a = 1 AND b = 2')[3]).toMatchObject({ kind: 'kw', text: 'AND' })
  })

  it('marks an unterminated string as an error token', () => {
    const tokens = tokenize('f = "abc')
    expect(tokens[tokens.length - 1].kind).toBe('error')
  })

  it('records source positions', () => {
    const [f, op] = tokenize('age >= 18')
    expect([f.start, f.end]).toEqual([0, 3])
    expect([op.start, op.end]).toEqual([4, 6])
  })
})

// -------------------------------------------------------------------- parse

describe('parse', () => {
  it('parses a comparison predicate', () => {
    const result = parse('age >= 18')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.ast).toMatchObject({
      kind: 'pred',
      field: 'age',
      op: '>=',
      values: [{ value: '18', quoted: false }],
    })
  })

  it('parses a quoted equality and unquotes the value', () => {
    const result = parse('sex = "1"')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect((result.ast as PredNode).values[0]).toMatchObject({
      raw: '"1"',
      value: '1',
      quoted: true,
    })
  })

  it('parses an in-set with all its values', () => {
    const result = parse('sex in {"1", "2"}')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const pred = result.ast as PredNode
    expect(pred.op).toBe('in')
    expect(pred.values.map((v) => v.value)).toEqual(['1', '2'])
  })

  it('parses contains', () => {
    const result = parse('symptoms contains "3"')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect((result.ast as PredNode).op).toBe('contains')
  })

  it('binds and tighter than or', () => {
    const result = parse('a = "1" or b = "2" and c = "3"')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const root = result.ast as BoolNode
    expect(root.op).toBe('or')
    expect(root.parts).toHaveLength(2)
    expect((root.parts[1] as BoolNode)).toMatchObject({ kind: 'bool', op: 'and' })
  })

  it('parses parentheses as a group that overrides precedence', () => {
    const result = parse('(a = "1" or b = "2") and c = "3"')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const root = result.ast as BoolNode
    expect(root.op).toBe('and')
    expect(root.parts[0]).toMatchObject({ kind: 'group' })
  })

  it.each([
    ['', 'expected a field Id'],
    ['= "1"', 'expected a field Id'],
    ['age', 'expected an operator'],
    ['age =', 'expected a value'],
    ['age = "abc', 'unterminated string'],
    ['sex in "1"', 'expected {'],
    ['sex in {"1" "2"}', 'expected , or }'],
    ['(a = "1"', 'expected )'],
    ['a = "1" b', 'expected and / or'],
  ])('rejects %j with %j', (text, message) => {
    const result = parse(text)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain(message)
  })

  it('reports the position of the offending token', () => {
    const result = parse('a = "1" b')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.pos).toBe(8)
  })
})

// ------------------------------------------------------------------ analyze

const analyzed = (text: string) => {
  const result = parse(text)
  if (!result.ok) throw new Error(`parse failed: ${result.message}`)
  return analyze(result.ast, ELEMENTS).map((w) => w.message)
}

describe('analyze', () => {
  it('accepts a well-formed condition without warnings', () => {
    expect(analyzed('sex = "1" and age >= 18')).toEqual([])
  })

  it('warns about an unknown field Id', () => {
    expect(analyzed('agee = "1"').join()).toContain('not a field Id')
  })

  it('warns about ordering operators on unordered datatypes', () => {
    expect(analyzed('name > "a"').join()).toContain('needs an ordered datatype')
    expect(analyzed('age > 18')).toEqual([])
  })

  it('warns about contains on a single-cardinality field', () => {
    expect(analyzed('sex contains "1"').join()).toContain('needs Cardinality multiple')
    expect(analyzed('symptoms contains "1"')).toEqual([])
  })

  it('warns about values outside an enumeration', () => {
    expect(analyzed('sex = "5"').join()).toContain("not in sex's enumeration")
    expect(analyzed('sex in {"1", "9"}').join()).toContain('9')
  })

  it('never warns about the blank test <> ""', () => {
    expect(analyzed('sex <> ""')).toEqual([])
    expect(analyzed('name <> ""')).toEqual([])
  })

  it('checks literal shape against the datatype when there is no enumeration', () => {
    expect(analyzed('age = "abc"').join()).toContain('an integer')
    expect(analyzed('age = "18"')).toEqual([])
  })

  it('reports a repeated problem once', () => {
    expect(analyzed('sex = "5" or sex = "5"')).toHaveLength(1)
  })
})

// ------------------------------------------------------------------ suggest

const displays = (text: string, cursor = text.length, selfId?: string) =>
  suggest(text, cursor, ELEMENTS, selfId).items.map((s) => s.display)

describe('suggest', () => {
  it('offers field Ids at the start, with the edited element last', () => {
    const items = suggest('', 0, ELEMENTS, 'age').items
    expect(items.map((s) => s.display)).toContain('age')
    expect(items[items.length - 1].display).toBe('age')
    expect(items[0].display).not.toBe('age')
  })

  it('filters fields by the typed prefix and reports the replace range', () => {
    const result = suggest('ag', 2, ELEMENTS)
    expect(result.from).toBe(0)
    expect(result.to).toBe(2)
    expect(result.items.map((s) => s.display)).toEqual(['age'])
  })

  it('offers ordering operators only for ordered datatypes', () => {
    expect(displays('age ')).toEqual(expect.arrayContaining(['=', '<>', '<', '>=']))
    expect(displays('name ')).not.toContain('<')
  })

  it('offers contains only for multiple-cardinality fields', () => {
    expect(displays('symptoms ')).toContain('contains')
    expect(displays('name ')).not.toContain('contains')
  })

  it('offers the enumeration values after an operator', () => {
    const items = suggest('sex = ', 6, ELEMENTS).items
    expect(items.map((s) => s.display)).toEqual(['"1"', '"2"'])
    expect(items[0].detail).toBe('Male')
  })

  it('offers the blank test only after <>', () => {
    expect(displays('sex <> ')).toContain('""')
    expect(displays('sex = ')).not.toContain('""')
  })

  it('matches enum values by their label while typing', () => {
    expect(displays('sex = "Fe')).toEqual(['"2"'])
  })

  it('does not re-offer values already used in an in-set', () => {
    expect(displays('symptoms in {"1", ')).toEqual(['"2"', '"3"'])
  })

  it('offers and / or after a complete predicate', () => {
    expect(displays('sex = "1" ')).toEqual(['and', 'or'])
    expect(displays('age >= 18 ')).toEqual(['and', 'or'])
  })

  it('offers fields again after and / or and after an open parenthesis', () => {
    expect(displays('sex = "1" and ')).toContain('age')
    expect(displays('(')).toContain('age')
  })
})

// --------------------------------------------------------- isOrderedDatatype

describe('isOrderedDatatype', () => {
  it.each(['integer', 'int', 'decimal', 'float', 'date', 'dateTime', 'time', 'gYear'])(
    'treats %s as ordered',
    (dt) => expect(isOrderedDatatype(dt)).toBe(true),
  )

  it.each(['string', 'boolean', 'anyURI', ''])('treats %s as unordered', (dt) =>
    expect(isOrderedDatatype(dt)).toBe(false),
  )
})
