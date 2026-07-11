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
      ) : (
        <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
          <pre className={`preview${error ? ' stale' : ''}`}>
            {format === 'linkml' ? highlightYaml(text) : text}
          </pre>
        </div>
      )}
    </div>
  )
}
