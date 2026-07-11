/**
 * The editor shell: toolbar, grid, tabbed right panel (element inspector +
 * CSV / LinkML previews), status bar, and a welcome screen for the empty
 * state. File dialogs and disk I/O live in the main process; parsing and
 * serialization go through the sidecar; the document lives in the store.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ElementInspector } from './ElementInspector'
import { GridView } from './GridView'
import { emptyElement, insertElement, newDocument } from './model/document'
import { useEditor } from './model/store'
import { parseToDocument, serializeForPath, sidecar } from './sidecar'
import { PreviewPane } from './PreviewPane'

type PanelTab = 'element' | 'csv' | 'linkml'

function baseName(path: string | null): string {
  if (!path) return 'Untitled'
  return path.split('/').pop() ?? path
}

export function App() {
  const { doc, filePath, dirty, loadDocument, apply, undo, redo, markSaved, undoStack, redoStack } =
    useEditor()
  const [status, setStatus] = useState('starting sidecar…')
  const [datatypes, setDatatypes] = useState<string[]>([])
  const [panelTab, setPanelTab] = useState<PanelTab | null>('element')
  const [cursorRow, setCursorRow] = useState<number | null>(null)
  const [showSearch, setShowSearch] = useState(false)

  const isEmpty = doc.elements.length === 0 && filePath === null && !dirty

  // ------------------------------------------------------------ commands

  const confirmDiscard = useCallback((): boolean => {
    return !useEditor.getState().dirty || window.confirm('Discard unsaved changes?')
  }, [])

  const doNew = useCallback(() => {
    if (!confirmDiscard()) return
    loadDocument(newDocument(), null, false)
    setCursorRow(null)
  }, [confirmDiscard, loadDocument])

  const doOpen = useCallback(async () => {
    if (!confirmDiscard()) return
    const file = await window.ddEdit.openFile()
    if (!file) return
    try {
      loadDocument(await parseToDocument(file.content), file.path)
      setCursorRow(null)
    } catch (err) {
      // Sniff-and-offer: a CSV that fails dictionary parsing but imports as
      // REDCap gets offered as an import instead of a bare error.
      try {
        const imported = await sidecar.importRedcap(file.content)
        if (
          window.confirm(
            `${baseName(file.path)} is not a data dictionary, but it looks like a REDCap export ` +
              `(${imported.elements} fields). Import it?`,
          )
        ) {
          loadDocument(JSON.parse(imported.content), null)
          setCursorRow(null)
        }
      } catch {
        window.alert(`Could not open ${baseName(file.path)}:\n${err instanceof Error ? err.message : err}`)
      }
    }
  }, [confirmDiscard, loadDocument])

  const doImportRedcap = useCallback(async () => {
    if (!confirmDiscard()) return
    const file = await window.ddEdit.openRedcapFile()
    if (!file) return
    try {
      const imported = await sidecar.importRedcap(file.content)
      loadDocument(JSON.parse(imported.content), null) // untitled + dirty: an import, not an open
      setCursorRow(null)
    } catch (err) {
      window.alert(`REDCap import failed:\n${err instanceof Error ? err.message : err}`)
    }
  }, [confirmDiscard, loadDocument])

  const saveTo = useCallback(
    async (path: string) => {
      try {
        const content = await serializeForPath(useEditor.getState().doc, path)
        await window.ddEdit.saveFile(path, content)
        markSaved(path)
      } catch (err) {
        window.alert(`Save failed:\n${err instanceof Error ? err.message : err}`)
      }
    },
    [markSaved],
  )

  const doSaveAs = useCallback(async () => {
    const current = useEditor.getState().filePath
    const path = await window.ddEdit.chooseSavePath(current ?? 'dictionary.dd.csv')
    if (path) await saveTo(path)
  }, [saveTo])

  const doSave = useCallback(async () => {
    const current = useEditor.getState().filePath
    if (current) await saveTo(current)
    else await doSaveAs()
  }, [saveTo, doSaveAs])

  const addElement = useCallback(() => {
    const at = cursorRow === null ? useEditor.getState().doc.elements.length : cursorRow + 1
    apply((d) => insertElement(d, at, emptyElement()))
    setCursorRow(at)
    setPanelTab('element')
  }, [apply, cursorRow])

  // ------------------------------------------------------- menu wiring

  const handlers = useRef<Record<string, () => void>>({})
  handlers.current = {
    new: doNew,
    open: () => void doOpen(),
    save: () => void doSave(),
    'save-as': () => void doSaveAs(),
    'import-redcap': () => void doImportRedcap(),
    undo,
    redo,
  }

  useEffect(() => {
    return window.ddEdit.onMenu((action) => handlers.current[action]?.())
  }, [])

  // Cmd/Ctrl+F opens the grid's search overlay.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault()
        setShowSearch(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // ------------------------------------------------------------ startup

  useEffect(() => {
    ;(async () => {
      try {
        const health = await sidecar.health()
        const meta = await sidecar.meta()
        setDatatypes(meta.datatypes)
        setStatus(`toolkit ${health.versions['dd-api'] ?? '?'}`)
      } catch (e) {
        setStatus(`sidecar error: ${e instanceof Error ? e.message : e}`)
      }
    })()
  }, [])

  useEffect(() => {
    document.title = `${baseName(filePath)}${dirty ? ' •' : ''} — dd-edit`
  }, [filePath, dirty])

  // -------------------------------------------------------------- layout

  const panelOpen = panelTab !== null
  return (
    <div className="app">
      <header className="toolbar">
        <span className="file-name">
          {baseName(filePath)}
          {dirty ? <span className="dirty-dot"> •</span> : null}
        </span>
        <div className="group">
          <button onClick={doNew}>New</button>
          <button onClick={() => void doOpen()}>Open…</button>
          <button onClick={() => void doSave()}>Save</button>
        </div>
        <button onClick={() => void doImportRedcap()}>Import REDCap…</button>
        <span className="sep" />
        <div className="group">
          <button onClick={addElement}>+ Element</button>
        </div>
        <div className="group">
          <button onClick={undo} disabled={undoStack.length === 0} title="Undo (⌘Z)">↩ Undo</button>
          <button onClick={redo} disabled={redoStack.length === 0} title="Redo (⇧⌘Z)">↪ Redo</button>
        </div>
        <button onClick={() => setShowSearch(true)} title="Search (⌘F)">Search</button>
        <span className="spacer" />
        <button onClick={() => setPanelTab(panelOpen ? null : 'element')}>
          {panelOpen ? 'Hide panel' : 'Show panel'}
        </button>
      </header>

      <div className="main">
        {isEmpty ? (
          <div className="welcome">
            <h2>dd-edit</h2>
            <div>Edit data dictionaries like a spreadsheet.</div>
            <div className="actions">
              <button className="primary" onClick={() => void doOpen()}>Open a dictionary…</button>
              <button onClick={() => void doImportRedcap()}>Import a REDCap export…</button>
              <button onClick={addElement}>Start from scratch</button>
            </div>
            <div style={{ marginTop: 6 }}>
              Opens CSV, LinkML YAML, and dd-json. <kbd>⌘O</kbd>
            </div>
          </div>
        ) : (
          <>
            <div className="grid-host">
              <GridView
                onCursorRow={setCursorRow}
                showSearch={showSearch}
                onSearchClose={() => setShowSearch(false)}
              />
            </div>
            {panelOpen ? (
              <aside className="panel">
                <div className="tabs">
                  <button
                    className={panelTab === 'element' ? 'active' : ''}
                    onClick={() => setPanelTab('element')}
                  >
                    Element
                  </button>
                  <button
                    className={panelTab === 'csv' ? 'active' : ''}
                    onClick={() => setPanelTab('csv')}
                  >
                    CSV
                  </button>
                  <button
                    className={panelTab === 'linkml' ? 'active' : ''}
                    onClick={() => setPanelTab('linkml')}
                  >
                    LinkML
                  </button>
                </div>
                <div className="body">
                  {panelTab === 'element' ? (
                    <ElementInspector row={cursorRow} datatypes={datatypes} />
                  ) : (
                    <PreviewPane format={panelTab} enabled={true} />
                  )}
                </div>
              </aside>
            ) : null}
          </>
        )}
      </div>

      <footer className="statusbar">
        <span>{doc.elements.length} elements</span>
        {cursorRow !== null && doc.elements[cursorRow] ? (
          <span>
            row {cursorRow + 1}: <code>{doc.elements[cursorRow].id || '(no id)'}</code>
          </span>
        ) : null}
        <span className="spacer" />
        <span>{status}</span>
      </footer>
    </div>
  )
}
