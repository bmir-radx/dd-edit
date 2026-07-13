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
import { useEffect, useMemo, useRef, useState } from 'react'

// The REDCap converter (and hand-written dictionaries) separate paragraphs
// with single newlines; without breaks, marked would join them into one blob.
marked.setOptions({ breaks: true })
import { setField } from './model/document'
import { useEditor } from './model/store'
import { CommitInput, CommitTextarea, CommitWrapInput, StringListEditor } from './inputs'
import {
  ALIAS_DATATYPES,
  HARMONIZATION_TARGET,
  LINKML_NATIVE,
  needsIntegerDatatype,
  preferredDatatype,
  wantsUnit,
} from './datatypes'
import { idNeedsCleanup, sanitizeId } from './ids'
import { pillColors } from './pillColors'
import { PreconditionField } from './PreconditionField'
import { sidecar } from './sidecar'
import { UCUM_UNITS, ucumSuggestion, ucumUnit } from './ucum'
import type { DataElement, EnumItem } from './types/document'

/** Pill colors for the value badge over a datatype/cardinality select. */
function pillStyle(key: 'datatype' | 'cardinality', value: string) {
  const { bg, fg } = pillColors(key, value)
  return { background: bg, color: fg } as const
}

/**
 * A small (?) icon in a field label that toggles an inline help note. Inline
 * (not a hover tooltip) so it can hold a few sentences, survives the panel's
 * scrolling, and stays up while the user types in the field it explains.
 */
