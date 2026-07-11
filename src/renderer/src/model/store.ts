/**
 * The editor's single source of truth: the dd-json document, file association,
 * dirty flag, and snapshot-based undo/redo. Mutations go through apply(),
 * which pushes the previous document onto the undo stack — documents are
 * immutable with structural sharing (see document.ts), so snapshots are cheap.
 */
import { create } from 'zustand'
import type { DdDocument } from '../types/document'
import { newDocument } from './document'

const UNDO_LIMIT = 200

export interface EditorState {
  doc: DdDocument
  /**
   * The document as of open / last save. Because mutations share structure
   * (document.ts), an element is unmodified iff its object is reference-
   * present in the baseline — undoing back to the original even clears the
   * modified state exactly.
   */
  baseline: DdDocument
  /** Absolute path of the file this document was opened from; null = untitled. */
  filePath: string | null
  dirty: boolean
  undoStack: DdDocument[]
  redoStack: DdDocument[]

  /**
   * Replace the document wholesale (open / import / new). Resets history.
   * Dirtiness defaults by origin: a pathless document is an import (dirty —
   * it only exists in memory); a document from a file is clean. `dirty`
   * overrides for File > New (untitled but nothing to lose).
   */
  loadDocument: (doc: DdDocument, filePath: string | null, dirty?: boolean) => void
  /** Apply a pure mutation; a no-op mutation (same reference back) is free. */
  apply: (mutate: (doc: DdDocument) => DdDocument) => void
  undo: () => void
  redo: () => void
  markSaved: (filePath: string) => void
}

export const useEditor = create<EditorState>((set, get) => ({
  doc: newDocument(),
  baseline: newDocument(),
  filePath: null,
  dirty: false,
  undoStack: [],
  redoStack: [],

  loadDocument: (doc, filePath, dirty) =>
    set({
      doc,
      baseline: doc,
      filePath,
      dirty: dirty ?? filePath === null,
      undoStack: [],
      redoStack: [],
    }),

  apply: (mutate) => {
    const { doc, undoStack } = get()
    const next = mutate(doc)
    if (next === doc) return
    set({
      doc: next,
      dirty: true,
      undoStack: [...undoStack.slice(-(UNDO_LIMIT - 1)), doc],
      redoStack: [],
    })
  },

  undo: () => {
    const { doc, undoStack, redoStack } = get()
    const previous = undoStack[undoStack.length - 1]
    if (previous === undefined) return
    set({
      doc: previous,
      dirty: true,
      undoStack: undoStack.slice(0, -1),
      redoStack: [...redoStack, doc],
    })
  },

  redo: () => {
    const { doc, undoStack, redoStack } = get()
    const next = redoStack[redoStack.length - 1]
    if (next === undefined) return
    set({
      doc: next,
      dirty: true,
      undoStack: [...undoStack, doc],
      redoStack: redoStack.slice(0, -1),
    })
  },

  // Saving establishes the current document as the new baseline.
  markSaved: (filePath) => set({ filePath, dirty: false, baseline: get().doc }),
}))
