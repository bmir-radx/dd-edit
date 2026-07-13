/**
 * The editor shell: toolbar, grid, tabbed right panel (element inspector,
 * previews, problems), status bar, and a welcome screen for the empty state.
 * File dialogs and disk I/O live in the main process; parsing, serialization,
 * validation, and rendering go through the sidecar; the document lives in the
 * store.
 */
import type { DataEditorRef } from '@glideapps/glide-data-grid'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ElementInspector } from './ElementInspector'
import { GridView, WRAPPABLE_KEYS } from './GridView'
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

// Problems is not a tab: it concerns the whole document while the inspector
// concerns one element, and the fix workflow (click problem → land on cell →
// edit in inspector) needs both visible — so problems live in a bottom dock.
type PanelTab = 'element' | 'csv' | 'linkml' | 'html'

function baseName(path: string | null): string {
  if (!path) return 'Untitled'
  return path.split('/').pop() ?? path
}

export function App() {
  const { doc, filePath, importedFrom, dirty, loadDocument, apply, undo, redo, markSaved, undoStack, redoStack } =
    useEditor()
  const [status, setStatus] = useState('starting sidecar…')
  const [datatypes, setDatatypes] = useState<string[]>([])
  const [panelTab, setPanelTab] = useState<PanelTab | null>('element')
  const [cursorRow, setCursorRow] = useState<number | null>(null)
  const [selectedRows, setSelectedRows] = useState<number[]>([])
  const [showSearch, setShowSearch] = useState(false)
  const [findings, setFindings] = useState<Finding[]>([])
  // Per-column wrap (persisted): toggled per column via the header chevron
  // menu; the toolbar button wraps/unwraps all wrappable columns at once.
  const [wrappedCols, setWrappedCols] = useState<ReadonlySet<string>>(() => {
    try {
      const stored = JSON.parse(localStorage.getItem('dd-edit.wrappedCols') ?? '[]')
      return new Set(Array.isArray(stored) ? stored : [])
    } catch {
      return new Set()
    }
  })
  const [headerMenu, setHeaderMenu] = useState<{ key: string; x: number; y: number } | null>(null)

  useEffect(() => {
    localStorage.setItem('dd-edit.wrappedCols', JSON.stringify([...wrappedCols]))
  }, [wrappedCols])

  const toggleWrapCol = useCallback((key: string) => {
    setWrappedCols((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])
  // The last-opened dictionary, for the welcome screen's reopen button.
  const [lastFile, setLastFile] = useState<string | null>(null)
  useEffect(() => {
    window.ddEdit.lastFile().then(setLastFile, () => {})
  }, [])

  const [panelWidth, setPanelWidth] = useState(() => {
    const stored = Number(localStorage.getItem('dd-edit.panelWidth'))
    return stored >= 280 && stored <= 800 ? stored : 400
  })

  // The problems dock (bottom), independent of the right panel; open state
  // and height persist.
  const [problemsOpen, setProblemsOpen] = useState(
    () => localStorage.getItem('dd-edit.problemsOpen') === '1',
  )
  useEffect(() => {
    localStorage.setItem('dd-edit.problemsOpen', problemsOpen ? '1' : '0')
  }, [problemsOpen])
  const [problemsHeight, setProblemsHeight] = useState(() => {
    const stored = Number(localStorage.getItem('dd-edit.problemsHeight'))
    return stored >= 120 && stored <= 600 ? stored : 220
  })
  useEffect(() => {
    localStorage.setItem('dd-edit.problemsHeight', String(problemsHeight))
  }, [problemsHeight])

  const startDockResize = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      const startY = e.clientY
      const startH = problemsHeight
      const move = (ev: PointerEvent) =>
        setProblemsHeight(Math.min(600, Math.max(120, startH + (startY - ev.clientY))))
      const up = () => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },
    [problemsHeight],
  )

  useEffect(() => {
    localStorage.setItem('dd-edit.panelWidth', String(panelWidth))
  }, [panelWidth])

  const startPanelResize = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      const startX = e.clientX
      const startW = panelWidth
      const move = (ev: PointerEvent) =>
        setPanelWidth(Math.min(800, Math.max(280, startW + (startX - ev.clientX))))
      const up = () => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },
    [panelWidth],
  )

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

  // Open a file's content as a dictionary; when parsing fails, fall back to
  // REDCap import (sniff-and-offer). A CSV that fails dictionary parsing but
  // imports as REDCap just opens: making the user find Import… first is
  // hostile. The import stays untitled — REDCap is an import format, not a
  // save format — but keeps the source path so the UI can name it.
  const openParsedOrImport = useCallback(
    async (file: { path: string; content: string }) => {
      try {
        loadDocument(await parseToDocument(file.content), file.path)
        setCursorRow(null)
      } catch (err) {
        try {
          const imported = await sidecar.importRedcap(file.content)
          loadDocument(JSON.parse(imported.content), null, undefined, file.path)
          setCursorRow(null)
          window.alert(
            `Imported ${baseName(file.path)} as a REDCap export (${imported.elements} fields).\n\n` +
              `REDCap format cannot be saved back — use Save to write it as a standard ` +
              `data dictionary (CSV, LinkML YAML, or dd-json).`,
          )
        } catch {
          window.alert(`Could not open ${baseName(file.path)}:\n${err instanceof Error ? err.message : err}`)
        }
      }
    },
    [loadDocument],
  )

  const doOpen = useCallback(async () => {
    if (!confirmDiscard()) return
    const file = await window.ddEdit.openFile()
    if (!file) return
    await openParsedOrImport(file)
  }, [confirmDiscard, openParsedOrImport])

  // Open a known path (welcome-screen reopen button, Open Recent menu).
  const doOpenPath = useCallback(
    async (path: string) => {
      if (!confirmDiscard()) return
      try {
        const file = await window.ddEdit.openPath(path)
        await openParsedOrImport(file)
      } catch (err) {
        window.alert(`Could not open ${baseName(path)}:\n${err instanceof Error ? err.message : err}`)
      }
    },
    [confirmDiscard, openParsedOrImport],
  )

  const doReopenLast = useCallback(async () => {
    if (lastFile) await doOpenPath(lastFile)
  }, [lastFile, doOpenPath])

  const doImportRedcap = useCallback(async () => {
    if (!confirmDiscard()) return
    const file = await window.ddEdit.openRedcapFile()
    if (!file) return
    try {
      const imported = await sidecar.importRedcap(file.content)
      // Untitled + dirty: an import, not an open — but named after its source.
      loadDocument(JSON.parse(imported.content), null, undefined, file.path)
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

  // Navigation into the grid (problems panel, section jumper): GridView owns
  // the scroll-and-select, since only it knows the display column order.
  const [jumpTarget, setJumpTarget] = useState<{
    row: number
    column: string | null
    nonce: number
  } | null>(null)
  const jumpToRow = useCallback((row: number, column: string | null = null) => {
    setJumpTarget((prev) => ({ row, column, nonce: (prev?.nonce ?? 0) + 1 }))
    setCursorRow(row)
  }, [])

  // ------------------------------------------------------- menu wiring

  const handlers = useRef<Record<string, (payload?: string) => void>>({})
  handlers.current = {
    new: doNew,
    open: () => void doOpen(),
    'open-recent': (path) => void (path && doOpenPath(path)),
    save: () => void doSave(),
    'save-as': () => void doSaveAs(),
    'import-redcap': () => void doImportRedcap(),
    undo,
    redo,
  }

  useEffect(() => {
    return window.ddEdit.onMenu((action, payload) => handlers.current[action]?.(payload))
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

  // The missing-unit nudge (and its siblings) arrive from the validator
  // itself since toolkit v0.0.6 — nothing is synthesized client-side, so
  // the problems list, tooltips, and jump-to-cell all ride one pipeline.
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

  // What to call the document: its file name; for an unsaved import, the
  // source it came from (so a REDCap import isn't a bare "Untitled").
  const displayName = filePath
    ? baseName(filePath)
    : importedFrom
      ? `${baseName(importedFrom)} (imported)`
      : 'Untitled'

  useEffect(() => {
    document.title = `${displayName}${dirty ? ' •' : ''} — dd-edit`
    window.ddEdit.setDirty(dirty)
  }, [displayName, dirty])

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
          {displayName}
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
        <button
          className={wrappedCols.size > 0 ? 'toggled' : ''}
          onClick={() =>
            setWrappedCols(wrappedCols.size > 0 ? new Set() : new Set(WRAPPABLE_KEYS))
          }
          title="Wrap / unwrap all columns — or per column via its header menu (▾)"
        >
          Wrap
        </button>
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
        {findings.length > 0 ? (
          <button
            className={`problem-summary ${
              errorCount > 0 ? 'error' : warningCount > 0 ? 'warning' : 'quiet'
            }${problemsOpen ? ' toggled' : ''}`}
            onClick={() => setProblemsOpen((o) => !o)}
            title="Show / hide the problems dock"
          >
            {errorCount > 0 ? <span className="err"><IconError />{errorCount}</span> : null}
            {warningCount > 0 ? <span className="warn"><IconWarning />{warningCount}</span> : null}
            {errorCount + warningCount === 0 ? <span className="info">{findings.length}</span> : null}
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
              {lastFile ? (
                <button className="primary" onClick={() => void doReopenLast()}>
                  Reopen {baseName(lastFile)}
                </button>
              ) : null}
              <button className={lastFile ? '' : 'primary'} onClick={() => void doOpen()}>
                Open a dictionary…
              </button>
              <button onClick={() => void doImportRedcap()}>Import a REDCap export…</button>
              <button onClick={addElement}>Start from scratch</button>
            </div>
            <div style={{ marginTop: 6 }}>
              Opens CSV, LinkML YAML, and dd-json. <kbd>⌘O</kbd>
            </div>
          </div>
        ) : (
          <>
            <div className="work-row">
              <div className="grid-host">
                <GridView
                  onCursorRow={setCursorRow}
                  onSelectedRows={setSelectedRows}
                  showSearch={showSearch}
                  onSearchClose={() => setShowSearch(false)}
                  findings={findings}
                  wrappedCols={wrappedCols}
                  onHeaderMenu={(key, pos) => setHeaderMenu({ key, ...pos })}
                  jumpTarget={jumpTarget}
                />
              </div>
              {panelOpen ? (
                <aside className="panel" style={{ width: panelWidth }}>
                  <div
                    className="panel-resizer"
                    onPointerDown={startPanelResize}
                    title="Drag to resize"
                  />
                  <div className="tabs">
                    {tab('element', 'Element')}
                    {tab('csv', 'CSV')}
                    {tab('linkml', 'LinkML')}
                    {tab('html', 'HTML')}
                  </div>
                  <div className="body">
                    {panelTab === 'element' ? (
                      <ElementInspector row={cursorRow} datatypes={datatypes} />
                    ) : (
                      <PreviewPane
                        format={panelTab}
                        enabled={true}
                        title={displayName}
                        selectedRows={selectedRows}
                      />
                    )}
                  </div>
                </aside>
              ) : null}
            </div>
            {problemsOpen ? (
              <section className="problems-dock" style={{ height: problemsHeight }}>
                <div
                  className="dock-resizer"
                  onPointerDown={startDockResize}
                  title="Drag to resize"
                />
                <header className="dock-head">
                  <span className="dock-title">
                    Problems{findings.length > 0 ? ` (${findings.length})` : ''}
                  </span>
                  <span className="spacer" />
                  <button className="dock-close" onClick={() => setProblemsOpen(false)} title="Close">
                    ✕
                  </button>
                </header>
                <div className="dock-body">
                  <ProblemsPanel findings={findings} onJump={jumpToRow} />
                </div>
              </section>
            ) : null}
          </>
        )}
      </div>

      {headerMenu ? (
        <>
          <div className="menu-backdrop" onClick={() => setHeaderMenu(null)} />
          <div className="header-menu" style={{ left: headerMenu.x, top: headerMenu.y }}>
            <button
              onClick={() => {
                toggleWrapCol(headerMenu.key)
                setHeaderMenu(null)
              }}
            >
              <span className="check">{wrappedCols.has(headerMenu.key) ? '✓' : ''}</span>
              Wrap text
            </button>
          </div>
        </>
      ) : null}

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
