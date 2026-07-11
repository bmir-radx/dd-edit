/**
 * Live CSV preview: debounced conversion of the document via /convert.
 * On conversion failure (documents are transiently invalid mid-edit) the
 * last-good output stays visible under an error banner.
 */
import { useEffect, useRef, useState } from 'react'
import { useEditor } from './model/store'
import { sidecar } from './sidecar'

export function PreviewPane() {
  const doc = useEditor((s) => s.doc)
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)

  useEffect(() => {
    const mine = ++generation.current
    const timer = setTimeout(async () => {
      try {
        const res = await sidecar.convert(JSON.stringify(doc), 'csv')
        if (generation.current !== mine) return // a newer edit superseded us
        setText(res.content)
        setError(null)
      } catch (e) {
        if (generation.current !== mine) return
        setError(e instanceof Error ? e.message : String(e)) // keep last-good text
      }
    }, 300)
    return () => clearTimeout(timer)
  }, [doc])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minWidth: 0 }}>
      <div style={{ padding: '4px 8px', fontSize: 12, color: '#555', borderBottom: '1px solid #ddd' }}>
        CSV preview
      </div>
      {error ? (
        <div style={{ padding: '4px 8px', fontSize: 12, color: '#fff', background: '#c0392b' }}>
          {error}
        </div>
      ) : null}
      <pre
        style={{
          flex: 1,
          margin: 0,
          padding: 8,
          overflow: 'auto',
          fontSize: 12,
          fontFamily: 'ui-monospace, monospace',
          background: '#fafafa',
          opacity: error ? 0.5 : 1,
        }}
      >
        {text}
      </pre>
    </div>
  )
}
