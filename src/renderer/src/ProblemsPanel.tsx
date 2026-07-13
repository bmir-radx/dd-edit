/**
 * The problems list: dd-validate findings, worst first, click to jump to the
 * offending cell. File-level findings (no row) sit at the top.
 *
 * Repetitive checks collapse: when one check produces many findings (134
 * padded cells, 14 REDCap dates), they group into a single expandable entry
 * so one noisy check can't bury the rest of the list.
 */
import { useMemo, useState } from 'react'
import { IconError, IconInfo, IconWarning } from './icons'
import { useEditor } from './model/store'
import { findingRow, type Finding, type FindingLevel } from './sidecar'

const LEVEL_ORDER = { ERROR: 0, WARNING: 1, INFO: 2 } as const

// Checks that sort after everything else of the same severity: advisory
// naming preferences shouldn't sit above genuine content findings.
const DEMOTED_CHECKS = new Set(['datatype-preferred'])

/** A check with at least this many findings renders as one group. */
const GROUP_THRESHOLD = 4

function LevelIcon({ level }: { level: FindingLevel }) {
  return level === 'ERROR' ? <IconError /> : level === 'WARNING' ? <IconWarning /> : <IconInfo />
}

export function ProblemsPanel({
  findings,
  onJump,
}: {
  findings: Finding[]
  /** Jump to the offending row — and cell, when the finding names a column. */
  onJump: (row: number, column: string | null) => void
}) {
  const doc = useEditor((s) => s.doc)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())

  // Entries in severity order: repetitive checks fold into groups, placed by
  // their worst finding; everything else stays an individual row.
  const entries = useMemo(() => {
    const sorted = findings.slice().sort((a, b) => {
      const byLevel = LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]
      if (byLevel !== 0) return byLevel
      const byDemotion =
        Number(DEMOTED_CHECKS.has(a.check)) - Number(DEMOTED_CHECKS.has(b.check))
      if (byDemotion !== 0) return byDemotion
      return (a.line ?? 0) - (b.line ?? 0)
    })
    const byCheck = new Map<string, Finding[]>()
    for (const f of sorted) {
      byCheck.set(f.check, [...(byCheck.get(f.check) ?? []), f])
    }
    const grouped = new Set(
      [...byCheck.entries()].filter(([, fs]) => fs.length >= GROUP_THRESHOLD).map(([c]) => c),
    )
    const emitted = new Set<string>()
    const out: ({ kind: 'one'; finding: Finding } | { kind: 'group'; check: string; findings: Finding[] })[] = []
    for (const f of sorted) {
      if (!grouped.has(f.check)) {
        out.push({ kind: 'one', finding: f })
      } else if (!emitted.has(f.check)) {
        emitted.add(f.check)
        out.push({ kind: 'group', check: f.check, findings: byCheck.get(f.check)! })
      }
    }
    return out
  }, [findings])

  if (entries.length === 0) {
    return (
      <div className="problems">
        <div className="all-clear">✓ No problems — the dictionary validates cleanly.</div>
      </div>
    )
  }

  const problemRow = (f: Finding, key: React.Key) => {
    const row = findingRow(f)
    const id = row !== null ? doc.elements[row]?.id : null
    return (
      <button
        key={key}
        className={`problem ${f.level.toLowerCase()}`}
        onClick={() => row !== null && onJump(row, f.column)}
        disabled={row === null}
        title={f.check}
      >
        <span className="badge">
          <LevelIcon level={f.level} />
        </span>
        <span className="text">
          <span className="msg">{f.message}</span>
          <span className="where">
            {row !== null ? (
              <>
                row {row + 1}
                {id ? (
                  <>
                    {' · '}
                    <code className="pid">{id}</code>
                  </>
                ) : null}
              </>
            ) : (
              'whole file'
            )}
            {f.column ? ` · ${f.column}` : ''}
          </span>
        </span>
      </button>
    )
  }

  return (
    <div className="problems">
      {entries.map((entry, i) => {
        if (entry.kind === 'one') return problemRow(entry.finding, i)
        const { check, findings: fs } = entry
        const open = expanded.has(check)
        return (
          <div key={check} className="problem-group">
            <button
              className={`problem group-head ${fs[0].level.toLowerCase()}`}
              onClick={() =>
                setExpanded((prev) => {
                  const next = new Set(prev)
                  if (next.has(check)) next.delete(check)
                  else next.add(check)
                  return next
                })
              }
              title={check}
            >
              {/* Disclosure triangle on the left, IDE-tree style — it IS the
                  affordance, so it gets real size. */}
              <span className={`chevron${open ? ' open' : ''}`}>▶</span>
              <span className="badge">
                <LevelIcon level={fs[0].level} />
              </span>
              <span className="text">
                <span className="msg">
                  <span className="count">{fs.length} ×</span> {check.replace(/-/g, ' ')}
                </span>
                <span className="where">{fs[0].message}</span>
              </span>
            </button>
            {open ? <div className="group-body">{fs.map((f, j) => problemRow(f, j))}</div> : null}
          </div>
        )
      })}
    </div>
  )
}
