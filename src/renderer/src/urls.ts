/** Whether a string parses as an absolute http(s) URL with a real host.
 *
 * Shared by the inspector's See-also assist (warning + https:// fix) and the
 * grid's see_also link cells (only real URLs get the link affordance).
 */
export function isAbsoluteHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname.includes('.')
  } catch {
    return false
  }
}
