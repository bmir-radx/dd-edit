/** Typed client for the Python sidecar. All calls carry the bearer token. */
import type { DdDocument } from './types/document'

export interface SidecarInfo {
  url: string | null
  token: string | null
}

let infoPromise: Promise<SidecarInfo> | null = null

export function sidecarInfo(): Promise<SidecarInfo> {
  infoPromise ??= window.ddEdit.getSidecarInfo()
  return infoPromise
}

async function request<T>(path: string, body?: unknown): Promise<T> {
  const info = await sidecarInfo()
  if (!info.url) throw new Error('the sidecar is not running (see the main-process log)')
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (info.token) headers.Authorization = `Bearer ${info.token}`
  const res = await fetch(info.url + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const parsed = await res.json().catch(() => null)
  if (!res.ok) {
    const detail = parsed && typeof parsed.detail === 'string' ? parsed.detail : res.statusText
    throw new Error(detail)
  }
  return parsed as T
}

export type FindingLevel = 'ERROR' | 'WARNING' | 'INFO'

export interface Finding {
  level: FindingLevel
  check: string
  message: string
  /** 1-based line in the CSV serialization; data row i is line i + 2. */
  line: number | null
  /** CSV column header name (e.g. "Datatype"), when the finding is cell-scoped. */
  column: string | null
  value: string | null
}

/** Grid row index for a finding, or null for file-level findings. */
export function findingRow(f: Finding): number | null {
  return f.line !== null && f.line >= 2 ? f.line - 2 : null
}

export const sidecar = {
  health: () => request<{ status: string; versions: Record<string, string> }>('/health'),

  meta: () =>
    request<{ datatypes: string[]; cardinalities: string[] }>('/meta'),

  convert: (content: string, to: 'csv' | 'linkml' | 'json', compact = false) =>
    request<{ content: string; detected: string }>('/convert', { content, to, compact }),

  validate: (content: string) => request<{ findings: Finding[] }>('/validate', { content }),

  render: (content: string, title?: string) =>
    request<{ html: string }>('/render', { content, title }),

  importRedcap: (content: string, provenance = '') =>
    request<{ content: string; elements: number }>('/import/redcap', { content, provenance }),

  /** Resolve ontology terms to labels (OLS4, via the sidecar; needs network). */
  lookupTerms: (terms: string[]) =>
    request<{ labels: Record<string, string> }>('/terms', { terms }),
}

/** Parse any dictionary format (CSV / LinkML / dd-json) into a document. */
export async function parseToDocument(content: string): Promise<DdDocument> {
  const res = await sidecar.convert(content, 'json')
  return JSON.parse(res.content) as DdDocument
}

/** Serialize the document to the format implied by a file path's extension. */
export async function serializeForPath(doc: DdDocument, path: string): Promise<string> {
  const to = /\.ya?ml$/i.test(path) ? 'linkml' : /\.json$/i.test(path) ? 'json' : 'csv'
  const res = await sidecar.convert(JSON.stringify(doc), to)
  return res.content
}
