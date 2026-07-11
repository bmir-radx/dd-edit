/**
 * The editor shell: toolbar, grid, tabbed right panel (element inspector,
 * previews, problems), status bar, and a welcome screen for the empty state.
 * File dialogs and disk I/O live in the main process; parsing, serialization,
 * validation, and rendering go through the sidecar; the document lives in the
 * store.
 */
import type { DataEditorRef } from '@glideapps/glide-data-grid'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ElementInspector } from './ElementInspector'
import { GridView } from './GridView'
import {
  IconError,
  IconImport,
  IconNew,
  IconOpen,
  IconPlus,
  IconRedo,
  IconSave,
  IconSearch,
  IconUndo,
  IconWarning,
} from './icons'
import { emptyElement, insertElement, newDocument } from './model/document'
import { useEditor } from './model/store'
import { parseToDocument, serializeForPath, sidecar, type Finding } from './sidecar'
import { PreviewPane } from './PreviewPane'
import { ProblemsPanel } from './ProblemsPanel'

type PanelTab = 'element' | 'csv' | 'linkml' | 'html' | 'problems'

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
  const [findings, setFindings] = useState<Finding[]>([])
  const gridRef = useRef<DataEditorRef | null>(null)

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

  const jumpToRow = useCallback((row: number) => {
    gridRef.current?.scrollTo(0, row, 'both', 0, 0, { vAlign: 'center' })
    setCursorRow(row)
  }, [])

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

  // ------------------------------------------------- validation loop

  useEffect(() => {
    if (doc.elements.length === 0) {
      setFindings([])
      return
    }
    const timer = setTimeout(async () => {
      try {
        const res = await sidecar.validate(JSON.stringify(doc))
        setFindings(res.findings)
      } catch {
        // The document may be transiently unconvertible; keep the old findings.
      }
    }, 500)
    return () => clearTimeout(timer)
  }, [doc])

  const errorCount = findings.filter((f) => f.level === 'ERROR').length
  const warningCount = findings.filter((f) => f.level === 'WARNING').length

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
    window.ddEdit.setDirty(dirty)
  }, [filePath, dirty])

  // -------------------------------------------------------------- layout

  // Sections with their first row, for the jump navigator.
  const sections: { name: string; row: number }[] = []
  doc.elements.forEach((e, i) => {
    const name = e.section ?? ''
    if (name && sections[sections.length - 1]?.name !== name) sections.push({ name, row: i })
  })

  const panelOpen = panelTab !== null
  const tab = (id: PanelTab, label: React.ReactNode) => (
    <button className={panelTab === id ? 'active' : ''} onClick={() => setPanelTab(id)}>
      {label}
    </button>
  )

  return (
    <div className={`app${window.ddEdit.platform === 'darwin' ? ' mac' : ''}`}>
      <header className="toolbar">
        <span className="file-name">
          {baseName(filePath)}
          {dirty ? <span className="dirty-dot"> •</span> : null}
        </span>
        <div className="group">
          <button onClick={doNew}><IconNew />New</button>
          <button onClick={() => void doOpen()}><IconOpen />Open…</button>
          <button onClick={() => void doSave()}><IconSave />Save</button>
        </div>
        <button onClick={() => void doImportRedcap()}><IconImport />REDCap…</button>
        <span className="sep" />
        <button onClick={addElement}><IconPlus />Element</button>
        <div className="group">
          <button onClick={undo} disabled={undoStack.length === 0} title="Undo (⌘Z)"><IconUndo />Undo</button>
          <button onClick={redo} disabled={redoStack.length === 0} title="Redo (⇧⌘Z)"><IconRedo />Redo</button>
        </div>
        <button onClick={() => setShowSearch(true)} title="Search (⌘F)"><IconSearch />Search</button>
        {sections.length > 1 ? (
          <select
            className="section-jump"
            value=""
            onChange={(e) => {
              const row = Number(e.target.value)
              if (!Number.isNaN(row)) jumpToRow(row)
            }}
          >
            <option value="" disabled>
              Jump to section…
            </option>
            {sections.map((s) => (
              <option key={s.row} value={s.row}>
                {s.name}
              </option>
            ))}
          </select>
        ) : null}
        <span className="spacer" />
        {errorCount + warningCount > 0 ? (
          <button className="problem-summary" onClick={() => setPanelTab('problems')}>
            {errorCount > 0 ? <span className="err"><IconError />{errorCount}</span> : null}
            {warningCount > 0 ? <span className="warn"><IconWarning />{warningCount}</span> : null}
          </button>
        ) : null}
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
                findings={findings}
                gridRef={gridRef}
              />
            </div>
            {panelOpen ? (
              <aside className="panel">
                <div className="tabs">
                  {tab('element', 'Element')}
                  {tab('csv', 'CSV')}
                  {tab('linkml', 'LinkML')}
                  {tab('html', 'HTML')}
                  {tab(
                    'problems',
                    findings.length > 0 ? `Problems (${findings.length})` : 'Problems',
                  )}
                </div>
                <div className="body">
                  {panelTab === 'element' ? (
                    <ElementInspector row={cursorRow} datatypes={datatypes} />
                  ) : panelTab === 'problems' ? (
                    <ProblemsPanel findings={findings} onJump={jumpToRow} />
                  ) : (
                    <PreviewPane format={panelTab} enabled={true} title={baseName(filePath)} />
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
        {errorCount > 0 ? <span className="stat-err">{errorCount} errors</span> : null}
        {warningCount > 0 ? <span className="stat-warn">{warningCount} warnings</span> : null}
        <span className="spacer" />
        <span>{status}</span>
      </footer>
    </div>
  )
}