function FieldHelp({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        className={`help-dot${open ? ' open' : ''}`}
        title={open ? 'Hide help' : 'What goes in this field?'}
        onClick={(e) => {
          e.preventDefault() // don't let the surrounding <label> grab focus
          setOpen((o) => !o)
        }}
      >
        ?
      </button>
      {open ? <span className="field-help">{children}</span> : null}
    </>
  )
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
          <span>Section <Dot k="section" /></span>
          <CommitInput value={text('section')} onCommit={commitNullable('section')} />
        </label>
        <label className="field">
          <span>Id (variable name) <Dot k="id" /></span>
          <CommitInput value={element.id} onCommit={commitText('id')} />
          {idNeedsCleanup(element.id) ? (
            <div className="fix-hint">
              Schema renderings rename this id to <code>{sanitizeId(element.id)}</code>, and
              preconditions can't reference it as written.
              <button
                type="button"
                onClick={() => apply((d) => setField(d, index, 'id', sanitizeId(element.id)))}
              >
                Use {sanitizeId(element.id)}
              </button>
            </div>
          ) : null}
        </label>
        <label className="field">
          <span>Label <Dot k="label" /></span>
          <CommitWrapInput value={element.label} onCommit={commitText('label')} />
        </label>
        <label className="field">
          <span>
            Precondition <Dot k="precondition" />
            <FieldHelp>
              When this field applies, as a condition over <em>other</em> fields' values —
              blank means it always applies; when the condition is false the cell must be
              blank (not applicable). Defined by the Data Dictionary Specification. Predicates:{' '}
              <code>field = "1"</code>, <code>field &lt;&gt; ""</code> (not blank),{' '}
              <code>field in {'{'}"1", "2"{'}'}</code>, <code>field contains "3"</code>{' '}
              (multi-valued fields), and <code>&lt; &lt;= &gt; &gt;=</code> for numeric or
              date fields. Combine with <code>and</code> / <code>or</code> and parentheses
              (<code>and</code> binds tighter). Type-ahead offers the legal completions as
              you type.
            </FieldHelp>
          </span>
          <PreconditionField
            value={text('precondition')}
            onCommit={commitNullable('precondition')}
            elements={doc.elements}
            selfId={element.id}
          />
        </label>
        <div className="field">
          <span className="tag-label">Aliases <Dot k="aliases" /></span>
          <StringListEditor
            values={(element.aliases ?? []) as string[]}
            onChange={(v) => apply((d) => setField(d, index, 'aliases', v))}
            placeholder="alternative id"
            addLabel="+ add alias"
          />
        </div>
      </section>

      <section className="card">
        <h3>Type</h3>
        <div className="row2">
          <label className="field">
            <span>
              Datatype <Dot k="datatype" />
              <FieldHelp>
                What kind of value the field holds, named per the XSD datatype
                vocabulary. The <strong>Common</strong> group (<code>string</code>,{' '}
                <code>integer</code>, <code>decimal</code>, <code>boolean</code>,{' '}
                <code>date</code>, <code>dateTime</code>, …) maps directly onto schema
                types and is preferred; everything under <strong>Other</strong> renders
                as a generated custom type. <code>date_mdy</code> / <code>date_dmy</code>{' '}
                are slash-formatted dates and <code>timestamp</code> a Unix time — use
                the native <code>date</code> / <code>dateTime</code> unless the datafile
                really stores those formats.
              </FieldHelp>
            </span>
            <div className="pill-field">
              <select
                value={element.datatype}
                onChange={(e) => apply((d) => setField(d, index, 'datatype', e.target.value))}
              >
                {/* keep an out-of-vocabulary value visible instead of silently swapping it */}
                {!datatypes.includes(element.datatype) && (
                  <option value={element.datatype}>{element.datatype || '(none)'}</option>
                )}
                <optgroup label="Common">
                  {datatypes.filter((dt) => LINKML_NATIVE.has(dt)).map((dt) => (
                    <option key={dt} value={dt}>{dt}</option>
                  ))}
                </optgroup>
                <optgroup label="Other">
                  {datatypes.filter((dt) => !LINKML_NATIVE.has(dt)).map((dt) => (
                    <option key={dt} value={dt}>{dt}</option>
                  ))}
                </optgroup>
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
        {HARMONIZATION_TARGET[element.datatype] !== undefined ? (
          // A quiet statement, deliberately without a one-click: date_mdy
          // truthfully describes mm/dd/yyyy source data, and changing the
          // dictionary alone would make it lie. Harmonize the data first.
          <div className="soft-hint">
            REDCap format — valid as-is. When the datafile is harmonized to ISO
            dates, change this to <code>{HARMONIZATION_TARGET[element.datatype]}</code>.
          </div>
        ) : preferredDatatype(element.datatype) !== null ? (
          <div className="fix-hint">
            <span className="msg">
              {ALIAS_DATATYPES.has(element.datatype) ? (
                <>
                  <code>{element.datatype}</code> names a storage width, not a meaning — the
                  semantic type is <code>{preferredDatatype(element.datatype)}</code>.
                </>
              ) : (
                <>
                  <code>{element.datatype}</code> renders as a generated custom type —
                  preferred: <code>{preferredDatatype(element.datatype)}</code>.
                </>
              )}
            </span>
            <button
              type="button"
              onClick={() =>
                apply((d) => setField(d, index, 'datatype', preferredDatatype(element.datatype)!))
              }
            >
              Use
            </button>
          </div>
        ) : null}
        <label className="check">
          <input
            type="checkbox"
            checked={element.required}
            onChange={(e) => apply((d) => setField(d, index, 'required', e.target.checked))}
          />
          Required <Dot k="required" />
        </label>
        <label className="field">
          <span>
            Unit <Dot k="unit" />
            <FieldHelp>
              Units are <strong>UCUM</strong> codes — the Unified Code for Units of Measure
              (ucum.org), the standard LOINC and FHIR use. Suggestions come from a curated list
              of codes common in research data; any free text is accepted, but UCUM codes are
              machine-readable and carry into the LinkML rendering. Codes are case-sensitive:
              <code>mL</code>, not <code>ml</code>.
            </FieldHelp>
          </span>
          <UnitInput value={text('unit')} onCommit={commitNullable('unit')} />
          <UnitAssist value={text('unit')} onUse={commitNullable('unit')} />
          {wantsUnit(element) ? (
            // Deliberately quiet (not amber): counts and scores are
            // legitimately unitless, so this is a nudge, not a problem.
            <div className="soft-hint">
              Numeric field with no unit — consider a UCUM unit, or <code>1</code>{' '}
              (dimensionless) for counts and scores.
            </div>
          ) : null}
        </label>
        <label className="field">
          <span>Pattern (regex) <Dot k="pattern" /></span>
          <CommitInput className="mono" value={text('pattern')} onCommit={commitNullable('pattern')} />
        </label>
        <div className="field">
          <span className="tag-label">Ontology terms <Dot k="terms" /></span>
          <TermListEditor
            values={(element.terms ?? []) as string[]}
            onChange={(v) => apply((d) => setField(d, index, 'terms', v))}
          />
        </div>
      </section>

      <section className="card">
        <h3>Enumeration <Dot k="enumeration" /></h3>
        {needsIntegerDatatype(element) ? (
          <div className="fix-hint">
            <span className="msg">
              Values look like integers, but Datatype is{' '}
              <code>{element.datatype || '(none)'}</code>.
            </span>
            <button
              type="button"
              onClick={() => apply((d) => setField(d, index, 'datatype', 'integer'))}
            >
              Set to integer
            </button>
          </div>
        ) : null}
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
          <StringListEditor
            values={(element.examples ?? []) as string[]}
            onChange={(v) => apply((d) => setField(d, index, 'examples', v))}
            placeholder="example value"
            addLabel="+ add example"
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

/** The browseable IRI for a term: OBO CURIEs expand by the PURL rule. */
function termIri(term: string): string | null {
  const t = term.trim()
  if (/^https?:\/\//.test(t)) return t
  const curie = /^([A-Za-z_][A-Za-z0-9_.-]*):(.+)$/.exec(t)
  if (curie) return `http://purl.obolibrary.org/obo/${curie[1]}_${curie[2]}`
  return null
}

// Term -> resolved label, shared across elements and inspector remounts.
// null records a finished lookup with no result, so misses aren't re-fetched.
const termLabels = new Map<string, string | null>()

/**
 * Ontology terms as a list: an editable identifier per row (IRI or OBO
 * CURIE), the term's resolved human-readable label under it, and an out-link
 * to browse the term externally. Labels resolve through the sidecar (OLS4)
 * and are cached; no network, no label — the list still works.
 */
function TermListEditor({
  values,
  onChange,
}: {
  values: string[]
  onChange: (values: string[]) => void
}) {
  const [, setResolved] = useState(0) // bump to re-render when lookups land

  useEffect(() => {
    const missing = values.filter((t) => t.trim() !== '' && !termLabels.has(t.trim()))
    if (missing.length === 0) return
    const timer = setTimeout(async () => {
      try {
        const res = await sidecar.lookupTerms(missing)
        for (const t of missing) termLabels.set(t.trim(), res.labels[t.trim()] ?? null)
      } catch {
        // Offline / lookup failure: leave uncached so a later edit retries.
      }
      setResolved((n) => n + 1)
    }, 400)
    return () => clearTimeout(timer)
  }, [values])

  const update = (i: number, v: string) => {
    const text = v.trim()
    onChange(
      text === '' ? values.filter((_, j) => j !== i) : values.map((old, j) => (j === i ? text : old)),
    )
  }

  return (
    <div>
      {values.map((term, i) => {
        const iri = termIri(term)
        const label = termLabels.get(term.trim())
        return (
          <div className="term-item" key={i}>
            <CommitInput
              className="mono term"
              value={term}
              placeholder="IRI or OBO id, e.g. MONDO:0004979"
              onCommit={(v) => update(i, v)}
            />
            <button
              className="linkout"
              title={iri ? `Browse ${iri}` : 'Not a resolvable IRI / OBO id'}
              disabled={iri === null}
              onClick={() => iri && void window.ddEdit.openExternal(iri)}
            >
              ↗
            </button>
            <button className="remove" title="Remove" onClick={() => onChange(values.filter((_, j) => j !== i))}>
              ×
            </button>
            {label ? (
              <div className="term-label">{label}</div>
            ) : label === null ? (
              // The lookup finished and found nothing: probably a wrong
              // prefix or local id (lookup FAILURES stay uncached, not null).
              <div className="term-label warn">not found in OLS — check the prefix / id</div>
            ) : null}
          </div>
        )
      })}
      <button className="add-item" onClick={() => onChange([...values, ''])}>
        + add term
      </button>
    </div>
  )
}

/**
 * The Unit input: a combobox over the curated UCUM subset (filter by code or
 * name), replacing the native datalist so the dropdown can SAY it's a small
 * subset — with a datalist, the list read as the complete vocabulary. Commit
 * semantics match CommitInput (blur/Enter = one undo step; Escape reverts).
 */
function UnitInput({ value, onCommit }: { value: string; onCommit: (value: string) => void }) {
  const [draft, setDraft] = useState(value)
  const [open, setOpen] = useState(false)
  const [hi, setHi] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const hiRef = useRef<HTMLDivElement>(null)
  // accept() blurs, and the blur commit runs with this render's (stale)
  // draft — without this guard it overwrites the accepted code with the
  // typed fragment (or clears it when nothing was typed).
  const justAccepted = useRef(false)
  useEffect(() => {
    setDraft(value)
  }, [value])
  useEffect(() => {
    hiRef.current?.scrollIntoView({ block: 'nearest' })
  }, [hi, open])

  const needle = draft.trim().toLowerCase()
  const items = UCUM_UNITS.filter(
    (u) =>
      needle === '' ||
      u.code.toLowerCase().includes(needle) ||
      u.name.toLowerCase().includes(needle),
  ).slice(0, 40)

  const accept = (code: string) => {
    justAccepted.current = true
    setDraft(code)
    setOpen(false)
    if (code !== value) onCommit(code)
    inputRef.current?.blur()
  }
  const commit = () => {
    setOpen(false)
    if (justAccepted.current) {
      justAccepted.current = false
      return
    }
    if (draft.trim() !== value) onCommit(draft.trim())
  }

  return (
    <div className="pc-wrap">
      <input
        ref={inputRef}
        type="text"
        value={draft}
        placeholder="UCUM unit, e.g. mg/dL"
        onChange={(e) => {
          setDraft(e.target.value)
          setOpen(true)
          setHi(0)
        }}
        onFocus={() => setOpen(true)}
        onBlur={commit}
        onKeyDown={(e) => {
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
              accept(items[Math.min(hi, items.length - 1)].code)
              return
            }
            if (e.key === 'Escape') {
              setOpen(false)
              return
            }
          }
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'Escape') setDraft(value)
        }}
      />
      {open && items.length > 0 ? (
        <div className="pc-suggest">
          <div className="suggest-note">
            Common UCUM units — a small subset; any UCUM code or free text is valid
          </div>
          {items.map((u, i) => (
            <div
              key={u.code}
              ref={i === hi ? hiRef : undefined}
              className={`pc-item${i === hi ? ' hi' : ''}`}
              onPointerDown={(e) => {
                e.preventDefault() // keep focus; no blur-commit race
                accept(u.code)
              }}
            >
              <span className="main value">{u.code}</span>
              <span className="detail">{u.name}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/**
 * Under the Unit field: names a recognized UCUM code, or offers the UCUM
 * equivalent of an informal spelling ("years" → a) as a one-click fix.
 * Purely advisory — any free-text unit remains legal. The shared <datalist>
 * gives the input native autocomplete over the curated UCUM codes.
 */
function UnitAssist({ value, onUse }: { value: string; onUse: (unit: string) => void }) {
  const known = ucumUnit(value)
  const suggestion = known ? null : ucumSuggestion(value)
  return (
    <>
      {known ? (
        <div className="unit-hint ok">✓ UCUM: {known.name}</div>
      ) : suggestion ? (
        <div className="fix-hint">
          <span className="msg">
            UCUM equivalent: <code>{suggestion.code}</code> ({suggestion.name}).
          </span>
          <button type="button" onClick={() => onUse(suggestion.code)}>
            Use
          </button>
        </div>
      ) : null}
    </>
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
