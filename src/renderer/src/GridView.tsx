/**
 * The spreadsheet: rows are data elements, columns are the spec's fields.
 *
 * Color is meaning here, never decoration:
 *   red / amber   validation problems (row tint; offending cell stronger)
 *   blue dot      rows modified since open / last save
 *   datatype hue  kind of data (numeric blue, temporal violet, coded teal)
 *   section tint  stable pastel per section name, so groups scan visually
 *   bubbles       list-valued fields render as pills (read-only; edited in
 *                 the inspector)
 *
 * "Modified" is computed by reference identity against the baseline document:
 * mutations share structure, so an element is untouched iff its object is the
 * very object in the baseline — undoing back to the original clears the dot.
 */
import {
  CompactSelection,
  DataEditor,
  GridCellKind,
  type DataEditorRef,
  type DrawCellCallback,
  type DrawHeaderCallback,
  type EditableGridCell,
  type GridCell,
  type GridColumn,
  type GridMouseEventArgs,
  type GridSelection,
  type Item,
} from '@glideapps/glide-data-grid'
import '@glideapps/glide-data-grid/dist/index.css'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { deleteElements, emptyElement, insertElement, moveElement, setField } from './model/document'
import { useEditor } from './model/store'
import { pillColors } from './pillColors'
import { findingRow, type Finding, type FindingLevel } from './sidecar'
import { needsIntegerDatatype, wantsUnit } from './datatypes'
import { idNeedsCleanup } from './ids'
import { ucumSuggestion, ucumUnit } from './ucum'
import { isUnitCell, unitCellRenderer } from './unitCell'
import { isAbsoluteHttpUrl } from './urls'

// Stable array identity: a fresh array per render would re-register the
// renderers with the grid on every render.
const UNIT_RENDERERS = [unitCellRenderer]
import type { DataElement, EnumItem } from './types/document'

/** The validator reports CSV column headers; map them to element fields. */
const HEADER_TO_KEY: Record<string, keyof DataElement> = {
  Id: 'id',
  Aliases: 'aliases',
  Label: 'label',
  Description: 'description',
  Section: 'section',
  Cardinality: 'cardinality',
  Terms: 'terms',
  Datatype: 'datatype',
  Pattern: 'pattern',
  Unit: 'unit',
  Enumeration: 'enumeration',
  MissingValueCodes: 'missing_value_codes',
  Precondition: 'precondition',
  Required: 'required',
  Examples: 'examples',
  Notes: 'notes',
  Provenance: 'provenance',
  SeeAlso: 'see_also',
}

// One font for painting AND measuring: wrap layout is only correct when the
// line-count measurement uses exactly the font the cells are drawn with.
const FONT_FAMILY = 'system-ui, -apple-system, "Segoe UI", sans-serif'
const BASE_FONT = `13px ${FONT_FAMILY}`
const LINE_HEIGHT = 17
const MIN_ROW_HEIGHT = 34
const MAX_ROW_HEIGHT = 400
const GDG_HEADER_HEIGHT = 36 // GDG's default headerHeight (we don't override it)
const CELL_PAD_TOP = 9 // top inset of a cell's first line in a tall/wrapped row

/**
 * The vertical CENTER (textBaseline 'middle') of a cell's first line — the one
 * value every custom-drawn cell type (text, markdown, pills) must share so a
 * row aligns consistently. Single-line rows center in the row; tall rows pin
 * the first line near the top.
 */
function firstLineCenterY(rectY: number, rectHeight: number): number {
  if (rectHeight > MIN_ROW_HEIGHT + 2) return rectY + CELL_PAD_TOP + LINE_HEIGHT / 2
  return rectY + rectHeight / 2
}

let measureCtx: CanvasRenderingContext2D | null = null
function getMeasureCtx(): CanvasRenderingContext2D {
  if (measureCtx === null) {
    measureCtx = document.createElement('canvas').getContext('2d')!
  }
  measureCtx.font = BASE_FONT
  return measureCtx
}

const PARA_GAP = 8 // extra space between paragraphs, on top of the line height

/**
 * Word-wrap text to a pixel width, paragraph-aware: newlines split paragraphs
 * (the REDCap converter emits single newlines between logical paragraphs),
 * and each paragraph wraps independently. Used by draw AND measure so the
 * two always agree.
 */
