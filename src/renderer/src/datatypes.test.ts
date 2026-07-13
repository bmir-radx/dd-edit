import { describe, expect, it } from 'vitest'
import { HARMONIZATION_TARGET, LINKML_NATIVE, needsIntegerDatatype, preferredDatatype } from './datatypes'

describe('preferredDatatype', () => {
  it('returns null for LinkML-native datatypes', () => {
    for (const dt of ['string', 'integer', 'decimal', 'boolean', 'date', 'dateTime']) {
      expect(preferredDatatype(dt)).toBeNull()
    }
  })

  it('returns null for an empty datatype', () => {
    expect(preferredDatatype('')).toBeNull()
  })

  it('folds XSD integer flavors into integer', () => {
    for (const dt of ['int', 'short', 'long', 'nonNegativeInteger', 'unsignedByte']) {
      expect(preferredDatatype(dt)).toBe('integer')
    }
  })

  it('folds XSD string flavors into string', () => {
    for (const dt of ['token', 'normalizedString', 'NMTOKENS', 'gYear', 'hexBinary']) {
      expect(preferredDatatype(dt)).toBe('string')
    }
  })

  it('leaves the REDCap formats to HARMONIZATION_TARGET — no free rename', () => {
    // date_mdy truthfully describes mm/dd/yyyy source data: renaming the
    // dictionary alone would make it lie, so these are harmonization
    // recommendations, not preferences.
    expect(preferredDatatype('date_mdy')).toBeNull()
    expect(HARMONIZATION_TARGET['date_mdy']).toBe('date')
    expect(HARMONIZATION_TARGET['date_dmy']).toBe('date')
    expect(HARMONIZATION_TARGET['timestamp']).toBe('dateTime')
  })

  it('falls back to string for unknown custom names', () => {
    expect(preferredDatatype('zipcode')).toBe('string')
  })

  it('every suggested target is itself native', () => {
    // The fix button applies preferredDatatype's result; it must never
    // suggest a datatype that would itself get flagged. Harmonization
    // targets get no button but must satisfy the same invariant.
    for (const dt of ['int', 'token']) {
      expect(LINKML_NATIVE.has(preferredDatatype(dt)!)).toBe(true)
    }
    for (const target of Object.values(HARMONIZATION_TARGET)) {
      expect(LINKML_NATIVE.has(target)).toBe(true)
    }
  })
})

describe('needsIntegerDatatype', () => {
  const el = (datatype: string, values: string[]) => ({
    datatype,
    enumeration: values.map((value) => ({ value })),
  })

  it('is true when every enumeration value is an integer but the datatype is not', () => {
    expect(needsIntegerDatatype(el('string', ['0', '1', '2']))).toBe(true)
  })

  it('accepts negative values and surrounding whitespace', () => {
    expect(needsIntegerDatatype(el('string', ['-99', ' 2 ']))).toBe(true)
  })

  it('is false without an enumeration', () => {
    expect(needsIntegerDatatype({ datatype: 'string' })).toBe(false)
    expect(needsIntegerDatatype({ datatype: 'string', enumeration: [] })).toBe(false)
    expect(needsIntegerDatatype({ datatype: 'string', enumeration: null })).toBe(false)
  })

  it('is false when the datatype is already integer-flavored', () => {
    expect(needsIntegerDatatype(el('integer', ['0', '1']))).toBe(false)
    expect(needsIntegerDatatype(el('int', ['0', '1']))).toBe(false)
    expect(needsIntegerDatatype(el('nonNegativeInteger', ['0', '1']))).toBe(false)
  })

  it('is false when any value is not an integer', () => {
    expect(needsIntegerDatatype(el('string', ['0', 'x']))).toBe(false)
    expect(needsIntegerDatatype(el('string', ['1.5']))).toBe(false)
    expect(needsIntegerDatatype(el('string', ['']))).toBe(false)
  })
})
