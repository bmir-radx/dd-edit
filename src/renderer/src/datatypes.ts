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
const XSD_INTEGERS = [
  'int', 'short', 'byte', 'long',
  'nonNegativeInteger', 'nonPositiveInteger', 'negativeInteger', 'positiveInteger',
  'unsignedLong', 'unsignedInt', 'unsignedShort', 'unsignedByte',
]
const XSD_STRINGS = [
  'normalizedString', 'token', 'language', 'Name', 'NCName', 'NMTOKEN', 'NMTOKENS', 'QName',
  'gYearMonth', 'gYear', 'gMonthDay', 'gDay', 'gMonth',
  'duration', 'hexBinary', 'base64Binary', 'NOTATION',
  'ID', 'IDREF', 'IDREFS', 'ENTITY', 'ENTITIES',
]

export const PREFERRED_DATATYPE: Record<string, string> = {
  ...Object.fromEntries(XSD_INTEGERS.map((n) => [n, 'integer'])),
  ...Object.fromEntries(XSD_STRINGS.map((n) => [n, 'string'])),
  date_mdy: 'date',
  date_dmy: 'date',
  timestamp: 'dateTime',
}

/** The preferred native equivalent, or null when the datatype already is one. */
export function preferredDatatype(datatype: string): string | null {
  if (datatype === '' || LINKML_NATIVE.has(datatype)) return null
  return PREFERRED_DATATYPE[datatype] ?? 'string'
}

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