function wrapParagraphs(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[][] {
  const paragraphs: string[][] = []
  for (const paragraph of text.split(/\n+/)) {
    if (paragraph.trim() === '') continue
    const lines: string[] = []
    let line = ''
    for (const word of paragraph.split(/\s+/)) {
      const candidate = line === '' ? word : `${line} ${word}`
      if (line !== '' && ctx.measureText(candidate).width > maxWidth) {
        lines.push(line)
        line = word
      } else {
        line = candidate
      }
    }
    if (line !== '') lines.push(line)
    paragraphs.push(lines)
  }
  return paragraphs
}

// Text heights are cached per (width, text): recomputing row heights on every
// keystroke would otherwise re-measure every cell of every row.
const textHeightCache = new Map<string, number>()
function wrappedTextHeight(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): number {
  const key = `${Math.round(maxWidth)}|${text}`
  const hit = textHeightCache.get(key)
  if (hit !== undefined) return hit
  if (textHeightCache.size > 20_000) textHeightCache.clear() // crude but sufficient
  const paragraphs = wrapParagraphs(ctx, text, maxWidth)
  const lines = paragraphs.reduce((n, p) => n + p.length, 0)
  const height = lines * LINE_HEIGHT + Math.max(0, paragraphs.length - 1) * PARA_GAP
  textHeightCache.set(key, height)
  return height
}

/**
 * Canvas cells can't render HTML, but they CAN render styled text — so
 * descriptions get a mini markdown renderer: inline markdown parses into
 * styled runs (bold / italic / code / links), which lay out word-by-word with
 * per-run fonts. Code spans draw a chip background; links draw in accent
 * blue. Layouts are cached per (width, text).
 */
interface MdRun {
  text: string
  bold: boolean
  italic: boolean
  code: boolean
  link: boolean
}

const MONO_FONT = '12px ui-monospace, SFMono-Regular, Menlo, monospace'
function fontFor(run: MdRun): string {
  if (run.code) return MONO_FONT
  return `${run.italic ? 'italic ' : ''}${run.bold ? '600 ' : ''}13px ${FONT_FAMILY}`
}

const MD_INLINE =
  /(`[^`]+`)|(\*\*(.+?)\*\*)|(__(.+?)__)|(\*([^*\n]+?)\*)|(_([^_\n]+?)_)|(!?\[([^\]]*)\]\([^)]*\))/

/** Flat inline parse (no nesting) — plenty for data-element descriptions. */
function parseInlineMd(text: string, baseBold: boolean): MdRun[] {
  const runs: MdRun[] = []
  const plain = (t: string) =>
    t !== '' && runs.push({ text: t, bold: baseBold, italic: false, code: false, link: false })
  let rest = text
  while (rest !== '') {
    const m = MD_INLINE.exec(rest)
    if (!m) {
      plain(rest)
      break
    }
    plain(rest.slice(0, m.index))
    if (m[1] !== undefined) {
      runs.push({ text: m[1].slice(1, -1), bold: false, italic: false, code: true, link: false })
    } else if (m[3] !== undefined || m[5] !== undefined) {
      runs.push({ text: m[3] ?? m[5]!, bold: true, italic: false, code: false, link: false })
    } else if (m[7] !== undefined || m[9] !== undefined) {
      runs.push({ text: m[7] ?? m[9]!, bold: baseBold, italic: true, code: false, link: false })
    } else {
      runs.push({ text: m[11] ?? '', bold: baseBold, italic: false, code: false, link: true })
    }
    rest = rest.slice(m.index + m[0].length)
  }
  return runs
}

/** Paragraphs of runs. Headings render bold; blockquote markers drop. */
function parseMd(md: string): MdRun[][] {
  const paragraphs: MdRun[][] = []
  for (let para of md.split(/\n+/)) {
    para = para.replace(/^>\s?/, '')
    const heading = /^#{1,6}\s+/.test(para)
    if (heading) para = para.replace(/^#{1,6}\s+/, '')
    if (para.trim() === '') continue
    paragraphs.push(parseInlineMd(para, heading))
  }
  return paragraphs
}

interface MdSeg {
  text: string
  run: MdRun
  x: number
  width: number
}
interface MdLayout {
  paragraphs: MdSeg[][][] // paragraph -> line -> segments
  height: number
}

const CODE_PAD = 4 // horizontal padding inside a code chip

const mdLayoutCache = new Map<string, MdLayout>()
function layoutMd(ctx: CanvasRenderingContext2D, md: string, maxWidth: number): MdLayout {
  const key = `${Math.round(maxWidth)}|${md}`
  const hit = mdLayoutCache.get(key)
  if (hit !== undefined) return hit
  if (mdLayoutCache.size > 2000) mdLayoutCache.clear()

  const paragraphs: MdSeg[][][] = []
  let totalLines = 0
  for (const runs of parseMd(md)) {
    const lines: MdSeg[][] = []
    let line: MdSeg[] = []
    let x = 0
    for (const run of runs) {
      ctx.font = fontFor(run)
      const spaceWidth = ctx.measureText(' ').width
      for (const word of run.text.split(/\s+/)) {
        if (word === '') continue
        const width = ctx.measureText(word).width + (run.code ? CODE_PAD * 2 : 0)
        const gap = x === 0 ? 0 : spaceWidth
        if (x > 0 && x + gap + width > maxWidth) {
          lines.push(line)
          line = []
          x = 0
        }
        const startX = x === 0 ? 0 : x + gap
        const last = line[line.length - 1]
        if (last !== undefined && last.run === run && !run.code) {
          last.text += ` ${word}`
          last.width = startX + width - last.x
        } else {
          line.push({ text: word, run, x: startX, width })
        }
        x = startX + width
      }
    }
    if (line.length > 0) lines.push(line)
    if (lines.length === 0) continue
    paragraphs.push(lines)
    totalLines += lines.length
  }
  const layout: MdLayout = {
    paragraphs,
    height: totalLines * LINE_HEIGHT + Math.max(0, paragraphs.length - 1) * PARA_GAP,
  }
  mdLayoutCache.set(key, layout)
  return layout
}

function drawMdSeg(ctx: CanvasRenderingContext2D, seg: MdSeg, left: number, y: number): void {
  ctx.font = fontFor(seg.run)
  if (seg.run.code) {
    ctx.fillStyle = '#eef1f4'
    ctx.beginPath()
    ctx.roundRect(left + seg.x, y - 8, seg.width, 16, 4)
    ctx.fill()
    ctx.fillStyle = '#1f2328'
    ctx.fillText(seg.text, left + seg.x + CODE_PAD, y)
  } else {
    ctx.fillStyle = seg.run.link ? '#2563eb' : '#1f2328'
    ctx.fillText(seg.text, left + seg.x, y)
  }
}

const ROW_TINT: Record<FindingLevel, string | undefined> = {
  ERROR: '#fdf1f1',
  WARNING: '#fdf8ec',
  INFO: undefined,
}
const CELL_TINT: Record<FindingLevel, string | undefined> = {
  ERROR: '#f9dcdc',
  WARNING: '#faeeca',
  INFO: undefined,
}

function worse(a: FindingLevel | undefined, b: FindingLevel): FindingLevel {
  return a === 'ERROR' || b === 'ERROR' ? 'ERROR' : a === 'WARNING' || b === 'WARNING' ? 'WARNING' : b
}

/**
 * Pastel per section, assigned by order of first appearance from a curated
 * cool-hue palette. Curated rather than hue-stepped because color is meaning
 * here: red and amber are the validation tints, so section tints must never
 * wander into that band (a golden-angle walk started at hue 0 — pink — and
 * the first section read as an error).
 */
const SECTION_TINTS = [
  'hsl(212 62% 94%)', // blue
  'hsl(158 52% 92%)', // green
  'hsl(262 55% 95%)', // violet
  'hsl(190 60% 92%)', // cyan
  'hsl(140 45% 92%)', // mint
  'hsl(232 55% 95%)', // indigo
  'hsl(175 50% 91%)', // teal
  'hsl(250 45% 94%)', // periwinkle
]

function sectionTints(elements: readonly DataElement[]): Map<string, string> {
  const tints = new Map<string, string>()
  for (const element of elements) {
    const name = element.section ?? ''
    if (name === '' || tints.has(name)) continue
    tints.set(name, SECTION_TINTS[tints.size % SECTION_TINTS.length])
  }
  return tints
}

type ScalarKey =
  | 'id'
  | 'label'
  | 'datatype'
  | 'cardinality'
  | 'section'
  | 'unit'
  | 'pattern'
  | 'precondition'
  | 'notes'
  | 'provenance'
  | 'see_also'

interface ColumnSpec {
  key: keyof DataElement
  title: string
  width: number
  kind: 'text' | 'boolean' | 'bubble' | 'markdown'
  /** Blank input stores null (optional fields) rather than "". */
  nullable?: boolean
}

const COLUMNS: ColumnSpec[] = [
  // Section leads: its pastel band is the grouping gutter, frozen with Id.
  { key: 'section', title: 'Section', width: 130, kind: 'text', nullable: true },
  { key: 'id', title: 'Id', width: 130, kind: 'text' },
  { key: 'label', title: 'Label', width: 200, kind: 'text' },
  // Wide enough for "string" + the "→ integer" fix pill without clipping.
  { key: 'datatype', title: 'Datatype', width: 145, kind: 'text' },
  { key: 'cardinality', title: 'Cardinality', width: 100, kind: 'text' },
  { key: 'required', title: 'Required', width: 85, kind: 'boolean' },
  // Wide enough for a typical "name (code)" rendering without truncation.
  { key: 'unit', title: 'Unit', width: 130, kind: 'text', nullable: true },
  { key: 'enumeration', title: 'Enumeration', width: 230, kind: 'bubble' },
  { key: 'pattern', title: 'Pattern', width: 130, kind: 'text', nullable: true },
  { key: 'precondition', title: 'Precondition', width: 160, kind: 'text', nullable: true },
  { key: 'terms', title: 'Terms', width: 160, kind: 'bubble' },
  { key: 'description', title: 'Description', width: 320, kind: 'markdown', nullable: true },
  { key: 'aliases', title: 'Aliases', width: 130, kind: 'bubble' },
  { key: 'examples', title: 'Examples', width: 150, kind: 'bubble' },
  { key: 'notes', title: 'Notes', width: 200, kind: 'text', nullable: true },
  { key: 'provenance', title: 'Provenance', width: 180, kind: 'text', nullable: true },
  { key: 'see_also', title: 'See also', width: 180, kind: 'text', nullable: true },
  // Last by default: the standard codes repeat on almost every element, so
  // they'd otherwise push the varied, informative columns off screen.
  { key: 'missing_value_codes', title: 'Missing values', width: 150, kind: 'bubble' },
]

/** Column keys that can wrap: text-bearing columns and pill lists. */
export const WRAPPABLE_KEYS: string[] = COLUMNS.filter(
  (c) => c.kind === 'text' || c.kind === 'markdown' || c.kind === 'bubble',
).map((c) => c.key as string)

// The frozen columns (Section, Id) keep their place; everything after Id can
// be drag-reordered. Order and widths are presentation only — serialization
// always uses the canonical field order — and persist across sessions
// alongside the wrap setting.
const FROZEN_COUNT = 2
const MOVABLE_DEFAULT: string[] = COLUMNS.slice(FROZEN_COUNT).map((c) => c.key as string)

function loadColOrder(): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem('dd-edit.colOrder') ?? '[]')
    const valid = Array.isArray(stored)
      ? (stored as unknown[]).filter(
          (k): k is string => typeof k === 'string' && MOVABLE_DEFAULT.includes(k),
        )
      : []
    // Columns added to the spec since the order was saved append at the end.
    let order = [...valid, ...MOVABLE_DEFAULT.filter((k) => !valid.includes(k))]
    // One-time migration (2026-07): Missing values moved to the end of the
    // default order. Saved orders get the same nudge once; drags after that
    // are the user's and stick.
    if (localStorage.getItem('dd-edit.colOrder.mvLast') === null) {
      order = [...order.filter((k) => k !== 'missing_value_codes'), 'missing_value_codes']
      localStorage.setItem('dd-edit.colOrder.mvLast', '1')
    }
    return order
  } catch {
    return MOVABLE_DEFAULT
  }
}

function loadColWidths(): Record<string, number> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem('dd-edit.colWidths') ?? '{}')
    const widths: Record<string, number> = {}
    if (stored !== null && typeof stored === 'object') {
      for (const [k, v] of Object.entries(stored)) {
        if (typeof v === 'number' && v >= 40 && v <= 2000) widths[k] = v
      }
    }
    return widths
  } catch {
    return {}
  }
}

const BUBBLE_CAP = 6

function bubbles(key: keyof DataElement, element: DataElement, capped: boolean): string[] {
  let all: string[]
  if (key === 'enumeration' || key === 'missing_value_codes') {
    all = ((element[key] ?? []) as EnumItem[]).map((i) => `${i.value} = ${i.label}`)
  } else {
    all = (element[key] ?? []) as string[]
  }
  if (capped && all.length > BUBBLE_CAP) {
    return [...all.slice(0, BUBBLE_CAP), `+${all.length - BUBBLE_CAP} more`]
  }
  return all
}

// Pill flow-layout constants shared by drawing and height measurement.
const PILL_H = 18
const PILL_GAP = 4
const PILL_PAD_X = 8
const PILL_FONT = `12px ${FONT_FAMILY}`

// Unit-cell geometry, shared by drawCell and the onCellClicked hit test for
// the "→ ucum" fix pill. UNIT_PAD_X must match the theme's horizontal cell
// padding (GDG default: 8).
const UNIT_PAD_X = 8
const UNIT_FIX_GAP = 6
const UNIT_FIX_PAD_X = 6

/** The fix pill's [start, end] x-range within a unit cell, or null. */
function unitFixPillRange(raw: string): [number, number] | null {
  if (raw === '' || ucumUnit(raw) !== undefined) return null
  const suggestion = ucumSuggestion(raw)
  if (suggestion === null) return null
  const ctx = getMeasureCtx() // leaves BASE_FONT set
  const w = ctx.measureText(raw).width
  ctx.font = PILL_FONT
  const pw = ctx.measureText(`→ ${suggestion.code}`).width + UNIT_FIX_PAD_X * 2
  const x = UNIT_PAD_X + w + UNIT_FIX_GAP
  return [x, x + pw]
}

/**
 * The "→ integer" fix pill's [start, end] x-range within a datatype cell
 * (after the datatype pill), or null when the element doesn't need it.
 * Shared by drawCell and the onCellClicked hit test.
 */
function datatypeFixPillRange(
  element: DataElement,
  cellWidth: number,
): [number, number] | null {
  if (!needsIntegerDatatype(element)) return null
  const ctx = getMeasureCtx()
  ctx.font = PILL_FONT
  const pillW = Math.min(ctx.measureText(element.datatype).width + 16, cellWidth - 12)
  const x = 6 + pillW + UNIT_FIX_GAP
  const w = ctx.measureText('→ integer').width + UNIT_FIX_PAD_X * 2
  return [x, x + w]
}

/**
 * Whether a point (cell-local coordinates) lands on the cell's fix pill:
 * "→ ucum" in unit cells, "→ integer" in datatype cells. The pill's box is
 * its x-range at pill height around the first-line center. Shared by the
 * click handler (apply the fix) and the hover handler (pointer cursor).
 */
function fixPillHit(
  key: string | undefined,
  element: DataElement,
  x: number,
  y: number,
  bounds: { width: number; height: number },
): boolean {
  let range: [number, number] | null = null
  if (key === 'unit') range = unitFixPillRange((element.unit ?? '') as string)
  else if (key === 'datatype') range = datatypeFixPillRange(element, bounds.width)
  if (range === null) return false
  const cy = firstLineCenterY(0, bounds.height)
  return x >= range[0] && x <= range[1] && Math.abs(y - cy) <= PILL_H / 2
}

/** Rows of pills after flow-wrapping into maxWidth. */
function bubbleRows(ctx: CanvasRenderingContext2D, items: string[], maxWidth: number): number {
  ctx.font = PILL_FONT
  let rows = 1
  let x = 0
  for (const item of items) {
    const w = Math.min(ctx.measureText(item).width + PILL_PAD_X * 2, maxWidth)
    if (x > 0 && x + w > maxWidth) {
      rows++
      x = 0
    }
    x += w + PILL_GAP
  }
  return rows
}

export interface GridViewProps {
  /** Reports the row under the cursor (or null) so the inspector can follow. */
  onCursorRow: (row: number | null) => void
  /** Reports selected row indices (ascending) so previews can scope to them. */
  onSelectedRows: (rows: number[]) => void
  showSearch: boolean
  onSearchClose: () => void
  findings: Finding[]
  /** Column keys whose text wraps (rows grow to fit). Per-column, via header menus. */
  wrappedCols: ReadonlySet<string>
  /** A wrappable column's header menu chevron was clicked. */
  onHeaderMenu: (key: string, position: { x: number; y: number }) => void
  /** Scroll to (and select) this cell/row whenever the nonce bumps. */
  jumpTarget?: { row: number; column: string | null; nonce: number } | null
}

export function GridView({
  onCursorRow,
  onSelectedRows,
  showSearch,
  onSearchClose,
  findings,
  wrappedCols,
  onHeaderMenu,
  jumpTarget,
}: GridViewProps) {
  const editorRef = useRef<DataEditorRef | null>(null)
  const doc = useEditor((s) => s.doc)
  const baseline = useEditor((s) => s.baseline)
  const apply = useEditor((s) => s.apply)

  const [widths, setWidths] = useState<Record<string, number>>(loadColWidths)
  const [colOrder, setColOrder] = useState<string[]>(loadColOrder)
  const [selection, setSelection] = useState<GridSelection>({
    columns: CompactSelection.empty(),
    rows: CompactSelection.empty(),
  })

  useEffect(() => {
    localStorage.setItem('dd-edit.colWidths', JSON.stringify(widths))
  }, [widths])
  useEffect(() => {
    localStorage.setItem('dd-edit.colOrder', JSON.stringify(colOrder))
  }, [colOrder])

  // The columns in display order: frozen prefix + the user's saved order.
  // Everything that receives a grid column index resolves it through this.
  const specs = useMemo<ColumnSpec[]>(() => {
    const byKey = new Map(COLUMNS.map((c) => [c.key as string, c]))
    return [
      ...COLUMNS.slice(0, FROZEN_COUNT),
      ...colOrder.map((k) => byKey.get(k)).filter((c): c is ColumnSpec => c !== undefined),
    ]
  }, [colOrder])

  const sectionColors = useMemo(() => sectionTints(doc.elements), [doc])
  const [tooltip, setTooltip] = useState<{ x: number; y: number; messages: string[] } | null>(
    null,
  )

  // Problems-panel / section-jumper navigation: scroll to the target, and
  // when the finding names a column, select that cell so the eye lands on it.
  // The column header resolves through the user's display order (specs).
  useEffect(() => {
    if (jumpTarget == null) return
    const key = jumpTarget.column !== null ? HEADER_TO_KEY[jumpTarget.column] : undefined
    const col = key !== undefined ? specs.findIndex((s) => s.key === key) : -1
    editorRef.current?.scrollTo(
      Math.max(col, 0),
      jumpTarget.row,
      col >= 0 ? 'both' : 'vertical',
      0,
      0,
      { vAlign: 'center' },
    )
    if (col >= 0) {
      setSelection({
        columns: CompactSelection.empty(),
        rows: CompactSelection.empty(),
        current: {
          cell: [col, jumpTarget.row],
          range: { x: col, y: jumpTarget.row, width: 1, height: 1 },
          rangeStack: [],
        },
      })
    }
    // Re-jumping when specs changes identity would surprise; the nonce is
    // the one true trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpTarget])

  // Row -> worst level (row tint), "row|field" -> worst level + messages
  // (cell tint + hover tooltip), and row -> messages for findings that have
  // no column (shown when hovering the row's modified-dot cell).
  const { rowLevels, cellInfo, rowMessages } = useMemo(() => {
    const rows = new Map<number, FindingLevel>()
    const cells = new Map<string, { level: FindingLevel; messages: string[] }>()
    const byRow = new Map<number, string[]>()
    for (const f of findings) {
      const row = findingRow(f)
      if (row === null) continue
      rows.set(row, worse(rows.get(row), f.level))
      const key = f.column ? HEADER_TO_KEY[f.column] : undefined
      if (key) {
        const slot = cells.get(`${row}|${key}`) ?? { level: f.level, messages: [] }
        slot.level = worse(slot.level, f.level)
        slot.messages.push(f.message)
        cells.set(`${row}|${key}`, slot)
      } else {
        byRow.set(row, [...(byRow.get(row) ?? []), f.message])
      }
    }
    return { rowLevels: rows, cellInfo: cells, rowMessages: byRow }
  }, [findings])

  const columns = useMemo<GridColumn[]>(
    () =>
      specs.map((c) => ({
        id: c.key,
        title: c.title,
        width: widths[c.key] ?? c.width,
        // Wrappable columns get a header menu (the ⋮ we always draw in
        // drawHeader). menuIcon points at an empty sprite so the grid's own
        // hover icon (a triangle that reads as a sort arrow) never appears.
        hasMenu: WRAPPABLE_KEYS.includes(c.key as string),
        menuIcon: 'none',
        // The append-row hint draws in the column that declares it; the Id
        // column is the first one wide enough not to crop it.
        ...(c.key === 'id' ? { trailingRowOptions: { hint: 'add element…' } } : {}),
      })),
    [widths, specs],
  )

  // Every row is exactly as tall as its tallest wrapped cell (text,
  // stripped-markdown, and pill-list columns, at their current widths). The
  // per-(width, text) cache keeps this cheap across keystrokes.
  const rowHeights = useMemo<number[] | null>(() => {
    if (wrappedCols.size === 0) return null
    const ctx = getMeasureCtx()
    return doc.elements.map((element) => {
      let tallest = LINE_HEIGHT
      for (const spec of COLUMNS) {
        if (!wrappedCols.has(spec.key as string)) continue
        const width = (widths[spec.key] ?? spec.width) - 16
        if (spec.kind === 'text') {
          const value = element[spec.key as keyof DataElement]
          if (typeof value !== 'string' || value === '') continue
          tallest = Math.max(tallest, wrappedTextHeight(ctx, value, width))
        } else if (spec.kind === 'markdown') {
          const value = element[spec.key as keyof DataElement]
          if (typeof value !== 'string' || value === '') continue
          tallest = Math.max(tallest, layoutMd(ctx, value, width).height)
        } else if (spec.kind === 'bubble') {
          const items = bubbles(spec.key as keyof DataElement, element, false)
          if (items.length === 0) continue
          const rows = bubbleRows(ctx, items, width)
          tallest = Math.max(tallest, rows * (PILL_H + PILL_GAP) - PILL_GAP)
        }
      }
      return Math.min(MAX_ROW_HEIGHT, Math.max(MIN_ROW_HEIGHT, tallest + 12))
    })
  }, [doc, widths, wrappedCols])

  // Which cell's fix pill is under the pointer (see onItemHovered below):
  // that one cell reports cursor: pointer through getCellContent.
  const [pillHover, setPillHover] = useState<{ col: number; row: number } | null>(null)

  const getCellContent = useCallback(
    ([col, row]: Item): GridCell => {
      const spec = specs[col]
      const element = doc.elements[row]
      if (!spec || !element) {
        return { kind: GridCellKind.Text, data: '', displayData: '', allowOverlay: false }
      }

      const key = spec.key as keyof DataElement
      const level = cellInfo.get(`${row}|${key}`)?.level
      const tint = level ? CELL_TINT[level] : undefined

      if (spec.kind === 'boolean') {
        return {
          kind: GridCellKind.Boolean,
          data: Boolean(element[key]),
          allowOverlay: false,
          ...(tint ? { themeOverride: { bgCell: tint } } : {}),
        }
      }
      if (spec.kind === 'bubble') {
        // Wrapped pill columns show everything; single-line ones cap at +n.
        return {
          kind: GridCellKind.Bubble,
          data: bubbles(key, element, !wrappedCols.has(spec.key as string)),
          allowOverlay: true,
          ...(tint ? { themeOverride: { bgCell: tint } } : {}),
        }
      }
      if (spec.kind === 'markdown') {
        const text = (element.description ?? '') as string
        return {
          kind: GridCellKind.Markdown,
          data: text,
          allowOverlay: true,
          ...(tint ? { themeOverride: { bgCell: tint } } : {}),
        }
      }

      const raw = element[key as ScalarKey]
      const text = raw == null ? '' : String(raw)
      if (spec.key === 'unit') {
        // Custom cell purely for its editor (the UCUM typeahead); value
        // semantics stay text — copyData is what copy/search use. Drawing is
        // drawCell's (name-first, fix pill, ⓘ), keyed on isUnitCell.
        return {
          kind: GridCellKind.Custom,
          data: { kind: 'unit-cell', value: text },
          copyData: text,
          allowOverlay: true,
          ...(tint ? { themeOverride: { bgCell: tint } } : {}),
          ...(pillHover !== null && pillHover.col === col && pillHover.row === row
            ? { cursor: 'pointer' as const }
            : {}),
        }
      }
      // Cardinality and datatype are custom-drawn as colored pills (drawCell
      // below) while remaining ordinary editable text cells; section shows
      // its stable pastel as the cell background (validation tint wins).
      const over: Record<string, string> = {}
      if (tint) over.bgCell = tint
      if (spec.key === 'section' && text !== '' && !tint) {
        const sectionBg = sectionColors.get(text)
        if (sectionBg) over.bgCell = sectionBg
      }
      if (spec.key === 'see_also') {
        // See-also renders as a link cell: hover underlines and clicking the
        // text opens the URL in the system browser — but only a valid
        // absolute http(s) URL gets the affordance; anything else stays
        // inert (and editable) text.
        const url = text.trim()
        const linkable = isAbsoluteHttpUrl(url)
        return {
          kind: GridCellKind.Uri,
          data: text,
          displayData: text,
          allowOverlay: true,
          hoverEffect: linkable,
          ...(linkable
            ? { onClickUri: () => void window.ddEdit.openExternal(url) }
            : {}),
          ...(Object.keys(over).length > 0 ? { themeOverride: over } : {}),
        }
      }

      return {
        kind: GridCellKind.Text,
        data: text,
        displayData: text,
        allowOverlay: true,
        allowWrapping: wrappedCols.has(spec.key as string), // multiline overlay editor
        ...(Object.keys(over).length > 0 ? { themeOverride: over } : {}),
        // Pointer cursor while the mouse is over this cell's fix pill.
        ...(pillHover !== null && pillHover.col === col && pillHover.row === row
          ? { cursor: 'pointer' as const }
          : {}),
      }
    },
    [doc, cellInfo, wrappedCols, sectionColors, specs, pillHover],
  )

  const onCellEdited = useCallback(
    ([col, row]: Item, newValue: EditableGridCell) => {
      const spec = specs[col]
      if (!spec || spec.kind === 'bubble') return
      if (newValue.kind === GridCellKind.Boolean && spec.key === 'required') {
        apply((d) => setField(d, row, 'required', Boolean(newValue.data)))
        return
      }
      if (newValue.kind === GridCellKind.Markdown && spec.key === 'description') {
        const text = newValue.data
        apply((d) => setField(d, row, 'description', text === '' ? null : text))
        return
      }
      if (newValue.kind === GridCellKind.Uri && spec.key === 'see_also') {
        const text = newValue.data
        apply((d) => setField(d, row, 'see_also', text === '' ? null : text))
        return
      }
      if (newValue.kind === GridCellKind.Custom && spec.key === 'unit' && isUnitCell(newValue)) {
        const text = newValue.data.value
        apply((d) => setField(d, row, 'unit', text === '' ? null : text))
        return
      }
      if (newValue.kind !== GridCellKind.Text) return
      const text = newValue.data
      if (spec.key === 'cardinality') {
        // Only the two legal values; anything else is ignored rather than
        // corrupting the document (the grid just shows the old value back).
        if (text === 'single' || text === 'multiple') {
          apply((d) => setField(d, row, 'cardinality', text))
        }
        return
      }
      const value = spec.nullable && text === '' ? null : text
      apply((d) => setField(d, row, spec.key as ScalarKey, value))
    },
    [apply, specs],
  )

  const onRowAppended = useCallback(() => {
    apply((d) => insertElement(d, d.elements.length, emptyElement()))
  }, [apply])

  const onRowMoved = useCallback(
    (from: number, to: number) => apply((d) => moveElement(d, from, to)),
    [apply],
  )

  const onDelete = useCallback(
    (sel: GridSelection): boolean => {
      const rows = sel.rows.toArray()
      if (rows.length > 0) {
        apply((d) => deleteElements(d, rows))
        setSelection({ columns: CompactSelection.empty(), rows: CompactSelection.empty() })
        return false // handled
      }
      return true // let the grid clear cell contents
    },
    [apply],
  )

  const onSelectionChange = useCallback(
    (sel: GridSelection) => {
      setSelection(sel)
      onCursorRow(sel.current ? sel.current.cell[1] : (sel.rows.toArray()[0] ?? null))
      // Row selection (row markers / row-header clicks) scopes the previews;
      // a range selection contributes the rows it spans.
      const rows = new Set<number>(sel.rows.toArray())
      if (sel.current?.range) {
        const { y, height } = sel.current.range
        for (let r = y; r < y + height; r++) rows.add(r)
      }
      onSelectedRows([...rows].sort((a, b) => a - b))
    },
    [onCursorRow, onSelectedRows],
  )

  const onColumnResize = useCallback((column: GridColumn, newSize: number) => {
    if (column.id) setWidths((w) => ({ ...w, [column.id as string]: newSize }))
  }, [])

  // Custom canvas rendering: section / cardinality / datatype draw as colored
  // pills. The cells stay ordinary Text cells, so overlay editing, copy/paste,
  // and search all keep working; only the painting changes. The validation
  // background (painted before content) still shows around the pill.
  //
  // Wrap mode is ALSO drawn here: wrapping long text (including markdown
  // descriptions) by hand makes the behavior deterministic instead of
  // depending on the grid's internal allowWrapping plumbing.
  const drawCell: DrawCellCallback = useCallback(
    (args, drawContent) => {
      const { ctx, rect, col, cell, theme } = args
      const spec = specs[col]
      const key = spec?.key

      if (
        (key === 'cardinality' || key === 'datatype') &&
        cell.kind === GridCellKind.Text &&
        cell.displayData !== ''
      ) {
        const text = cell.displayData
        const { bg, fg } = pillColors(key, text)
        ctx.save()
        ctx.font = `12px ${theme.fontFamily}`
        const width = Math.min(ctx.measureText(text).width + 16, rect.width - 12)
        const height = 20
        const x = rect.x + 6
        // Center the pill on the shared first-line center, so it lines up with
        // the plain text in sibling cells.
        const cy = firstLineCenterY(rect.y, rect.height)
        const y = cy - height / 2
        ctx.beginPath()
        ctx.roundRect(x, y, width, height, 10)
        ctx.fillStyle = bg
        ctx.fill()
        ctx.clip() // keep long text inside the pill
        ctx.fillStyle = fg
        ctx.textBaseline = 'middle'
        ctx.fillText(text, x + 8, cy + 0.5)
        ctx.restore()

        // Datatype cells of all-integer enumerated fields get an amber
        // "→ integer" fix pill (clickable — see onCellClicked, which shares
        // the geometry via datatypeFixPillRange).
        if (key === 'datatype') {
          const element = doc.elements[args.row]
          const range =
            element !== undefined ? datatypeFixPillRange(element, rect.width) : null
          if (range !== null) {
            ctx.save()
            ctx.beginPath()
            ctx.rect(rect.x, rect.y, rect.width, rect.height)
            ctx.clip()
            ctx.font = PILL_FONT
            ctx.textBaseline = 'middle'
            ctx.beginPath()
            ctx.roundRect(rect.x + range[0], cy - PILL_H / 2, range[1] - range[0], PILL_H, PILL_H / 2)
            ctx.fillStyle = '#fef3c7'
            ctx.fill()
            ctx.fillStyle = '#92400e'
            ctx.fillText('→ integer', rect.x + range[0] + UNIT_FIX_PAD_X, cy + 0.5)
            ctx.restore()
          }
        }
        return
      }

      // Unit cells: a recognized UCUM code shows its name first with the code
      // dimmed after it ("milligram (mg)") — the name is what a reader scans
      // for; the code is the stored value, still visible and still what the
      // editor opens with. An informal spelling with a known UCUM equivalent
      // keeps its raw display plus an amber "→ code" fix pill (clickable —
      // see onCellClicked, which shares the geometry via unitFixPillRange).
      // Display only: the cell's value (edit, copy, search) stays raw.
      if (key === 'unit' && cell.kind === GridCellKind.Custom && isUnitCell(cell) && cell.data.value !== '') {
        const name = ucumUnit(cell.data.value)?.name
        const suggestion = name === undefined ? ucumSuggestion(cell.data.value) : null
        if (name !== undefined || suggestion !== null) {
          const symbol = cell.data.value
          const cy = firstLineCenterY(rect.y, rect.height)
          ctx.save()
          ctx.beginPath()
          ctx.rect(rect.x, rect.y, rect.width, rect.height)
          ctx.clip()
          ctx.textBaseline = 'middle'
          ctx.font = BASE_FONT
          ctx.fillStyle = theme.textDark
          if (name !== undefined) {
            ctx.fillText(name, rect.x + UNIT_PAD_X, cy)
            const w = ctx.measureText(name).width
            ctx.font = `12px ${theme.fontFamily}`
            ctx.fillStyle = theme.textLight
            ctx.fillText(`(${symbol})`, rect.x + UNIT_PAD_X + w + 5, cy)
          } else if (suggestion !== null) {
            ctx.fillText(symbol, rect.x + UNIT_PAD_X, cy)
            const w = ctx.measureText(symbol).width
            ctx.font = PILL_FONT
            const label = `→ ${suggestion.code}`
            const pw = ctx.measureText(label).width + UNIT_FIX_PAD_X * 2
            const x = rect.x + UNIT_PAD_X + w + UNIT_FIX_GAP
            ctx.beginPath()
            ctx.roundRect(x, cy - PILL_H / 2, pw, PILL_H, PILL_H / 2)
            ctx.fillStyle = '#fef3c7'
            ctx.fill()
            ctx.fillStyle = '#92400e'
            ctx.fillText(label, x + UNIT_FIX_PAD_X, cy + 0.5)
          }
          ctx.restore()
          return
        }
      }

      // Empty unit cells of numeric, non-enumerated fields carry a quiet gray
      // ⓘ (hover explains); the inspector's Unit field says the same thing.
      if (key === 'unit' && cell.kind === GridCellKind.Custom && isUnitCell(cell) && cell.data.value === '') {
        const element = doc.elements[args.row]
        if (element !== undefined && wantsUnit(element)) {
          const cx = rect.x + UNIT_PAD_X + 6
          const cy = firstLineCenterY(rect.y, rect.height)
          ctx.save()
          ctx.beginPath()
          ctx.arc(cx, cy, 6, 0, Math.PI * 2)
          ctx.lineWidth = 1.25
          ctx.strokeStyle = '#9aa2ab'
          ctx.stroke()
          ctx.fillStyle = '#9aa2ab'
          ctx.font = `600 9px ${FONT_FAMILY}`
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillText('i', cx, cy + 0.5)
          ctx.restore()
          return
        }
      }

      // Ids that schema renderings would rename (spaces / special characters)
      // get a small amber warning triangle at the cell's right edge; the
      // inspector's Id field explains and offers the sanitized form.
      if (
        key === 'id' &&
        cell.kind === GridCellKind.Text &&
        cell.displayData !== '' &&
        idNeedsCleanup(cell.displayData)
      ) {
        drawContent()
        const cx = rect.x + rect.width - 12
        const cy = firstLineCenterY(rect.y, rect.height)
        ctx.save()
        ctx.beginPath()
        ctx.moveTo(cx, cy - 5.5)
        ctx.lineTo(cx + 5, cy + 4)
        ctx.lineTo(cx - 5, cy + 4)
        ctx.closePath()
        ctx.lineJoin = 'round'
        ctx.lineWidth = 3
        ctx.strokeStyle = '#f59e0b'
        ctx.fillStyle = '#f59e0b'
        ctx.stroke()
        ctx.fill()
        ctx.fillStyle = '#fff'
        ctx.font = `bold 8px ${FONT_FAMILY}`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText('!', cx, cy + 0.5)
        ctx.restore()
        return
      }

      // Pill lists (enumeration, terms, ...): draw our own flowed pills when
      // the column wraps (all values, no "+n more") OR when the row is tall
      // (so the pills top-align with sibling cells instead of centering).
      const colWrapped = spec !== undefined && wrappedCols.has(spec.key as string)
      const tallRow = rect.height > MIN_ROW_HEIGHT + 2
      // Colored pill columns (missing values, terms) always custom-draw so
      // their color shows; plain lists (enumeration, aliases, examples) only
      // when wrapped or in a tall row (else GDG's default bubble is fine).
      const coloredPillCol =
        spec?.key === 'missing_value_codes' || spec?.key === 'terms'
      const drawBubble = colWrapped || tallRow || coloredPillCol
      if (drawBubble && cell.kind === GridCellKind.Bubble && cell.data.length > 0) {
        ctx.save()
        ctx.beginPath()
        ctx.rect(rect.x, rect.y, rect.width, rect.height)
        ctx.clip()
        ctx.font = PILL_FONT
        ctx.textBaseline = 'middle'
        const left = rect.x + 6
        const right = rect.x + rect.width - 6
        let x = left
        // First pill row centered on the shared first-line center, so it lines
        // up with plain text / pills in sibling cells.
        let y = firstLineCenterY(rect.y, rect.height) - PILL_H / 2
        // Per-column pill colors from the shared palette: missing values blue
        // (the "value" identity), ontology terms violet, other lists
        // (including enumeration) neutral gray.
        const key = spec?.key
        let pillBg = '#eef1f4'
        let pillFg = '#374151'
        if (key === 'missing_value_codes') {
          pillBg = '#eef4ff'
          pillFg = '#1d4ed8'
        } else if (key === 'terms') {
          pillBg = '#ede9fe'
          pillFg = '#6d28d9'
        }
        for (const item of cell.data) {
          const w = Math.min(ctx.measureText(item).width + PILL_PAD_X * 2, right - left)
          if (x > left && x + w > right) {
            x = left
            y += PILL_H + PILL_GAP
          }
          if (y + PILL_H > rect.y + rect.height) break
          ctx.beginPath()
          ctx.roundRect(x, y, w, PILL_H, PILL_H / 2)
          ctx.fillStyle = pillBg
          ctx.fill()
          ctx.save()
          ctx.clip()
          ctx.fillStyle = pillFg
          ctx.fillText(item, x + PILL_PAD_X, y + PILL_H / 2 + 0.5)
          ctx.restore()
          x += w + PILL_GAP
        }
        ctx.restore()
        return
      }

      // Markdown descriptions ALWAYS custom-draw, with real inline styling
      // (bold / italic / code chips / links) via the mini renderer above.
      const isMarkdown = cell.kind === GridCellKind.Markdown
      const isText = cell.kind === GridCellKind.Text
      const raw =
        (isMarkdown || isText) && typeof (cell as { data?: unknown }).data === 'string'
          ? (cell as { data: string }).data
          : ''
      const pad = theme.cellHorizontalPadding
      if (isMarkdown && raw.length > 0) {
        ctx.save()
        ctx.beginPath()
        ctx.rect(rect.x, rect.y, rect.width, rect.height)
        ctx.clip()
        ctx.textBaseline = 'middle'
        if (colWrapped) {
          const layout = layoutMd(ctx, raw, rect.width - pad * 2)
          let y = firstLineCenterY(rect.y, rect.height)
          const bottom = rect.y + rect.height
          outer: for (let p = 0; p < layout.paragraphs.length; p++) {
            if (p > 0) y += PARA_GAP
            for (const line of layout.paragraphs[p]) {
              for (const seg of line) drawMdSeg(ctx, seg, rect.x + pad, y)
              y += LINE_HEIGHT
              if (y > bottom) break outer
            }
          }
        } else {
          // Single line: the first laid-out line, ellipsized when more follows.
          const layout = layoutMd(ctx, raw, 1e9)
          const segs = layout.paragraphs[0]?.[0] ?? []
          const yMid = firstLineCenterY(rect.y, rect.height)
          const maxX = rect.width - pad * 2
          let x = 0
          let truncated =
            layout.paragraphs.length > 1 || (layout.paragraphs[0]?.length ?? 0) > 1
          for (const seg of segs) {
            if (seg.x + seg.width > maxX) {
              truncated = true
              break
            }
            drawMdSeg(ctx, seg, rect.x + pad, yMid)
            x = seg.x + seg.width
          }
          if (truncated) {
            ctx.font = BASE_FONT
            ctx.fillStyle = theme.textDark
            ctx.fillText(' …', rect.x + pad + x, yMid)
          }
        }
        ctx.restore()
        return
      }

      // Plain text cells. Custom-draw (top-aligned) when the column wraps OR
      // when the row is taller than one line (so short cells in a tall wrapped
      // row sit at the top instead of floating in the middle). Ordinary
      // single-line rows fall through to GDG's default renderer.
      if (isText && raw.length > 0 && (colWrapped || tallRow)) {
        const maxWidth = rect.width - pad * 2
        ctx.save()
        ctx.beginPath()
        ctx.rect(rect.x, rect.y, rect.width, rect.height)
        ctx.clip()
        ctx.font = BASE_FONT
        ctx.fillStyle = theme.textDark
        ctx.textBaseline = 'middle'
        let y = firstLineCenterY(rect.y, rect.height)
        const bottom = rect.y + rect.height
        // Wrap only if this column opted into wrapping; otherwise one line.
        const paragraphs = colWrapped ? wrapParagraphs(ctx, raw, maxWidth) : [[raw]]
        outer: for (let p = 0; p < paragraphs.length; p++) {
          if (p > 0) y += PARA_GAP
          for (const line of paragraphs[p]) {
            ctx.fillText(line, rect.x + pad, y)
            y += LINE_HEIGHT
            if (y > bottom) break outer
          }
        }
        ctx.restore()
        return
      }

      drawContent()
    },
    [wrappedCols, specs, doc],
  )

  const onHeaderMenuClick = useCallback(
    (col: number, bounds: { x: number; y: number; width: number; height: number }) => {
      const spec = specs[col]
      if (spec && WRAPPABLE_KEYS.includes(spec.key as string)) {
        onHeaderMenu(spec.key as string, { x: bounds.x, y: bounds.y + bounds.height })
      }
    },
    [onHeaderMenu, specs],
  )

  // Clicking a fix pill applies its suggestion: "→ ucum" in unit cells,
  // "→ integer" in datatype cells. fixPillHit covers the pill's actual box
  // (geometry mirrors drawCell via the shared *FixPillRange helpers), so
  // ordinary clicks elsewhere in the cell never trigger the fix.
  const onCellClicked = useCallback(
    (
      [col, row]: Item,
      event: { localEventX: number; localEventY: number; bounds: { width: number; height: number } },
    ) => {
      const spec = specs[col]
      const element = doc.elements[row]
      if (element === undefined) return
      const key = spec?.key as string | undefined
      if (!fixPillHit(key, element, event.localEventX, event.localEventY, event.bounds)) return
      if (key === 'unit') {
        const code = ucumSuggestion((element.unit ?? '') as string)!.code
        apply((d) => setField(d, row, 'unit', code))
      } else if (key === 'datatype') {
        // Changing a field's datatype is consequential enough to confirm;
        // a stray click on the pill must not silently retype the field.
        const from = element.datatype || '(none)'
        if (window.confirm(`Change the datatype of "${element.id}" from ${from} to integer?`)) {
          apply((d) => setField(d, row, 'datatype', 'integer'))
        }
      }
    },
    [specs, doc, apply],
  )

  // The grid reads the mouse cursor from the hovered cell's `cursor`
  // property, so a position-dependent cursor needs hover tracking: remember
  // which cell's fix pill is under the pointer (pillHover above) and give
  // that one cell cursor: pointer in getCellContent. State only changes
  // when the pointer crosses a pill boundary, so this costs one redraw per
  // enter/leave.
  const onItemHovered = useCallback(
    (args: GridMouseEventArgs) => {
      let next: { col: number; row: number } | null = null
      // Findings tooltip: a hovered cell with validation messages shows them
      // below the cell (fixed positioning; GDG bounds are viewport coords,
      // same as the header menu). The dot column carries the row-level ones.
      let tip: { x: number; y: number; messages: string[] } | null = null
      if (args.kind === 'cell') {
        const [col, row] = args.location
        const spec = specs[col]
        const element = doc.elements[row]
        if (
          element !== undefined &&
          fixPillHit(spec?.key as string | undefined, element, args.localEventX, args.localEventY, args.bounds)
        ) {
          next = { col, row }
        }
        // Cell-scoped findings on their cell (the unit ⓘ's nudge arrives as a
        // synthesized INFO finding from App); row-level findings (no column)
        // surface when hovering the row's first (Section) cell.
        const messages =
          col === 0
            ? [
                ...(cellInfo.get(`${row}|${spec?.key as string}`)?.messages ?? []),
                ...(rowMessages.get(row) ?? []),
              ]
            : cellInfo.get(`${row}|${spec?.key as string}`)?.messages
        if (messages !== undefined && messages.length > 0) {
          tip = { x: args.bounds.x, y: args.bounds.y + args.bounds.height + 4, messages }
        }
      }
      setPillHover((prev) => (prev?.col === next?.col && prev?.row === next?.row ? prev : next))
      // Content comparison, not identity: the col-0 merge builds a fresh
      // array per event, and identity churn would redraw on every mousemove.
      setTooltip((prev) => {
        if (prev === null && tip === null) return prev
        if (
          prev !== null &&
          tip !== null &&
          prev.x === tip.x &&
          prev.y === tip.y &&
          prev.messages.join('\n') === tip.messages.join('\n')
        ) {
          return prev
        }
        return tip
      })
    },
    [specs, doc, cellInfo, rowMessages],
  )

  // Drag-reorder for the columns after Id (the frozen prefix stays put); a
  // drop inside the frozen prefix clamps to the first movable slot.
  const onColumnMoved = useCallback((from: number, to: number) => {
    if (from < FROZEN_COUNT) return
    setColOrder((prev) => {
      const next = [...prev]
      const [moved] = next.splice(from - FROZEN_COUNT, 1)
      if (moved === undefined) return prev
      next.splice(Math.max(to, FROZEN_COUNT) - FROZEN_COUNT, 0, moved)
      return next
    })
  }, [])

  // Always-visible ⋮ menu indicator on wrappable columns (GDG only draws its
  // own on hover, and the default triangle reads as a sort arrow). Blue when
  // the column is wrapped, so the state shows at a glance.
  const drawHeader: DrawHeaderCallback = useCallback(
    (args, drawContent) => {
      drawContent()
      const { ctx, column, menuBounds } = args
      if (column.hasMenu !== true) return
      const cx = menuBounds.x + menuBounds.width / 2
      const cy = menuBounds.y + menuBounds.height / 2
      const r = 1.25
      ctx.save()
      ctx.beginPath()
      for (const dy of [-r * 3.5, 0, r * 3.5]) {
        ctx.moveTo(cx + r, cy + dy)
        ctx.arc(cx, cy + dy, r, 0, Math.PI * 2)
      }
      ctx.fillStyle = wrappedCols.has(column.id as string) ? '#2563eb' : '#9aa2ab'
      ctx.fill()
      ctx.restore()
    },
    [wrappedCols],
  )

  // GDG rules grid lines over its whole viewport, existing rows or not — so
  // cap the editor's height at its content (header + rows + append row) and
  // let the host's plain background show below. min() keeps full-viewport
  // behavior (internal scrolling) whenever the content is taller.
  const contentHeight =
    GDG_HEADER_HEIGHT +
    (rowHeights !== null
      ? rowHeights.reduce((a, b) => a + b, 0)
      : doc.elements.length * MIN_ROW_HEIGHT) +
    MIN_ROW_HEIGHT + // the sticky "add element…" append row
    2

  return (
    <div style={{ height: `min(100%, ${contentHeight}px)` }}>
    <DataEditor
      ref={editorRef}
      columns={columns}
      rows={doc.elements.length}
      getCellContent={getCellContent}
      onCellEdited={onCellEdited}
      drawCell={drawCell}
      drawHeader={drawHeader}
      headerIcons={{ none: () => '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"></svg>' }}
      onRowAppended={onRowAppended}
      onRowMoved={onRowMoved}
      onColumnMoved={onColumnMoved}
      onCellClicked={onCellClicked}
      onItemHovered={onItemHovered}
      customRenderers={UNIT_RENDERERS}
      onDelete={onDelete}
      onColumnResize={onColumnResize}
      gridSelection={selection}
      onGridSelectionChange={onSelectionChange}
      onHeaderMenuClick={onHeaderMenuClick}
      showSearch={showSearch}
      onSearchClose={onSearchClose}
      rowMarkers="both"
      freezeColumns={2}
      getCellsForSelection={true}
      onPaste={true}
      trailingRowOptions={{ sticky: true, tint: true }}
      width="100%"
      height="100%"
      rowHeight={
        rowHeights !== null ? (row: number) => rowHeights[row] ?? MIN_ROW_HEIGHT : MIN_ROW_HEIGHT
      }
      smoothScrollX
      smoothScrollY
      theme={{
        accentColor: '#2563eb',
        accentLight: '#eff6ff',
        headerFontStyle: '600 12px',
        baseFontStyle: '13px',
        fontFamily: FONT_FAMILY, // must match BASE_FONT so measure == draw
        bgHeader: '#f6f8fa',
        textHeader: '#1f2328',
        borderColor: '#e9ecef',
      }}
      getRowThemeOverride={(row) => {
        // No zebra striping; only validation tints color a row.
        const level = rowLevels.get(row)
        const tint = level ? ROW_TINT[level] : undefined
        return tint ? { bgCell: tint } : undefined
      }}
    />
    {tooltip !== null ? (
      <div className="cell-tooltip" style={{ left: tooltip.x, top: tooltip.y }}>
        {tooltip.messages.map((m, i) => (
          <div key={i}>{m}</div>
        ))}
      </div>
    ) : null}
    </div>
  )
}
