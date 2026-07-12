/**
 * Id hygiene. The spec allows any characters in an Id (including spaces),
 * but an id with spaces / special characters is degraded everywhere else:
 * the LinkML emitter renames it (its sanitize rule, mirrored here), and the
 * precondition grammar cannot reference it. The editor warns and offers the
 * sanitized form; it never blocks the value.
 */

/** The LinkML emitter's rename for this id (dd_linkml emit._sanitize). */
export function sanitizeId(id: string): string {
  let safe = id
    .trim()
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
  if (safe === '') safe = '_'
  if (/^\d/.test(safe)) safe = `x_${safe}`
  return safe
}

/** True when schema renderings would rename this id. */
export function idNeedsCleanup(id: string): boolean {
  return id !== '' && sanitizeId(id) !== id
}
