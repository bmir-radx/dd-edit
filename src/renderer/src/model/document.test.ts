import { describe, expect, it } from 'vitest'
import {
  deleteElements,
  emptyElement,
  insertElement,
  moveElement,
  newDocument,
  setField,
} from './document'

function docWithIds(...ids: string[]) {
  let doc = newDocument()
  ids.forEach((id, i) => {
    doc = insertElement(doc, i, { ...emptyElement(), id })
  })
  return doc
}

describe('setField', () => {
  it('replaces only the touched element (structural sharing)', () => {
    const doc = docWithIds('a', 'b')
    const next = setField(doc, 0, 'label', 'Age')
    expect(next.elements[0].label).toBe('Age')
    expect(next.elements[1]).toBe(doc.elements[1]) // untouched element: same identity
    expect(doc.elements[0].label).toBe('') // original untouched
  })

  it('is a no-op (same reference) when the value is unchanged', () => {
    const doc = docWithIds('a')
    expect(setField(doc, 0, 'id', 'a')).toBe(doc)
  })

  it('is a no-op for an out-of-range index', () => {
    const doc = docWithIds('a')
    expect(setField(doc, 5, 'label', 'x')).toBe(doc)
  })
})

describe('insert / delete / move', () => {
  it('inserts at the given position', () => {
    const doc = insertElement(docWithIds('a', 'c'), 1, { ...emptyElement(), id: 'b' })
    expect(doc.elements.map((e) => e.id)).toEqual(['a', 'b', 'c'])
  })

  it('deletes a set of indices', () => {
    const doc = deleteElements(docWithIds('a', 'b', 'c', 'd'), [1, 3])
    expect(doc.elements.map((e) => e.id)).toEqual(['a', 'c'])
  })

  it('moves an element forward and backward', () => {
    const doc = docWithIds('a', 'b', 'c')
    expect(moveElement(doc, 0, 2).elements.map((e) => e.id)).toEqual(['b', 'c', 'a'])
    expect(moveElement(doc, 2, 0).elements.map((e) => e.id)).toEqual(['c', 'a', 'b'])
  })
})
