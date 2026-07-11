/**
 * The element inspector: full structured editing of the selected element —
 * dropdowns for datatype (from /meta) and cardinality, multiline text for
 * description/notes, one-per-line editors for the string lists, and
 * value/label/IRI item editors for enumeration and missing-value codes.
 * The grid is for bulk work; this panel is for detail work.
 */
import { setField } from './model/document'
import { useEditor } from './model/store'
import { CommitInput, CommitTextarea } from './inputs'
import type { DataElement, EnumItem } from './types/document'

type NullableTextKey =
  | 'description' | 'section' | 'unit' | 'pattern' | 'precondition'
  | 'notes' | 'provenance' | 'see_also'
type ListKey = 'aliases' | 'terms' | 'examples'
type ItemsKey = 'enumeration' | 'missing_value_codes'

export function ElementInspector({ row, datatypes }: { row: number | null; datatypes: string[] }) {
  const doc = useEditor((s) => s.doc)
  const apply = useEditor((s) => s.apply)
  const element = row === null ? undefined : doc.elements[row]

  if (row === null || element === undefined) {
    return (
      <div className="inspector">
        <div className="hint">Select a row in the grid to edit its element here.</div>
      </div>
    )
  }
  const index = row

  const commitText = (key: 'id' | 'label' | 'datatype') => (value: string) =>
    apply((d) => setField(d, index, key, value))
  const commitNullable = (key: NullableTextKey) => (value: string) =>
    apply((d) => setField(d, index, key, value === '' ? null : value))
  const commitList = (key: ListKey) => (value: string) =>
    apply((d) =>
      setField(d, index, key, value.split('\n').map((s) => s.trim()).filter(Boolean)),
    )
  const items = (key: ItemsKey): EnumItem[] => (element[key] ?? []) as EnumItem[]
  const commitItems = (key: ItemsKey, next: EnumItem[]) =>
    apply((d) => setField(d, index, key, next))

  const text = (key: NullableTextKey): string => (element[key] ?? '') as string
  const listText = (key: ListKey): string => ((element[key] ?? []) as string[]).join('\n')

  return (
    <div className="inspector">
      <h3>Identity</h3>
      <label className="field">
        <span>Id (variable name)</span>
        <CommitInput value={element.id} onCommit={commitText('id')} />
      </label>
      <label className="field">
        <span>Label</span>
        <CommitInput value={element.label} onCommit={commitText('label')} />
      </label>
      <label className="field">
        <span>Section</span>
        <CommitInput value={text('section')} onCommit={commitNullable('section')} />
      </label>

      <h3>Type</h3>
      <div className="row2">
        <label className="field">
          <span>Datatype</span>
          <select
            value={element.datatype}
            onChange={(e) => apply((d) => setField(d, index, 'datatype', e.target.value))}
          >
            {/* keep an out-of-vocabulary value visible instead of silently swapping it */}
            {!datatypes.includes(element.datatype) && (
              <option value={element.datatype}>{element.datatype || '(none)'}</option>
            )}
            {datatypes.map((dt) => (
              <option key={dt} value={dt}>{dt}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Cardinality</span>
          <select
            value={element.cardinality}
            onChange={(e) =>
              apply((d) =>
                setField(d, index, 'cardinality', e.target.value as DataElement['cardinality']),
              )
            }
          >
            <option value="single">single</option>
            <option value="multiple">multiple</option>
          </select>
        </label>
      </div>
      <label className="check">
        <input
          type="checkbox"
          checked={element.required}
          onChange={(e) => apply((d) => setField(d, index, 'required', e.target.checked))}
        />
        Required
      </label>
      <div className="row2">
        <label className="field">
          <span>Unit</span>
          <CommitInput value={text('unit')} onCommit={commitNullable('unit')} />
        </label>
        <label className="field">
          <span>Pattern (regex)</span>
          <CommitInput value={text('pattern')} onCommit={commitNullable('pattern')} />
        </label>
      </div>
      <label className="field">
        <span>Precondition</span>
        <CommitInput value={text('precondition')} onCommit={commitNullable('precondition')} />
      </label>

      <h3>Enumeration</h3>
      <EnumItemsEditor items={items('enumeration')} onChange={(n) => commitItems('enumeration', n)} />

      <h3>Missing-value codes</h3>
      <EnumItemsEditor
        items={items('missing_value_codes')}
        onChange={(n) => commitItems('missing_value_codes', n)}
      />

      <h3>Documentation</h3>
      <label className="field">
        <span>Description</span>
        <CommitTextarea value={text('description')} onCommit={commitNullable('description')} rows={4} />
      </label>
      <label className="field">
        <span>Notes</span>
        <CommitTextarea value={text('notes')} onCommit={commitNullable('notes')} rows={2} />
      </label>
      <div className="row2">
        <label className="field">
          <span>Provenance</span>
          <CommitInput value={text('provenance')} onCommit={commitNullable('provenance')} />
        </label>
        <label className="field">
          <span>See also (URL)</span>
          <CommitInput value={text('see_also')} onCommit={commitNullable('see_also')} />
        </label>
      </div>

      <h3>Lists</h3>
      <label className="field">
        <span>Ontology terms — one per line</span>
        <CommitTextarea value={listText('terms')} onCommit={commitList('terms')} rows={2} />
      </label>
      <div className="row2">
        <label className="field">
          <span>Aliases — one per line</span>
          <CommitTextarea value={listText('aliases')} onCommit={commitList('aliases')} rows={2} />
        </label>
        <label className="field">
          <span>Examples — one per line</span>
          <CommitTextarea value={listText('examples')} onCommit={commitList('examples')} rows={2} />
        </label>
      </div>
    </div>
  )
}

function EnumItemsEditor({
  items,
  onChange,
}: {
  items: EnumItem[]
  onChange: (items: EnumItem[]) => void
}) {
  const update = (i: number, patch: Partial<EnumItem>) =>
    onChange(items.map((item, j) => (j === i ? { ...item, ...patch } : item)))
  const remove = (i: number) => onChange(items.filter((_, j) => j !== i))

  return (
    <div>
      {items.map((item, i) => (
        <div className="enum-item" key={i}>
          <CommitInput value={item.value} placeholder="value" onCommit={(v) => update(i, { value: v })} />
          <CommitInput value={item.label} placeholder="label" onCommit={(v) => update(i, { label: v })} />
          <button className="remove" title="Remove" onClick={() => remove(i)}>×</button>
          <CommitInput
            className="iri"
            value={item.iri ?? ''}
            placeholder="ontology IRI (optional)"
            onCommit={(v) => update(i, { iri: v === '' ? null : v })}
          />
        </div>
      ))}
      <button className="add-item" onClick={() => onChange([...items, { value: '', label: '', iri: null }])}>
        + add value
      </button>
    </div>
  )
}
