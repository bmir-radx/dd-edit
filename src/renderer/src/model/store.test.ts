import { beforeEach, describe, expect, it } from 'vitest'
import { emptyElement, insertElement, newDocument, setField } from './document'
import { useEditor } from './store'

beforeEach(() => {
  useEditor.getState().loadDocument(newDocument(), '/tmp/x.csv')
})

describe('apply + undo/redo', () => {
  it('round-trips a mutation through undo and redo', () => {
    const s = () => useEditor.getState()
    s().apply((d) => insertElement(d, 0, { ...emptyElement(), id: 'age' }))
    s().apply((d) => setField(d, 0, 'label', 'Age'))
    expect(s().doc.elements[0].label).toBe('Age')

    s().undo()
    expect(s().doc.elements[0].label).toBe('')
    s().undo()
    expect(s().doc.elements).toHaveLength(0)
    s().redo()
    s().redo()
    expect(s().doc.elements[0].label).toBe('Age')
  })

  it('a new edit clears the redo stack', () => {
    const s = () => useEditor.getState()
    s().apply((d) => insertElement(d, 0, emptyElement()))
    s().undo()
    s().apply((d) => insertElement(d, 0, { ...emptyElement(), id: 'other' }))
    expect(s().redoStack).toHaveLength(0)
    s().redo() // no-op
    expect(s().doc.elements[0].id).toBe('other')
  })

  it('no-op mutations do not pollute the undo stack', () => {
    const s = () => useEditor.getState()
    s().apply((d) => d)
    expect(s().undoStack).toHaveLength(0)
    expect(s().dirty).toBe(false)
  })

  it('dirty tracks edits and clears on save', () => {
    const s = () => useEditor.getState()
    expect(s().dirty).toBe(false)
    s().apply((d) => insertElement(d, 0, emptyElement()))
    expect(s().dirty).toBe(true)
    s().markSaved('/tmp/x.csv')
    expect(s().dirty).toBe(false)
    s().undo() // undoing past a save is still an edit
    expect(s().dirty).toBe(true)
  })

  it('an import (null path) starts dirty; an open starts clean', () => {
    const s = () => useEditor.getState()
    s().loadDocument(newDocument(), null)
    expect(s().dirty).toBe(true)
    s().loadDocument(newDocument(), '/tmp/y.csv')
    expect(s().dirty).toBe(false)
  })
})
