/**
 * The element inspector: full structured editing of the selected element —
 * dropdowns for datatype (from /meta) and cardinality, a Markdown editor with
 * preview for the description, one-per-line editors for the string lists, and
 * value/label/IRI item editors for enumeration and missing-value codes.
 *
 * Fields changed since open / last save carry a blue dot; a brand-new element
 * carries a "new" chip instead (every field would otherwise be dotted).
 */
import { marked } from 'marked'
import { useMemo, useState } from 'react'

// The REDCap converter (and hand-written dictionaries) separate paragraphs
// with single newlines; without breaks, marked would join them into one blob.
marked.setOptions({ breaks: true })
import { setField } from './model/document'
import { useEditor } from './model/store'
import { CommitInput, CommitTextarea, CommitWrapInput, TagEditor } from './inputs'
import { pillColors } from './pillColors'
import type { DataElement, EnumItem } from './types/document'

/** Pill colors for the value badge over a datatype/cardinality select. */
function pillStyle(key: 'datatype' | 'cardinality', value: string) {
  const { bg, fg } = pillColors(key, value)
  return { background: bg, color: fg } as const
}

type NullableTextKey =
  | 'description' | 'section' | 'unit' | 'pattern' | 'precondition'
  | 'notes' | 'provenance' | 'see_also'
type ItemsKey = 'enumeration' | 'missing_value_codes'

export function ElementInspector({ row, datatypes }: { row: number | null; datatypes: string[] }) {
  const doc = useEditor((s) => s.doc)
  const baseline = useEditor((s) => s.baseline)
  const apply = useEditor((s) => s.apply)
  const element = row === null ? undefined : doc.elements[row]

  const baselineRefs = useMemo(() => new Set<DataElement>(baseline.elements), [baseline])

  if (row === null || element === undefined) {
    return (
      <div className="inspector">
        <div className="hint">Select a row in the grid to edit its element here.</div>
      </div>
    )
  }
  const index = row

  // Modified-state: untouched elements are reference-identical to the
  // baseline; for touched ones, diff field-by-field against the baseline
  // element with the same id (id edits make it effectively new).
  const untouched = baselineRefs.has(element)
  const counterpart = untouched ? element : baseline.elements.find((e) => e.id === element.id)
  const isNew = !untouched && counterpart === undefined
  const changed = (key: keyof DataElement): boolean => {
    if (untouched || isNew || counterpart === undefined) return false
    return JSON.stringify(element[key] ?? null) !== JSON.stringify(counterpart[key] ?? null)
  }

  const Dot = ({ k }: { k: keyof DataElement }) =>
    changed(k) ? <span className="mod-dot" title="Modified since open / last save">●</span> : null

  const commitText = (key: 'id' | 'label' | 'datatype') => (value: string) =>
    apply((d) => setField(d, index, key, value))
  const commitNullable = (key: NullableTextKey) => (value: string) =>
    apply((d) => setField(d, index, key, value === '' ? null : value))
  const items = (key: ItemsKey): EnumItem[] => (element[key] ?? []) as EnumItem[]
  const commitItems = (key: ItemsKey, next: EnumItem[]) =>
    apply((d) => setField(d, index, key, next))

  const text = (key: NullableTextKey): string => (element[key] ?? '') as string

  return (
    <div className="inspector">
      <div className="inspector-head">
        <span className="el-id">{element.id || '(no id)'}</span>
        {isNew ? <span className="chip new">new</span> : null}
        {!isNew && !untouched ? <span className="chip modified">modified</span> : null}
      </div>

      <section className="card">
        <h3>Identity</h3>
        <label className="field">
          <span>Id (variable name) <Dot k="id" /></span>
          <CommitInput value={element.id} onCommit={commitText('id')} />
        </label>
        <label className="field">
          <span>Label <Dot k="label" /></span>
          <CommitWrapInput value={element.label} onCommit={commitText('label')} />
        </label>
        <label className="field">
          <span>Section <Dot k="section" /></span>
          <CommitInput value={text('section')} onCommit={commitNullable('section')} />
        </label>
        <div className="field">
          <span className="tag-label">Aliases <Dot k="aliases" /></span>
          <TagEditor
            values={(element.aliases ?? []) as string[]}
            onChange={(v) => apply((d) => setField(d, index, 'aliases', v))}
            placeholder="add an alternative id…"
          />
        </div>
      </section>

      <section className="card">
        <h3>Type</h3>
        <div className="row2">
          <label className="field">
            <span>Datatype <Dot k="datatype" /></span>
            <div className="pill-field">
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
              <span className="value-pill" style={pillStyle('datatype', element.datatype)}>
                {element.datatype || '(none)'}
              </span>
            </div>
          </label>
          <label className="field">
            <span>Cardinality <Dot k="cardinality" /></span>
            <div className="pill-field">
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
              <span className="value-pill" style={pillStyle('cardinality', element.cardinality)}>
                {element.cardinality}
              </span>
            </div>
          </label>
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={element.required}
            onChange={(e) => apply((d) => setField(d, index, 'required', e.target.checked))}
          />
          Required <Dot k="required" />
        </label>
        <label className="field">
          <span>Unit <Dot k="unit" /></span>
          <CommitInput value={text('unit')} onCommit={commitNullable('unit')} />
        </label>
        <label className="field">
          <span>Pattern (regex) <Dot k="pattern" /></span>
          <CommitInput className="mono" value={text('pattern')} onCommit={commitNullable('pattern')} />
        </label>
        <label className="field">
          <span>Precondition <Dot k="precondition" /></span>
          <CommitInput value={text('precondition')} onCommit={commitNullable('precondition')} />
        </label>
        <div className="field">
          <span className="tag-label">Ontology terms <Dot k="terms" /></span>
          <TagEditor
            values={(element.terms ?? []) as string[]}
            onChange={(v) => apply((d) => setField(d, index, 'terms', v))}
            placeholder="add a term IRI or OBO id…"
            variant="violet"
          />
        </div>
      </section>

      <section className="card">
        <h3>Enumeration <Dot k="enumeration" /></h3>
        <EnumItemsEditor
          items={items('enumeration')}
          onChange={(n) => commitItems('enumeration', n)}
        />
      </section>

      <section className="card">
        <h3>Missing-value codes <Dot k="missing_value_codes" /></h3>
        <EnumItemsEditor
          items={items('missing_value_codes')}
          onChange={(n) => commitItems('missing_value_codes', n)}
        />
      </section>

      <section className="card">
        <h3>Documentation</h3>
        <DescriptionField
          value={text('description')}
          changed={changed('description')}
          onCommit={commitNullable('description')}
        />
        <label className="field">
          <span>Notes <Dot k="notes" /></span>
          <CommitTextarea value={text('notes')} onCommit={commitNullable('notes')} rows={2} />
        </label>
        <div className="field">
          <span className="tag-label">Example values <Dot k="examples" /></span>
          <TagEditor
            values={(element.examples ?? []) as string[]}
            onChange={(v) => apply((d) => setField(d, index, 'examples', v))}
            placeholder="add an example value…"
          />
        </div>
        <div className="row2">
          <label className="field">
            <span>Provenance <Dot k="provenance" /></span>
            <CommitInput value={text('provenance')} onCommit={commitNullable('provenance')} />
          </label>
          <label className="field">
            <span>See also (URL) <Dot k="see_also" /></span>
            <CommitInput value={text('see_also')} onCommit={commitNullable('see_also')} />
          </label>
        </div>
      </section>
    </div>
  )
}

