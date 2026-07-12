/**
 * The precondition editor: a commit-on-blur input with context-aware
 * type-ahead over the spec's precondition grammar, plus a live visual
 * read-back underneath — the parsed expression as chips (field Ids, operators
 * in words, enum values resolved to their labels), or the parse error, with
 * semantic warnings from the open document.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { analyze, parse, suggest, type ExprNode, type Suggestion } from './precondition'
import type { DataElement, EnumItem } from './types/document'

const OP_WORDS: Record<string, string> = {
  '=': 'is',
  '<>': 'is not',
  in: 'is one of',
  contains: 'contains',
  '<': '<',
  '<=': '≤',
  '>': '>',
  '>=': '≥',
}

export function PreconditionField({
  value,
  onCommit,
  elements,
  selfId,
}: {
  value: string
  onCommit: (value: string) => void
  elements: readonly DataElement[]
  selfId?: string
}) {
  const [draft, setDraft] = useState(value)
  const [cursor, setCursor] = useState(value.length)
  const [open, setOpen] = useState(false)
  const [hi, setHi] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const hiRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    setDraft(value)
  }, [value])
  useEffect(() => {
    hiRef.current?.scrollIntoView({ block: 'nearest' })
  }, [hi, open])

  const completions = useMemo(
    () => suggest(draft, cursor, elements, selfId),
    [draft, cursor, elements, selfId],
  )
  const items = completions.items.slice(0, 40)

  const accept = (s: Suggestion) => {
    const next = draft.slice(0, completions.from) + s.insert + draft.slice(completions.to)
    const pos = completions.from + s.insert.length
    setDraft(next)
    setCursor(pos)
    setHi(0)
    requestAnimationFrame(() => {
      const el = inputRef.current
      if (el) {
        el.focus()
        el.setSelectionRange(pos, pos)
      }
    })
  }

  const commit = () => {
    setOpen(false)
    const v = draft.trim()
    if (v !== value) onCommit(v)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (open && items.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setHi((h) => (h + 1) % items.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setHi((h) => (h - 1 + items.length) % items.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        accept(items[Math.min(hi, items.length - 1)])
        return
      }
      if (e.key === 'Escape') {
        setOpen(false)
        return
      }
    }
    if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
    if (e.key === 'Escape') setDraft(value)
  }

  const trimmed = draft.trim()
  const parsed = useMemo(() => (trimmed === '' ? null : parse(trimmed)), [trimmed])
  const byId = useMemo(() => new Map(elements.map((e) => [e.id, e])), [elements])
  const warnings = parsed !== null && parsed.ok ? analyze(parsed.ast, elements) : []

  return (
    <div className="pc-wrap">
      <input
        ref={inputRef}
        type="text"
        className="mono"
        value={draft}
        placeholder='e.g. consented = "1" and age >= 18'
        onChange={(e) => {
          setDraft(e.target.value)
          setCursor(e.target.selectionStart ?? e.target.value.length)
          setOpen(true)
          setHi(0)
        }}
        onSelect={(e) => setCursor((e.target as HTMLInputElement).selectionStart ?? 0)}
        onFocus={() => setOpen(true)}
        onBlur={commit}
        onKeyDown={onKeyDown}
      />
      {open && items.length > 0 ? (
        <div className="pc-suggest">
          {items.map((s, i) => (
            <div
              key={`${s.kind}-${s.display}-${i}`}
              ref={i === hi ? hiRef : undefined}
              className={`pc-item${i === hi ? ' hi' : ''}`}
              // preventDefault keeps the input focused (no blur-commit race)
              onPointerDown={(e) => {
                e.preventDefault()
                accept(s)
              }}
            >
              <span className={`main ${s.kind}`}>{s.display}</span>
              {s.detail !== undefined ? <span className="detail">{s.detail}</span> : null}
            </div>
          ))}
        </div>
      ) : null}

      {trimmed === '' ? (
        <div className="pc-hint">Blank — the field always applies.</div>
      ) : parsed !== null && !parsed.ok ? (
        <div className="pc-error">{parsed.message}</div>
      ) : parsed !== null && parsed.ok ? (
        <>
          <div className="pc-view">
            <span className="pc-when">applies when</span>
            <ExprChips node={parsed.ast} byId={byId} />
          </div>
          {warnings.map((w) => (
            <div key={w.message} className="pc-warn">
              {w.message}
            </div>
          ))}
        </>
      ) : null}
    </div>
  )
}

function ExprChips({ node, byId }: { node: ExprNode; byId: Map<string, DataElement> }) {
  if (node.kind === 'bool') {
    return (
      <>
        {node.parts.map((part, i) => (
          <span className="pc-run" key={i}>
            {i > 0 ? <span className="pc-conn">{node.op}</span> : null}
            <ExprChips node={part} byId={byId} />
          </span>
        ))}
      </>
    )
  }
  if (node.kind === 'group') {
    return (
      <>
        <span className="pc-paren">(</span>
        <ExprChips node={node.inner} byId={byId} />
        <span className="pc-paren">)</span>
      </>
    )
  }

  const el = byId.get(node.field)
  const enumeration = (el?.enumeration ?? []) as EnumItem[]
  const labelOf = (v: string) => enumeration.find((it) => it.value === v)?.label

  // `field <> ""` is the idiomatic non-blank test — say so instead of chips.
  const blankTest = node.op === '<>' && node.values.length === 1 && node.values[0].value === ''
  return (
    <>
      <span className="pc-field" title={el?.label || node.field}>
        {node.field}
      </span>
      {blankTest ? (
        <span className="pc-op">is not blank</span>
      ) : (
        <>
          <span className="pc-op">{OP_WORDS[node.op] ?? node.op}</span>
          {node.values.map((v, i) => {
            const label = v.quoted ? labelOf(v.value) : undefined
            return (
              <span className="pc-val" key={i} title={label !== undefined ? `"${v.value}"` : undefined}>
                {label ?? v.value}
              </span>
            )
          })}
        </>
      )}
    </>
  )
}
