/**
 * Commit-on-blur inputs for the inspector: local draft state while typing,
 * one store mutation (= one undo step) on blur or Enter, Escape reverts.
 * Without this, every keystroke would be an undo step.
 */
import { useEffect, useState, type KeyboardEvent } from 'react'

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