/**
 * Description editor with a Markdown preview toggle. Rendering uses marked
 * (already a grid dependency); the app's CSP has no unsafe-inline script-src,
 * so markdown-injected handlers/scripts cannot execute.
 */
function DescriptionField({
  value,
  changed,
  onCommit,
}: {
  value: string
  changed: boolean
  onCommit: (value: string) => void
}) {
  // Preview by default: reading the rendered description is the common case;
  // click Edit to change it.
  const [mode, setMode] = useState<'edit' | 'preview'>('preview')
  const html = useMemo(
    () => (mode === 'preview' ? (marked.parse(value || '_No description._') as string) : ''),
    [mode, value],
  )

  return (
    <label className="field">
      <span className="field-head">
        <span>
          Description — Markdown{' '}
          {changed ? (
            <span className="mod-dot" title="Modified since open / last save">●</span>
          ) : null}
        </span>
        <span className="seg-toggle" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'edit'}
            className={mode === 'edit' ? 'active' : ''}
            onClick={() => setMode('edit')}
          >
            Edit
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'preview'}
            className={mode === 'preview' ? 'active' : ''}
            onClick={() => setMode('preview')}
          >
            Preview
          </button>
        </span>
      </span>
      {mode === 'edit' ? (
        <CommitTextarea value={value} onCommit={onCommit} rows={5} />
      ) : (
        <div
          className="md-preview"
          onClick={() => setMode('edit')}
          title="Click to edit"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
    </label>
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
          <CommitInput
            className="value"
            value={item.value}
            placeholder="value"
            onCommit={(v) => update(i, { value: v })}
          />
          <CommitInput value={item.label} placeholder="label" onCommit={(v) => update(i, { label: v })} />
          <button className="remove" title="Remove" onClick={() => remove(i)}>×</button>
          <CommitInput
            className="iri"
            value={item.iri ?? ''}
            placeholder="Ontology term IRI (optional)"
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
