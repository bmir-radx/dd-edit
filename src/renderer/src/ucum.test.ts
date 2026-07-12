import { describe, expect, it } from 'vitest'
import { UCUM_UNITS, ucumSuggestion, ucumUnit } from './ucum'

describe('ucumUnit', () => {
  it('finds an exact code', () => {
    expect(ucumUnit('mL')?.name).toBe('milliliter')
    expect(ucumUnit('mm[Hg]')?.name).toBe('millimeter of mercury')
  })

  it('is case-sensitive, as UCUM is', () => {
    expect(ucumUnit('ml')).toBeUndefined()
  })

  it('tolerates surrounding whitespace', () => {
    expect(ucumUnit(' kg ')?.name).toBe('kilogram')
  })

  it('has no duplicate codes in the curated list', () => {
    const codes = UCUM_UNITS.map((u) => u.code)
    expect(new Set(codes).size).toBe(codes.length)
  })
})

describe('ucumSuggestion', () => {
  it('maps informal spellings to their UCUM code', () => {
    expect(ucumSuggestion('years')?.code).toBe('a')
    expect(ucumSuggestion('mmHg')?.code).toBe('mm[Hg]')
    expect(ucumSuggestion('bpm')?.code).toBe('{beats}/min')
    expect(ucumSuggestion('cc')?.code).toBe('mL')
  })

  it('is case-insensitive on the informal side', () => {
    expect(ucumSuggestion('Years')?.code).toBe('a')
    expect(ucumSuggestion('MMHG')?.code).toBe('mm[Hg]')
  })

  it('suggests the case fix for lowercased codes', () => {
    expect(ucumSuggestion('ml')?.code).toBe('mL')
    expect(ucumSuggestion('mg/dl')?.code).toBe('mg/dL')
  })

  it('returns null for a value that is already the suggested code', () => {
    // 'mL' lowercases onto the same mapping — no self-suggestion.
    expect(ucumSuggestion('mL')).toBeNull()
  })

  it('returns null for unknown spellings and blank input', () => {
    expect(ucumSuggestion('furlongs')).toBeNull()
    expect(ucumSuggestion('')).toBeNull()
    expect(ucumSuggestion('   ')).toBeNull()
  })

  it('carries the human-readable name for display', () => {
    expect(ucumSuggestion('years')?.name).toBe('year')
  })

  it('every informal mapping target resolves to a curated unit or itself', () => {
    // A suggestion always renders with a name; the fallback path
    // ({ code, name: code }) is only for codes outside the curated list.
    const suggestion = ucumSuggestion('iu')
    expect(suggestion?.code).toBe('[IU]')
    expect(suggestion?.name).toBeTruthy()
  })
})
