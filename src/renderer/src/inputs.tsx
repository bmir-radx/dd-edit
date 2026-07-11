/**
 * Commit-on-blur inputs for the inspector: local draft state while typing,
 * one store mutation (= one undo step) on blur or Enter, Escape reverts.
 * Without this, every keystroke would be an undo step.
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'

interface CommitProps {
  value: string
  onCommit: (value: string) => void
  placeholder?: string
  className?: string
}

export function CommitInput({ value, onCommit, placeholder, className }: CommitProps) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])

  const commit = () => {
    if (draft !== value) onCommit(draft)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
    if (e.key === 'Escape') setDraft(value)
  }
  return (
    <input
      type="text"
      className={className}
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={onKeyDown}
    />
  )
}

/**
 * Single-value field that WRAPS long text: a textarea styled as an input that
 * auto-grows to fit its content. Enter commits (blurs) rather than inserting a
 * newline — this is for one-line-ish values like a label, not prose. Escape
 * reverts.
 */
export function CommitWrapInput({ value, onCommit, placeholder, className }: CommitProps) {
  const [draft, setDraft] = useState(value)
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => setDraft(value), [value])

  // Grow to fit content (reset to auto first so it can also shrink).
  useLayoutEffect(() => {
    const el = ref.current
    if (el) {
      el.style.height = 'auto'
      el.style.height = `${el.scrollHeight}px`
    }
  }, [draft])

  return (
    <textarea
      ref={ref}
      className={`wrap-input${className ? ` ${className}` : ''}`}
      value={draft}
      rows={1}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== value) onCommit(draft)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          ;(e.target as HTMLTextAreaElement).blur()
        }
        if (e.key === 'Escape') setDraft(value)
      }}
    />
  )
}

export function CommitTextarea({ value, onCommit, placeholder, rows }: CommitProps & { rows?: number }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])

  return (
    <textarea
      value={draft}
      rows={rows}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== value) onCommit(draft)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') setDraft(value)
      }}
    />
  )
}

/**
 * Tag/chip editor for a list of short string values (aliases, terms,
 * examples). Each value is a removable chip; a trailing input adds one on
 * Enter or comma. Editing a chip's text is done by removing and re-adding —
 * fine for the short values these hold.
 */
export function TagEditor({
  values,
  onChange,
  placeholder,
  variant,
}: {
  values: string[]
  onChange: (values: string[]) => void
  placeholder?: string
  /** Chip color; 'violet' for ontology terms, default blue otherwise. */
  variant?: 'violet'
}) {
  const [draft, setDraft] = useState('')

  const add = () => {
    const v = draft.trim()
    if (v !== '' && !values.includes(v)) onChange([...values, v])
    setDraft('')
  }
  const removeAt = (i: number) => onChange(values.filter((_, j) => j !== i))

  const tagClass = `tag${variant === 'violet' ? ' violet' : ''}`
  return (
    <div className="tag-editor">
      {values.map((v, i) => (
        <span className={tagClass} key={`${v}-${i}`}>
          <span className="tag-text">{v}</span>
          <button type="button" className="tag-x" title="Remove" onClick={() => removeAt(i)}>
            ×
          </button>
        </span>
      ))}
      <input
        type="text"
        className="tag-input"
        value={draft}
        placeholder={values.length === 0 ? placeholder : ''}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={add}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault()
            add()
          } else if (e.key === 'Backspace' && draft === '' && values.length > 0) {
            removeAt(values.length - 1)
          } else if (e.key === 'Escape') {
            setDraft('')
          }
        }}
      />
    </div>
  )
}
