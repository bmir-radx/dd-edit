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

/** Pill colors for the three categorical columns (all stay editable). */
function pillColors(key: 'section' | 'cardinality' | 'datatype', text: string) {
  if (key === 'datatype') return datatypePill(text)
  if (key === 'cardinality') {
    return text === 'multiple' ? { bg: '#ede9fe', fg: '#6d28d9' } : { bg: '#f1f5f9', fg: '#475569' }
  }
  return { bg: sectionTint(text), fg: '#374151' }
}

/** A stable pastel per section name (hash -> hue), light enough for text. */
function sectionTint(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360
  return `hsl(${h} 60% 94%)`
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
  { key: 'id', title: 'Id', width: 160, kind: 'text' },
  { key: 'label', title: 'Label', width: 200, kind: 'text' },
  { key: 'datatype', title: 'Datatype', width: 110, kind: 'text' },
  { key: 'cardinality', title: 'Cardinality', width: 100, kind: 'text' },
  { key: 'required', title: 'Required', width: 85, kind: 'boolean' },
  { key: 'section', title: 'Section', width: 150, kind: 'text', nullable: true },
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

const BUBBLE_CAP = 6

function bubbles(key: keyof DataElement, element: DataElement): string[] {
  let all: string[]
  if (key === 'enumeration' || key === 'missing_value_codes') {
    all = ((element[key] ?? []) as EnumItem[]).map((i) => `${i.value} = ${i.label}`)
  } else {
    all = (element[key] ?? []) as string[]
  }
  if (all.length > BUBBLE_CAP) {
    return [...all.slice(0, BUBBLE_CAP), `+${all.length - BUBBLE_CAP} more`]
  }
  return all
}

export interface GridViewProps {
  /** Reports the row under the cursor (or null) so the inspector can follow. */
  onCursorRow: (row: number | null) => void
  showSearch: boolean
  onSearchClose: () => void
  findings: Finding[]
  /** Wrap long text in cells (rows grow taller). */
  wrapText: boolean
  /** For imperative scrolling (problems panel, section jumper). */
  gridRef?: Ref<DataEditorRef>
}

export function GridView({
  onCursorRow,
  showSearch,
  onSearchClose,
  findings,
  wrapText,
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
    () => COLUMNS.map((c) => ({ id: c.key, title: c.title, width: widths[c.key] ?? c.width })),
    [widths],
  )

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
        return {
          kind: GridCellKind.Bubble,
          data: bubbles(key, element),
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
      // Section, cardinality, and datatype are custom-drawn as colored pills
      // (drawCell below) while remaining ordinary editable text cells.
      const over: Record<string, string> = {}
      if (tint) over.bgCell = tint
      return {
        kind: GridCellKind.Text,
        data: text,
        displayData: text,
        allowOverlay: true,
        allowWrapping: wrapText,
        ...(Object.keys(over).length > 0 ? { themeOverride: over } : {}),
      }
    },
    [doc, cellLevels, baselineRefs, wrapText],
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
    },
    [onCursorRow],
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
        (key === 'section' || key === 'cardinality' || key === 'datatype') &&
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

      const wrappable =
        (cell.kind === GridCellKind.Text || cell.kind === GridCellKind.Markdown) &&
        typeof (cell as { data?: unknown }).data === 'string'
      const wrapData = wrappable ? ((cell as { data: string }).data ?? '') : ''
      if (wrapText && wrappable && wrapData.length > 0) {
        const pad = theme.cellHorizontalPadding
        const maxWidth = rect.width - pad * 2
        ctx.save()
        ctx.beginPath()
        ctx.rect(rect.x, rect.y, rect.width, rect.height)
        ctx.clip()
        ctx.font = `${theme.baseFontStyle} ${theme.fontFamily}`
        ctx.fillStyle = theme.textDark
        ctx.textBaseline = 'middle'
        const lineHeight = 17
        let y = rect.y + theme.cellVerticalPadding + lineHeight / 2 + 1
        const bottom = rect.y + rect.height
        outer: for (const paragraph of wrapData.split('\n')) {
          let line = ''
          for (const word of paragraph.split(/\s+/)) {
            const candidate = line === '' ? word : `${line} ${word}`
            if (line !== '' && ctx.measureText(candidate).width > maxWidth) {
              ctx.fillText(line, rect.x + pad, y)
              y += lineHeight
              if (y > bottom) break outer
              line = word
            } else {
              line = candidate
            }
          }
          if (line !== '') {
            ctx.fillText(line, rect.x + pad, y)
            y += lineHeight
            if (y > bottom) break
          }
        }
        ctx.restore()
        return
      }

      drawContent()
    },
    [wrapText],
  )

  return (
    <DataEditor
      ref={gridRef}
      columns={columns}
      rows={doc.elements.length}
      getCellContent={getCellContent}
      onCellEdited={onCellEdited}
      drawCell={drawCell}
      onRowAppended={onRowAppended}
      onRowMoved={onRowMoved}
      onDelete={onDelete}
      onColumnResize={onColumnResize}
      gridSelection={selection}
      onGridSelectionChange={onSelectionChange}
      showSearch={showSearch}
      onSearchClose={onSearchClose}
      rowMarkers="both"
      freezeColumns={2}
      getCellsForSelection={true}
      onPaste={true}
      trailingRowOptions={{ sticky: true, tint: true, hint: 'add element…' }}
      width="100%"
      height="100%"
      rowHeight={wrapText ? 72 : 34}
      smoothScrollX
      smoothScrollY
      theme={{
        accentColor: '#2563eb',
        accentLight: '#eff6ff',
        headerFontStyle: '600 12px',
        baseFontStyle: '13px',
        bgHeader: '#f6f8fa',
        textHeader: '#1f2328',
        borderColor: '#e9ecef',
      }}
      getRowThemeOverride={(row) => {
        const level = rowLevels.get(row)
        const tint = level ? ROW_TINT[level] : undefined
        if (tint) return { bgCell: tint }
        return row % 2 === 1 ? { bgCell: '#fafbfc' } : undefined
      }}
    />
  )
}
