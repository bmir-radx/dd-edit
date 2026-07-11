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

export const sidecar = {
  health: () => request<{ status: string; versions: Record<string, string> }>('/health'),

  meta: () =>
    request<{ datatypes: string[]; cardinalities: string[] }>('/meta'),

  convert: (content: string, to: 'csv' | 'linkml' | 'json', compact = false) =>
    request<{ content: string; detected: string }>('/convert', { content, to, compact }),

  importRedcap: (content: string, provenance = '') =>
    request<{ content: string; elements: number }>('/import/redcap', { content, provenance }),
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
