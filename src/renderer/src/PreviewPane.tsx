/**
 * Live serialization preview (CSV, LinkML YAML, or rendered HTML): debounced
 * conversion via the sidecar. On conversion failure (documents are transiently
 * invalid mid-edit) the last-good output stays visible under an error banner.
 * Conversion pauses while the pane is hidden (enabled=false).
 *
 * When rows are selected in the grid, the preview scopes to just those
 * elements (a sub-document), with a banner noting the scope.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useEditor } from './model/store'
import { sidecar } from './sidecar'
import type { DdDocument } from './types/document'
import { highlightYaml } from './yamlHighlight'

/**
 * Minimal RFC-4180 CSV parse (quoted fields, escaped quotes, newlines inside
 * quotes) — just enough to show the serializer's own output as a table.
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else {
      field += ch
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((r) => r.length > 1 || r[0] !== '')
}

/**
 * The CSV serialization as a table: header row sticky, a line-number gutter
 * matching the actual CSV line (header = 1, so numbers line up with what the
 * validator reports), empty cells left blank.
 */
function CsvTable({ text, stale }: { text: string; stale: boolean }) {
  const rows = useMemo(() => parseCsv(text), [text])
  const [header, ...body] = rows
  if (!header) return <div className="csv-empty">Nothing to preview.</div>
  return (
    <div className={`csv-scroll${stale ? ' stale' : ''}`}>
      <table className="csv-table">
        <thead>
          <tr>
            <th className="line-no">1</th>
            {header.map((h, i) => (
              <th key={i}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((r, i) => (
            <tr key={i}>
              <td className="line-no">{i + 2}</td>
              {header.map((_, j) => (
                <td key={j}>{r[j] ?? ''}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function PreviewPane({
  format,
  enabled,
  title,
  selectedRows,
}: {
  format: 'csv' | 'linkml' | 'html'
  enabled: boolean
  title?: string
  selectedRows: number[]
}) {
  const doc = useEditor((s) => s.doc)
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)

  // Scope to the selection when there is one (2+ rows, or a single row is
  // still a useful focus); otherwise the whole document.
  const scoped: DdDocument = useMemo(() => {
    if (selectedRows.length === 0) return doc
    const elements = selectedRows.map((r) => doc.elements[r]).filter(Boolean)
    return { ...doc, elements }
  }, [doc, selectedRows])

  const scoping = selectedRows.length > 0

  useEffect(() => {
    if (!enabled) return
    const mine = ++generation.current
    const timer = setTimeout(async () => {
      try {
        const payload = JSON.stringify(scoped)
        const content =
          format === 'html'
            ? (await sidecar.render(payload, title)).html
            : (await sidecar.convert(payload, format)).content
        if (generation.current !== mine) return // a newer edit superseded us
        setText(content)
        setError(null)
      } catch (e) {
        if (generation.current !== mine) return
        setError(e instanceof Error ? e.message : String(e)) // keep last-good text
      }
    }, 300)
    return () => clearTimeout(timer)
  }, [scoped, format, enabled, title])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minWidth: 0, overflow: 'hidden' }}>
      {scoping ? (
        <div className="scope-banner">
          Showing {selectedRows.length} selected {selectedRows.length === 1 ? 'element' : 'elements'}
          {' · '}
          <span className="hint">clear the selection for the whole dictionary</span>
        </div>
      ) : null}
      {error ? <div className="error-banner">{error}</div> : null}
      {format === 'html' ? (
        <iframe
          sandbox=""
          srcDoc={text}
          title="Rendered dictionary"
          style={{
            flex: 1,
            width: '100%',
            border: 'none',
            opacity: error ? 0.5 : 1,
            background: '#fff',
          }}
        />
      ) : format === 'csv' ? (
        <CsvTable text={text} stale={error !== null} />
      ) : (
        <div className="yaml-scroll">
          <pre className={`preview yaml${error ? ' stale' : ''}`}>{highlightYaml(text)}</pre>
        </div>
      )}
    </div>
  )
}
