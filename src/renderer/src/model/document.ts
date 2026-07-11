/**
 * Pure operations over the dd-json document. Every function returns a NEW
 * document with structural sharing (untouched elements keep their identity),
 * which is what makes snapshot-based undo cheap: an undo stack of documents
 * shares almost everything.
 */
import type { DataElement, DdDocument } from '../types/document'

export function newDocument(): DdDocument {
  return { format: 'dd-json', version: 1, elements: [] }
}

/** A fresh element with the always-present fields at their blank values. */
export function emptyElement(): DataElement {
  return {
    id: '',
    label: '',
    datatype: 'string',
    cardinality: 'single',
    required: false,
    aliases: [],
    description: null,
    section: null,
    terms: [],
    pattern: null,
    unit: null,
    enumeration: [],
    missing_value_codes: [],
    precondition: null,
    examples: [],
    notes: null,
    provenance: null,
    see_also: null,
  }
}

export function setField<K extends keyof DataElement>(
  doc: DdDocument,
  index: number,
  field: K,
  value: DataElement[K],
): DdDocument {
  const current = doc.elements[index]
  if (current === undefined || current[field] === value) return doc
  const elements = doc.elements.slice()
  elements[index] = { ...current, [field]: value }
  return { ...doc, elements }
}

export function insertElement(doc: DdDocument, index: number, element: DataElement): DdDocument {
  const elements = doc.elements.slice()
  elements.splice(index, 0, element)
  return { ...doc, elements }
}

export function deleteElements(doc: DdDocument, indices: readonly number[]): DdDocument {
  if (indices.length === 0) return doc
  const drop = new Set(indices)
  return { ...doc, elements: doc.elements.filter((_, i) => !drop.has(i)) }
}

/** Move the element at `from` so it sits at `to` (indices in the pre-move list). */
export function moveElement(doc: DdDocument, from: number, to: number): DdDocument {
  if (from === to) return doc
  const elements = doc.elements.slice()
  const [moved] = elements.splice(from, 1)
  if (moved === undefined) return doc
  elements.splice(to, 0, moved)
  return { ...doc, elements }
}
