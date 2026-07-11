/**
 * The spreadsheet: rows are data elements, columns are the spec's fields.
 *
 * Milestone-2 scope: inline editing of the scalar fields (text + the required
 * checkbox), append via the trailing row, drag row-reorder, multi-row
 * selection + delete, copy/paste of cell ranges. List-valued fields
 * (enumeration, missing-value codes, terms, aliases, examples) render as
 * read-only summaries here; their structured editors are milestone 3.
 */
import {
  CompactSelection,
  DataEditor,
  GridCellKind,
  type EditableGridCell,
  type GridCell,
  type GridColumn,
  type GridSelection,
  type Item,
} from '@glideapps/glide-data-grid'
import '@glideapps/glide-data-grid/dist/index.css'
import { useCallback, useMemo, useState } from 'react'
import { deleteElements, emptyElement, insertElement, moveElement, setField } from './model/document'
import { useEditor } from './model/store'
import type { DataElement, EnumItem } from './types/document'

type ScalarKey =
  | 'id'
  | 'label'
  | 'datatype'
  | 'cardinality'
  | 'section'
  | 'unit'
  | 'pattern'
  | 'description'
  | 'precondition'
  | 'notes'
  | 'provenance'
  | 'see_also'

interface ColumnSpec {
  key: keyof DataElement
  title: string
  width: number
  kind: 'text' | 'boolean' | 'summary'
  /** Blank input stores null (optional fields) rather than "". */
  nullable?: boolean
}

const COLUMNS: ColumnSpec[] = [
  { key: 'id', title: 'Id', width: 160, kind: 'text' },
  { key: 'label', title: 'Label', width: 200, kind: 'text' },
  { key: 'datatype', title: 'Datatype', width: 110, kind: 'text' },
  { key: 'cardinality', title: 'Cardinality', width: 100, kind: 'text' },
  { key: 'required', title: 'Required', width: 85, kind: 'boolean' },
  { key: 'section', title: 'Section', width: 150, kind: 'text', nullable: true },
  { key: 'unit', title: 'Unit', width: 90, kind: 'text', nullable: true },
  { key: 'enumeration', title: 'Enumeration', width: 220, kind: 'summary' },
  { key: 'missing_value_codes', title: 'Missing values', width: 140, kind: 'summary' },
  { key: 'pattern', title: 'Pattern', width: 130, kind: 'text', nullable: true },
  { key: 'precondition', title: 'Precondition', width: 160, kind: 'text', nullable: true },
  { key: 'terms', title: 'Terms', width: 150, kind: 'summary' },
  { key: 'description', title: 'Description', width: 320, kind: 'text', nullable: true },
  { key: 'aliases', title: 'Aliases', width: 120, kind: 'summary' },
  { key: 'examples', title: 'Examples', width: 140, kind: 'summary' },
  { key: 'notes', title: 'Notes', width: 200, kind: 'text', nullable: true },
  { key: 'provenance', title: 'Provenance', width: 180, kind: 'text', nullable: true },
  { key: 'see_also', title: 'See also', width: 180, kind: 'text', nullable: true },
]

function summarize(key: keyof DataElement, element: DataElement): string {
  if (key === 'enumeration' || key === 'missing_value_codes') {
    const items = (element[key] ?? []) as EnumItem[]
    if (items.length === 0) return ''
    const shown = items.slice(0, 3).map((i) => `${i.value}=${i.label}`).join(' | ')
    return items.length > 3 ? `${shown} … (${items.length})` : shown
  }
  const list = (element[key] ?? []) as string[]
  return list.join(' | ')
}

export interface GridViewProps {
  /** Reports the row under the cursor (or null) so the inspector can follow. */
  onCursorRow: (row: number | null) => void
  showSearch: boolean
  onSearchClose: () => void
}

export function GridView({ onCursorRow, showSearch, onSearchClose }: GridViewProps) {
  const doc = useEditor((s) => s.doc)
  const apply = useEditor((s) => s.apply)

  const [widths, setWidths] = useState<Record<string, number>>({})
  const [selection, setSelection] = useState<GridSelection>({
    columns: CompactSelection.empty(),
    rows: CompactSelection.empty(),
  })

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
      if (spec.kind === 'boolean') {
        return { kind: GridCellKind.Boolean, data: Boolean(element[spec.key]), allowOverlay: false }
      }
      if (spec.kind === 'summary') {
        const text = summarize(spec.key, element)
        return {
          kind: GridCellKind.Text,
          data: text,
          displayData: text,
          allowOverlay: true,
          readonly: true,
          themeOverride: { textDark: '#888888' },
        }
      }
      const raw = element[spec.key as ScalarKey]
      const text = raw == null ? '' : String(raw)
      return { kind: GridCellKind.Text, data: text, displayData: text, allowOverlay: true }
    },
    [doc],
  )

  const onCellEdited = useCallback(
    ([col, row]: Item, newValue: EditableGridCell) => {
      const spec = COLUMNS[col]
      if (!spec || spec.kind === 'summary') return
      if (newValue.kind === GridCellKind.Boolean && spec.key === 'required') {
        apply((d) => setField(d, row, 'required', Boolean(newValue.data)))
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

  return (
    <DataEditor
      columns={columns}
      rows={doc.elements.length}
      getCellContent={getCellContent}
      onCellEdited={onCellEdited}
      onRowAppended={onRowAppended}
      onRowMoved={onRowMoved}
      onDelete={onDelete}
      onColumnResize={onColumnResize}
      gridSelection={selection}
      onGridSelectionChange={onSelectionChange}
      showSearch={showSearch}
      onSearchClose={onSearchClose}
      rowMarkers="both"
      freezeColumns={1}
      getCellsForSelection={true}
      onPaste={true}
      trailingRowOptions={{ sticky: true, tint: true, hint: 'add element…' }}
      width="100%"
      height="100%"
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
      getRowThemeOverride={(row) => (row % 2 === 1 ? { bgCell: '#fafbfc' } : undefined)}
    />
  )
}
