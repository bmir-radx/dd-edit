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
  /** id of a <datalist> for native autocomplete suggestions. */
  list?: string
}

export function CommitInput({ value, onCommit, placeholder, className, list }: CommitProps) {
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
      list={list}
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
 * List editor for a list of plain string values (aliases): one editable text
 * row per value (commit-on-blur, so one undo step per edit), a remove button
 * per row, and an add-row button. Committing a row as empty removes it.
 */
export function StringListEditor({
  values,
  onChange,
  placeholder,
  addLabel,
}: {
  values: string[]
  onChange: (values: string[]) => void
  placeholder?: string
  addLabel: string
}) {
  const update = (i: number, v: string) => {
    const text = v.trim()
    onChange(
      text === '' ? values.filter((_, j) => j !== i) : values.map((old, j) => (j === i ? text : old)),
    )
  }
  const remove = (i: number) => onChange(values.filter((_, j) => j !== i))

  return (
    <div>
      {values.map((v, i) => (
        <div className="list-item" key={i}>
          <CommitInput value={v} placeholder={placeholder} onCommit={(next) => update(i, next)} />
          <button className="remove" title="Remove" onClick={() => remove(i)}>×</button>
        </div>
      ))}
      <button className="add-item" onClick={() => onChange([...values, ''])}>
        {addLabel}
      </button>
    </div>
  )
}

