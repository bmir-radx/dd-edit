/**
 * Live serialization preview (CSV or LinkML YAML): debounced conversion of the
 * document via /convert. On conversion failure (documents are transiently
 * invalid mid-edit) the last-good output stays visible under an error banner.
 * Conversion pauses while the pane is hidden (enabled=false).
 */
import { useEffect, useRef, useState } from 'react'
import { useEditor } from './model/store'
import { sidecar } from './sidecar'

export function PreviewPane({
  format,
  enabled,
  title,
}: {
  format: 'csv' | 'linkml' | 'html'
  enabled: boolean
  title?: string
}) {
  const doc = useEditor((s) => s.doc)
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)

  useEffect(() => {
    if (!enabled) return
    const mine = ++generation.current
    const timer = setTimeout(async () => {
      try {
        const payload = JSON.stringify(doc)
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
  }, [doc, format, enabled, title])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {error ? <div className="error-banner">{error}</div> : null}
      {format === 'html' ? (
        <iframe
          sandbox=""
          srcDoc={text}
          title="Rendered dictionary"
          style={{ flex: 1, border: 'none', opacity: error ? 0.5 : 1, background: '#fff' }}
        />
      ) : (
        <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
          <pre className={`preview${error ? ' stale' : ''}`}>{text}</pre>
        </div>
      )}
    </div>
  )
}
