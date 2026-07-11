/**
 * Milestone-1 skeleton: prove the Electron <-> sidecar pipe end to end.
 * Shows the toolkit versions from /health, the datatypes from /meta, and a
 * live CSV -> dd-json conversion through /convert. The real editor replaces
 * this screen in milestone 2.
 */
import { useEffect, useState } from 'react'

interface SidecarInfo {
  url: string | null
  token: string | null
}

declare global {
  interface Window {
    ddEdit: { getSidecarInfo: () => Promise<SidecarInfo> }
  }
}

const SAMPLE_CSV = `Id,Label,Datatype,Cardinality,Enumeration,Unit
age,Age,integer,single,,years
sex,Sex at birth,integer,single,"""1""=[Male] | ""2""=[Female]",
`

export function App() {
  const [info, setInfo] = useState<SidecarInfo | null>(null)
  const [versions, setVersions] = useState<Record<string, string>>({})
  const [datatypes, setDatatypes] = useState<string[]>([])
  const [csv, setCsv] = useState(SAMPLE_CSV)
  const [json, setJson] = useState('')
  const [error, setError] = useState<string | null>(null)

  const headers = (i: SidecarInfo): HeadersInit =>
    i.token ? { Authorization: `Bearer ${i.token}`, 'Content-Type': 'application/json' }
            : { 'Content-Type': 'application/json' }

  useEffect(() => {
    ;(async () => {
      try {
        const i = await window.ddEdit.getSidecarInfo()
        if (!i.url) throw new Error('sidecar failed to start (see main-process log)')
        setInfo(i)
        const health = await (await fetch(`${i.url}/health`)).json()
        setVersions(health.versions)
        const meta = await (await fetch(`${i.url}/meta`, { headers: headers(i) })).json()
        setDatatypes(meta.datatypes)
      } catch (e) {
        setError(String(e))
      }
    })()
  }, [])

  useEffect(() => {
    if (!info?.url) return
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`${info.url}/convert`, {
          method: 'POST',
          headers: headers(info),
          body: JSON.stringify({ content: csv, to: 'json', compact: true }),
        })
        const body = await res.json()
        if (!res.ok) throw new Error(body.detail ?? res.statusText)
        setJson(body.content)
        setError(null)
      } catch (e) {
        setError(String(e)) // keep last-good JSON visible
      }
    }, 300)
    return () => clearTimeout(t)
  }, [csv, info])

  return (
    <main style={{ fontFamily: 'system-ui', margin: '2rem', maxWidth: 960 }}>
      <h1>dd-edit</h1>
      <p>
        Sidecar:{' '}
        {info?.url ? (
          <>
            <code>{info.url}</code> — {Object.entries(versions).map(([k, v]) => `${k} ${v}`).join(' · ')}
            <br />
            {datatypes.length} datatypes loaded for the editor
          </>
        ) : (
          'starting…'
        )}
      </p>
      {error ? <p style={{ color: 'crimson' }}>{error}</p> : null}
      <div style={{ display: 'flex', gap: '1rem' }}>
        <label style={{ flex: 1 }}>
          CSV (editable — live round-trip demo)
          <textarea
            value={csv}
            onChange={(e) => setCsv(e.target.value)}
            rows={14}
            style={{ width: '100%', fontFamily: 'monospace' }}
          />
        </label>
        <label style={{ flex: 1 }}>
          dd-json (via /convert)
          <textarea value={json} readOnly rows={14} style={{ width: '100%', fontFamily: 'monospace' }} />
        </label>
      </div>
    </main>
  )
}
