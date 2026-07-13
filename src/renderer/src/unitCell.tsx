/**
 * The Unit column's custom cell. Value semantics are identical to a text
 * cell — the raw unit code is the value, and copy, paste, and search all use
 * it — but the cell's editor is a UCUM typeahead: suggestions from the
 * curated unit list, matched on code and name, keyboard-navigable (same
 * conventions as the precondition field: wrap-around arrows, Enter/Tab
 * accepts, Escape closes the list first). Free text remains legal — the
 * dropdown assists, it never blocks.
 *
 * Display drawing stays in GridView's drawCell interceptor (name-first
 * rendering, the "→ code" fix pill, the missing-unit ⓘ); draw() here is only
 * the plain-text fallback should that interceptor miss.
 */
import { GridCellKind, type CustomCell, type CustomRenderer } from '@glideapps/glide-data-grid'
import { useMemo, useState } from 'react'
import { UCUM_UNITS, type UcumUnit } from './ucum'

export interface UnitCellData {
  readonly kind: 'unit-cell'
  readonly value: string
}
export type UnitCell = CustomCell<UnitCellData>

export function isUnitCell(cell: CustomCell): cell is UnitCell {
  return (cell.data as Partial<UnitCellData>).kind === 'unit-cell'
}

const MAX_SUGGESTIONS = 8

function suggestionsFor(text: string): UcumUnit[] {
  const needle = text.trim().toLowerCase()
  const all =
    needle === ''
      ? UCUM_UNITS
      : UCUM_UNITS.filter(
          (u) => u.code.toLowerCase().includes(needle) || u.name.toLowerCase().includes(needle),
        )
  return all.slice(0, MAX_SUGGESTIONS)
}

export const unitCellRenderer: CustomRenderer<UnitCell> = {
  kind: GridCellKind.Custom,
  isMatch: isUnitCell,
  draw: (args, cell) => {
    const { ctx, rect, theme } = args
    ctx.fillStyle = theme.textDark
    ctx.textBaseline = 'middle'
    ctx.fillText(
      cell.data.value,
      rect.x + theme.cellHorizontalPadding,
      rect.y + rect.height / 2,
    )
    return true
  },
  onPaste: (val, data) => ({ ...data, value: val }),
  // Delete/Backspace on the selected cell: GDG only clears custom cells
  // whose renderer says what "empty" means.
  onDelete: (cell: UnitCell): UnitCell => ({
    ...cell,
    copyData: '',
    data: { ...cell.data, value: '' },
  }),
  provideEditor: () => ({
    disablePadding: true,
    editor: (p) => {
      const { value, initialValue, onChange, onFinishedEditing } = p
      // Opened by typing a character: start from it; opened by Enter /
      // double-click: start from the current value.
      const [text, setText] = useState(initialValue ?? value.data.value)
      const [open, setOpen] = useState(true)
      const [hi, setHi] = useState(0)
      const items = useMemo(() => suggestionsFor(text), [text])

      const cellWith = (v: string): UnitCell => ({
        ...value,
        copyData: v,
        data: { ...value.data, value: v },
      })
      const commit = (v: string) => onFinishedEditing(cellWith(v), [0, 1])

      return (
        <div className="unit-editor">
          <input
            autoFocus
            value={text}
            placeholder="UCUM unit, e.g. mg/dL"
            onChange={(e) => {
              setText(e.target.value)
              setHi(0)
              setOpen(true)
              onChange(cellWith(e.target.value))
            }}
            onKeyDown={(e) => {
              if (open && items.length > 0) {
                // stopPropagation as well as preventDefault: GDG's overlay
                // listens for Up/Down to commit-and-move the grid selection,
                // which killed the list navigation.
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  e.stopPropagation()
                  setHi((h) => (h + 1) % items.length)
                  return
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  e.stopPropagation()
                  setHi((h) => (h - 1 + items.length) % items.length)
                  return
                }
                if (e.key === 'Enter' || e.key === 'Tab') {
                  e.preventDefault()
                  e.stopPropagation()
                  commit(items[Math.min(hi, items.length - 1)].code)
                  return
                }
                if (e.key === 'Escape') {
                  // First Escape closes the list; the next cancels the edit.
                  e.stopPropagation()
                  setOpen(false)
                  return
                }
              }
              if (e.key === 'Enter') {
                e.preventDefault()
                e.stopPropagation()
                commit(text)
              } else if (e.key === 'Escape') {
                e.stopPropagation()
                onFinishedEditing(undefined, [0, 0])
              }
            }}
          />
          {open && items.length > 0 ? (
            <div className="unit-suggest">
              {items.map((u, i) => (
                <div
                  key={u.code}
                  className={`unit-item${i === hi ? ' hi' : ''}`}
                  // mousedown, not click: accept before the input's blur.
                  onMouseDown={(e) => {
                    e.preventDefault()
                    commit(u.code)
                  }}
                  onMouseEnter={() => setHi(i)}
                >
                  {/* Name first — it's what a person recognizes; the code
                      (what actually gets inserted) sits after it, dimmed. */}
                  <span className="name">{u.name}</span>
                  <span className="code">{u.code}</span>
                </div>
              ))}
              <div className="suggest-note">
                Common UCUM units — a small subset; any UCUM code or free text is valid
              </div>
            </div>
          ) : null}
        </div>
      )
    },
  }),
}
