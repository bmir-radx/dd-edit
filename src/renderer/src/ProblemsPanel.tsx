/**
 * The problems list: dd-validate findings, worst first, click to jump to the
 * offending row. File-level findings (no row) sit at the top.
 */
import { useMemo } from 'react'
import { IconError, IconWarning } from './icons'
import { useEditor } from './model/store'
import { findingRow, type Finding } from './sidecar'

const LEVEL_ORDER = { ERROR: 0, WARNING: 1, INFO: 2 } as const

export function ProblemsPanel({
  findings,
  onJump,
}: {
  findings: Finding[]
  /** Jump to the offending row — and cell, when the finding names a column. */
  onJump: (row: number, column: string | null) => void
}) {
  const doc = useEditor((s) => s.doc)

  const sorted = useMemo(
    () =>
      findings.slice().sort((a, b) => {
        const byLevel = LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]
        if (byLevel !== 0) return byLevel
        return (a.line ?? 0) - (b.line ?? 0)
      }),
    [findings],
  )

  if (sorted.length === 0) {
    return (
      <div className="problems">
        <div className="all-clear">✓ No problems — the dictionary validates cleanly.</div>
      </div>
    )
  }

  return (
    <div className="problems">
      {sorted.map((f, i) => {
        const row = findingRow(f)
        const id = row !== null ? doc.elements[row]?.id : null
        return (
          <button
            key={i}
            className={`problem ${f.level.toLowerCase()}`}
            onClick={() => row !== null && onJump(row, f.column)}
            disabled={row === null}
            title={f.check}
          >
            <span className="badge">
              {f.level === 'ERROR' ? <IconError /> : <IconWarning />}
            </span>
            <span className="text">
              <span className="msg">{f.message}</span>
              <span className="where">
                {row !== null ? `row ${row + 1}${id ? ` · ${id}` : ''}` : 'whole file'}
                {f.column ? ` · ${f.column}` : ''}
              </span>
            </span>
          </button>
        )
      })}
    </div>
  )
}
