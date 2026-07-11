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
  type GridSelection,
  type Item,
} from '@glideapps/glide-data-grid'
import '@glideapps/glide-data-grid/dist/index.css'
import { useCallback, useMemo, useState, type Ref } from 'react'
import { deleteElements, emptyElement, insertElement, moveElement, setField } from './model/document'
import { useEditor } from './model/store'
import { findingRow, type Finding, type FindingLevel } from './sidecar'
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
const MODIFIED_BLUE = '#2563eb'

function worse(a: FindingLevel | undefined, b: FindingLevel): FindingLevel {
  return a === 'ERROR' || b === 'ERROR' ? 'ERROR' : a === 'WARNING' || b === 'WARNING' ? 'WARNING' : b
}

/** Datatype families get a hue so a column of types is scannable at a glance. */
function datatypePill(datatype: string): { bg: string; fg: string } {
  const s = datatype.toLowerCase()
  if (/(int|float|decimal|double|number)/.test(s)) return { bg: '#dbeafe', fg: '#1d4ed8' } // numeric
  if (/(date|time|year)/.test(s)) return { bg: '#ede9fe', fg: '#6d28d9' } // temporal
  if (/bool/.test(s)) return { bg: '#d1fae5', fg: '#047857' } // boolean
  if (/(url|iri|uri|email|phone|zip|sha|mime)/.test(s)) return { bg: '#cffafe', fg: '#0e7490' } // coded
  return { bg: '#f1f5f9', fg: '#475569' } // text / other
}

/** Pill colors for the categorical columns (both stay editable). */
function pillColors(key: 'cardinality' | 'datatype', text: string) {
  if (key === 'datatype') return datatypePill(text)
  return text === 'multiple' ? { bg: '#ede9fe', fg: '#6d28d9' } : { bg: '#f1f5f9', fg: '#475569' }
}

/**
 * Pastel per section, assigned by order of first appearance stepping the hue
 * wheel by the golden angle — consecutive sections land ~137° apart, so
 * neighbors are always clearly distinct (a name hash can collide, and did:
 * "Consent" and "Demographics" hashed to near-identical lavenders).
 */
function sectionTints(elements: readonly DataElement[]): Map<string, string> {
  const tints = new Map<string, string>()
  for (const element of elements) {
    const name = element.section ?? ''
    if (name === '' || tints.has(name)) continue
    tints.set(name, `hsl(${Math.round((tints.size * 137.5) % 360)} 60% 94%)`)
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
  key: keyof DataElement | '__mod'
  title: string
  width: number
  kind: 'modified' | 'text' | 'boolean' | 'bubble' | 'markdown'
  /** Blank input stores null (optional fields) rather than "". */
  nullable?: boolean
}

const COLUMNS: ColumnSpec[] = [
  { key: '__mod', title: '', width: 34, kind: 'modified' },
  // Section leads: its pastel band is the grouping gutter, frozen with Id.
  { key: 'section', title: 'Section', width: 130, kind: 'text', nullable: true },
  { key: 'id', title: 'Id', width: 160, kind: 'text' },
  { key: 'label', title: 'Label', width: 200, kind: 'text' },
  { key: 'datatype', title: 'Datatype', width: 110, kind: 'text' },
  { key: 'cardinality', title: 'Cardinality', width: 100, kind: 'text' },
  { key: 'required', title: 'Required', width: 85, kind: 'boolean' },
  { key: 'unit', title: 'Unit', width: 90, kind: 'text', nullable: true },
  { key: 'enumeration', title: 'Enumeration', width: 230, kind: 'bubble' },
  { key: 'missing_value_codes', title: 'Missing values', width: 150, kind: 'bubble' },
  { key: 'pattern', title: 'Pattern', width: 130, kind: 'text', nullable: true },
  { key: 'precondition', title: 'Precondition', width: 160, kind: 'text', nullable: true },
  { key: 'terms', title: 'Terms', width: 160, kind: 'bubble' },
  { key: 'description', title: 'Description', width: 320, kind: 'markdown', nullable: true },
  { key: 'aliases', title: 'Aliases', width: 130, kind: 'bubble' },
  { key: 'examples', title: 'Examples', width: 150, kind: 'bubble' },
  { key: 'notes', title: 'Notes', width: 200, kind: 'text', nullable: true },
  { key: 'provenance', title: 'Provenance', width: 180, kind: 'text', nullable: true },
  { key: 'see_also', title: 'See also', width: 180, kind: 'text', nullable: true },
]

/** Column keys that can wrap: text-bearing columns and pill lists. */
export const WRAPPABLE_KEYS: string[] = COLUMNS.filter(
  (c) => c.kind === 'text' || c.kind === 'markdown' || c.kind === 'bubble',
).map((c) => c.key as string)

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
  /** For imperative scrolling (problems panel, section jumper). */
  gridRef?: Ref<DataEditorRef>
}

