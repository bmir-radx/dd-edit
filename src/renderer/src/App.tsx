/**
 * The editor shell: toolbar (file state + actions), the grid, and the CSV
 * preview. File dialogs and disk I/O live in the main process; parsing and
 * serialization go through the sidecar; the document lives in the store.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { GridView } from './GridView'
import { newDocument } from './model/document'
import { useEditor } from './model/store'
import { parseToDocument, serializeForPath, sidecar } from './sidecar'
import { PreviewPane } from './PreviewPane'

function baseName(path: string | null): string {
  if (!path) return 'Untitled'
  return path.split('/').pop() ?? path
}

export function App() {
  const { doc, filePath, dirty, loadDocument, undo, redo, markSaved } = useEditor()
  const [status, setStatus] = useState('starting sidecar…')
  const [showPreview, setShowPreview] = useState(true)

  // ------------------------------------------------------------ commands

  const confirmDiscard = useCallback((): boolean => {
    return !useEditor.getState().dirty || window.confirm('Discard unsaved changes?')
  }, [])

  const doNew = useCallback(() => {
    if (!confirmDiscard()) return
    loadDocument(newDocument(), null, false)
  }, [confirmDiscard, loadDocument])

  const doOpen = useCallback(async () => {
    if (!confirmDiscard()) return
    const file = await window.ddEdit.openFile()
    if (!file) return
    try {
      loadDocument(await parseToDocument(file.content), file.path)
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

  // ------------------------------------------------------------ startup

  useEffect(() => {
    ;(async () => {
      try {
        const health = await sidecar.health()
        const meta = await sidecar.meta()
        setStatus(
          `toolkit ${health.versions['dd-api'] ?? '?'} · ${meta.datatypes.length} datatypes`,
        )
      } catch (e) {
        setStatus(`sidecar error: ${e instanceof Error ? e.message : e}`)
      }
    })()
  }, [])

  useEffect(() => {
    document.title = `${baseName(filePath)}${dirty ? ' •' : ''} — dd-edit`
  }, [filePath, dirty])

  // -------------------------------------------------------------- layout

  const button = { padding: '4px 10px', fontSize: 13 } as const
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 10px',
          borderBottom: '1px solid #ddd',
          fontFamily: 'system-ui',
        }}
      >
        <strong style={{ fontSize: 14 }}>
          {baseName(filePath)}
          {dirty ? ' •' : ''}
        </strong>
        <span style={{ flex: 1 }} />
        <button style={button} onClick={doOpen}>Open…</button>
        <button style={button} onClick={() => void doSave()}>Save</button>
        <button style={button} onClick={() => void doImportRedcap()}>Import REDCap…</button>
        <button style={button} onClick={undo}>Undo</button>
        <button style={button} onClick={redo}>Redo</button>
        <button style={button} onClick={() => setShowPreview((v) => !v)}>
          {showPreview ? 'Hide preview' : 'Show preview'}
        </button>
      </header>

      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <div style={{ flex: 2, minWidth: 0 }}>
          <GridView />
        </div>
        {showPreview ? (
          <div style={{ flex: 1, minWidth: 0, borderLeft: '1px solid #ddd' }}>
            <PreviewPane />
          </div>
        ) : null}
      </div>

      <footer
        style={{
          padding: '3px 10px',
          fontSize: 12,
          color: '#666',
          borderTop: '1px solid #ddd',
          fontFamily: 'system-ui',
        }}
      >
        {doc.elements.length} elements · {status}
      </footer>
    </div>
  )
}
