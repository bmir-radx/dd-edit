/**
 * Datatype preferences for the editor: which datatype names are the
 * LinkML-native ones (they render as plain ranges, not generated custom
 * types), and the preferred native equivalent for the rest. Mirrors the
 * toolkit's BUILTIN_RANGES / CUSTOM_TYPES tables.
 */

/** Names that are (or map 1:1 onto) LinkML built-in ranges. */
export const LINKML_NATIVE = new Set([
  'string',
  'integer',
  'decimal',
  'float',
  'double',
  'boolean',
  'date',
  'dateTime',
  'time',
  'anyURI',
])

/**
 * Preferred native datatype for everything else. XSD integer flavors fold
 * into integer, string flavors into string; the extension date formats map
 * to their semantic native type. Every non-native name has an entry, so the
 * inspector can always say what it would rather see.
 */
// Aliases map onto a builtin range 1:1 — the name only records storage width
// or lexical class (int vs integer), and the schema silently uses the
// semantic type anyway.
const XSD_INTEGERS = [
  'int', 'short', 'byte', 'long',
  'nonNegativeInteger', 'nonPositiveInteger', 'negativeInteger', 'positiveInteger',
  'unsignedLong', 'unsignedInt', 'unsignedShort', 'unsignedByte',
]
const XSD_STRING_ALIASES = [
  'normalizedString', 'token', 'language', 'Name', 'NCName', 'NMTOKEN', 'NMTOKENS', 'QName',
]
export const ALIAS_DATATYPES = new Set([...XSD_INTEGERS, ...XSD_STRING_ALIASES])

// These have no builtin range: the schema emits a generated custom type.
const XSD_CUSTOM_STRINGS = [
  'gYearMonth', 'gYear', 'gMonthDay', 'gDay', 'gMonth',
  'duration', 'hexBinary', 'base64Binary', 'NOTATION',
  'ID', 'IDREF', 'IDREFS', 'ENTITY', 'ENTITIES',
]
const XSD_STRINGS = [...XSD_STRING_ALIASES, ...XSD_CUSTOM_STRINGS]

export const PREFERRED_DATATYPE: Record<string, string> = {
  ...Object.fromEntries(XSD_INTEGERS.map((n) => [n, 'integer'])),
  ...Object.fromEntries(XSD_STRINGS.map((n) => [n, 'string'])),
}

/**
 * REDCap-style source formats and their harmonized targets. UNLIKE the pure
 * renames above, these truthfully describe the datafile as it is (mm/dd/yyyy
 * strings, Unix seconds) — changing the dictionary alone would make it lie,
 * so the UI states the recommendation without offering a one-click.
 */
export const HARMONIZATION_TARGET: Record<string, { target: string; example: string }> = {
  date_mdy: { target: 'date', example: '05/27/2014 becomes 2014-05-27' },
  date_dmy: { target: 'date', example: '27/05/2014 becomes 2014-05-27' },
  timestamp: { target: 'dateTime', example: '1401148800 becomes 2014-05-27T00:00:00Z' },
}

/**
 * The preferred native equivalent for a free rename, or null — when the
 * datatype already is native, or when it's a harmonization format (renaming
 * those is a data migration, HARMONIZATION_TARGET's business).
 */
export function preferredDatatype(datatype: string): string | null {
  if (datatype === '' || LINKML_NATIVE.has(datatype)) return null
  if (HARMONIZATION_TARGET[datatype] !== undefined) return null
  return PREFERRED_DATATYPE[datatype] ?? 'string'
}

/** Numeric datatypes (integer + real families), for the missing-unit nudge. */
export function isNumericDatatype(datatype: string): boolean {
  return (
    ['integer', 'decimal', 'float', 'double'].includes(datatype) ||
    PREFERRED_DATATYPE[datatype] === 'integer'
  )
}

/**
 * True for a numeric, non-enumerated field with no unit — the shared
 * predicate behind the inspector's quiet unit nudge and the grid's gray ⓘ.
 * A nudge, not a problem: counts and scores are legitimately unitless.
 */
export function wantsUnit(element: {
  datatype: string
  unit?: string | null
  enumeration?: readonly unknown[] | null
}): boolean {
  return (
    (element.unit ?? '').trim() === '' &&
    (element.enumeration ?? []).length === 0 &&
    isNumericDatatype(element.datatype)
  )
}

/** The nudge's wording, shared by the inspector hint and the grid tooltip. */
export const UNIT_NUDGE =
  'Numeric field with no unit — consider a UCUM unit, or 1 (dimensionless) for counts and scores.'

/**
 * True when every enumeration value parses as an integer but the element's
 * datatype isn't integer-flavored — the "should this be integer?" fix that
 * both the inspector hint and the grid's datatype-cell pill offer.
 */
export function needsIntegerDatatype(element: {
  datatype: string
  enumeration?: readonly { value: string }[] | null
}): boolean {
  const items = element.enumeration ?? []
  if (items.length === 0) return false
  if (element.datatype === 'integer' || PREFERRED_DATATYPE[element.datatype] === 'integer') {
    return false
  }
  return items.every((i) => /^-?\d+$/.test(i.value.trim()))
}
