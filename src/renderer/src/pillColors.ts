/**
 * Shared pill palette for the categorical columns (datatype, cardinality),
 * used both by the grid's canvas pills and the inspector's select styling so
 * the two always match.
 */
export interface PillColor {
  bg: string
  fg: string
}

/** Datatype families get a hue so a column of types is scannable at a glance. */
export function datatypePill(datatype: string): PillColor {
  const s = datatype.toLowerCase()
  if (/(int|float|decimal|double|number)/.test(s)) return { bg: '#dbeafe', fg: '#1d4ed8' } // numeric
  if (/(date|time|year)/.test(s)) return { bg: '#ede9fe', fg: '#6d28d9' } // temporal
  if (/bool/.test(s)) return { bg: '#d1fae5', fg: '#047857' } // boolean
  if (/(url|iri|uri|email|phone|zip|sha|mime)/.test(s)) return { bg: '#cffafe', fg: '#0e7490' } // coded
  return { bg: '#f1f5f9', fg: '#475569' } // text / other
}

/** Pill colors for the categorical columns. */
export function pillColors(key: 'cardinality' | 'datatype', text: string): PillColor {
  if (key === 'datatype') return datatypePill(text)
  return text === 'multiple' ? { bg: '#ede9fe', fg: '#6d28d9' } : { bg: '#f1f5f9', fg: '#475569' }
}