export function GridView({
  onCursorRow,
  onSelectedRows,
  showSearch,
  onSearchClose,
  findings,
  wrappedCols,
  onHeaderMenu,
  gridRef,
}: GridViewProps) {
  const doc = useEditor((s) => s.doc)
  const baseline = useEditor((s) => s.baseline)
  const apply = useEditor((s) => s.apply)

  const [widths, setWidths] = useState<Record<string, number>>({})
  const [selection, setSelection] = useState<GridSelection>({
    columns: CompactSelection.empty(),
    rows: CompactSelection.empty(),
  })

  const baselineRefs = useMemo(() => new Set<DataElement>(baseline.elements), [baseline])
  const sectionColors = useMemo(() => sectionTints(doc.elements), [doc])

  // Row -> worst level, and "row|field" -> worst level, for the tints.
  const { rowLevels, cellLevels } = useMemo(() => {
    const rows = new Map<number, FindingLevel>()
    const cells = new Map<string, FindingLevel>()
    for (const f of findings) {
      const row = findingRow(f)
      if (row === null) continue
      rows.set(row, worse(rows.get(row), f.level))
      const key = f.column ? HEADER_TO_KEY[f.column] : undefined
      if (key) cells.set(`${row}|${key}`, worse(cells.get(`${row}|${key}`), f.level))
    }
    return { rowLevels: rows, cellLevels: cells }
  }, [findings])

  const columns = useMemo<GridColumn[]>(
    () =>
      COLUMNS.map((c) => ({
        id: c.key,
        title: c.title,
        width: widths[c.key] ?? c.width,
        // Wrappable columns get a header menu (the ⋮ we always draw in
        // drawHeader). menuIcon points at an empty sprite so the grid's own
        // hover icon (a triangle that reads as a sort arrow) never appears.
        hasMenu: WRAPPABLE_KEYS.includes(c.key as string),
        menuIcon: 'none',
      })),
    [widths],
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

  const getCellContent = useCallback(
    ([col, row]: Item): GridCell => {
      const spec = COLUMNS[col]
      const element = doc.elements[row]
      if (!spec || !element) {
        return { kind: GridCellKind.Text, data: '', displayData: '', allowOverlay: false }
      }

      if (spec.kind === 'modified') {
        const modified = !baselineRefs.has(element)
        return {
          kind: GridCellKind.Text,
          data: modified ? 'modified' : '',
          displayData: modified ? '●' : '',
          allowOverlay: false,
          themeOverride: { textDark: MODIFIED_BLUE },
        }
      }

      const key = spec.key as keyof DataElement
      const level = cellLevels.get(`${row}|${key}`)
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
      // Cardinality and datatype are custom-drawn as colored pills (drawCell
      // below) while remaining ordinary editable text cells; section shows
      // its stable pastel as the cell background (validation tint wins).
      const over: Record<string, string> = {}
      if (tint) over.bgCell = tint
      if (spec.key === 'section' && text !== '' && !tint) {
        const sectionBg = sectionColors.get(text)
        if (sectionBg) over.bgCell = sectionBg
      }
      return {
        kind: GridCellKind.Text,
        data: text,
        displayData: text,
        allowOverlay: true,
        allowWrapping: wrappedCols.has(spec.key as string), // multiline overlay editor
        ...(Object.keys(over).length > 0 ? { themeOverride: over } : {}),
      }
    },
    [doc, cellLevels, baselineRefs, wrappedCols, sectionColors],
  )

  const onCellEdited = useCallback(
    ([col, row]: Item, newValue: EditableGridCell) => {
      const spec = COLUMNS[col]
      if (!spec || spec.kind === 'modified' || spec.kind === 'bubble') return
      if (newValue.kind === GridCellKind.Boolean && spec.key === 'required') {
        apply((d) => setField(d, row, 'required', Boolean(newValue.data)))
        return
      }
      if (newValue.kind === GridCellKind.Markdown && spec.key === 'description') {
        const text = newValue.data
        apply((d) => setField(d, row, 'description', text === '' ? null : text))
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
    [apply],
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
      const spec = COLUMNS[col]
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
        const y = rect.y + (rect.height - height) / 2
        ctx.beginPath()
        ctx.roundRect(x, y, width, height, 10)
        ctx.fillStyle = bg
        ctx.fill()
        ctx.clip() // keep long text inside the pill
        ctx.fillStyle = fg
        ctx.textBaseline = 'middle'
        ctx.fillText(text, x + 8, y + height / 2 + 0.5)
        ctx.restore()
        return
      }

      // Pill lists (enumeration, terms, ...): when the column wraps, flow the
      // pills across as many rows as the cell height allows — all values
      // visible, no "+n more".
      const colWrapped = spec !== undefined && wrappedCols.has(spec.key as string)
      if (colWrapped && cell.kind === GridCellKind.Bubble && cell.data.length > 0) {
        ctx.save()
        ctx.beginPath()
        ctx.rect(rect.x, rect.y, rect.width, rect.height)
        ctx.clip()
        ctx.font = PILL_FONT
        ctx.textBaseline = 'middle'
        const left = rect.x + 6
        const right = rect.x + rect.width - 6
        let x = left
        let y = rect.y + 5
        for (const item of cell.data) {
          const w = Math.min(ctx.measureText(item).width + PILL_PAD_X * 2, right - left)
          if (x > left && x + w > right) {
            x = left
            y += PILL_H + PILL_GAP
          }
          if (y + PILL_H > rect.y + rect.height) break
          ctx.beginPath()
          ctx.roundRect(x, y, w, PILL_H, PILL_H / 2)
          ctx.fillStyle = '#eef1f4'
          ctx.fill()
          ctx.save()
          ctx.clip()
          ctx.fillStyle = '#374151'
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
          let y = rect.y + theme.cellVerticalPadding + LINE_HEIGHT / 2 + 1
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
          const yMid = rect.y + rect.height / 2 + 1
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

      // Plain text cells custom-draw only when their column wraps.
      if (colWrapped && isText && raw.length > 0) {
        const maxWidth = rect.width - pad * 2
        ctx.save()
        ctx.beginPath()
        ctx.rect(rect.x, rect.y, rect.width, rect.height)
        ctx.clip()
        ctx.font = BASE_FONT
        ctx.fillStyle = theme.textDark
        ctx.textBaseline = 'middle'
        let y = rect.y + theme.cellVerticalPadding + LINE_HEIGHT / 2 + 1
        const bottom = rect.y + rect.height
        const paragraphs = wrapParagraphs(ctx, raw, maxWidth)
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
    [wrappedCols],
  )

  const onHeaderMenuClick = useCallback(
    (col: number, bounds: { x: number; y: number; width: number; height: number }) => {
      const spec = COLUMNS[col]
      if (spec && WRAPPABLE_KEYS.includes(spec.key as string)) {
        onHeaderMenu(spec.key as string, { x: bounds.x, y: bounds.y + bounds.height })
      }
    },
    [onHeaderMenu],
  )

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

  return (
    <DataEditor
      ref={gridRef}
      columns={columns}
      rows={doc.elements.length}
      getCellContent={getCellContent}
      onCellEdited={onCellEdited}
      drawCell={drawCell}
      drawHeader={drawHeader}
      headerIcons={{ none: () => '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"></svg>' }}
      onRowAppended={onRowAppended}
      onRowMoved={onRowMoved}
      onDelete={onDelete}
      onColumnResize={onColumnResize}
      gridSelection={selection}
      onGridSelectionChange={onSelectionChange}
      onHeaderMenuClick={onHeaderMenuClick}
      showSearch={showSearch}
      onSearchClose={onSearchClose}
      rowMarkers="both"
      freezeColumns={3}
      getCellsForSelection={true}
      onPaste={true}
      trailingRowOptions={{ sticky: true, tint: true, hint: 'add element…' }}
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
  )
}
