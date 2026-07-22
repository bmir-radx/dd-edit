/**
 * Electron main process: owns the Python sidecar's lifecycle, file dialogs +
 * disk I/O, and the application menu.
 *
 * Startup: pick a free port -> spawn the sidecar with a fresh bearer token ->
 * poll /health until it answers -> open the window. The renderer gets the
 * port + token over IPC and talks to the sidecar directly.
 *
 * Dev overrides:
 *   DD_EDIT_SIDECAR_URL  use an already-running sidecar (e.g. uvicorn --reload)
 *   DD_EDIT_SIDECAR_CMD  custom spawn command, e.g. "/path/python -m dd_edit_sidecar"
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, shell, type MenuItemConstructorOptions } from 'electron'
import { type ChildProcess, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'

const token = randomBytes(24).toString('hex')
let sidecar: ChildProcess | null = null
let sidecarUrl: string | null = process.env.DD_EDIT_SIDECAR_URL ?? null

// ---------------------------------------------------------------- sidecar

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

function sidecarCommand(): { cmd: string; args: string[] } {
  // The override is the FULL command (only --port is appended), e.g.
  // DD_EDIT_SIDECAR_CMD="/some/python -m dd_edit_sidecar"
  const override = process.env.DD_EDIT_SIDECAR_CMD
  if (override) {
    const [cmd, ...args] = override.split(' ')
    return { cmd, args }
  }
  // Packaged: the PyInstaller one-dir bundle shipped in extraResources
  // (see electron-builder.yml); its executable takes just --port.
  if (app.isPackaged) {
    const exe = process.platform === 'win32' ? 'dd-edit-sidecar.exe' : 'dd-edit-sidecar'
    return { cmd: path.join(process.resourcesPath, 'sidecar', exe), args: [] }
  }
  // Dev: prefer the sidecar's own venv; fall back to whatever python3 is around.
  const venvPython = path.join(app.getAppPath(), 'sidecar', '.venv', 'bin', 'python')
  const cmd = existsSync(venvPython) ? venvPython : 'python3'
  return { cmd, args: ['-m', 'dd_edit_sidecar'] }
}

async function waitForHealth(url: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/health`)
      if (res.ok) return
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error(`sidecar did not become healthy at ${url}`)
}

async function startSidecar(): Promise<void> {
  if (sidecarUrl) {
    await waitForHealth(sidecarUrl)
    return
  }
  const port = await freePort()
  const { cmd, args } = sidecarCommand()
  sidecar = spawn(cmd, [...args, '--port', String(port)], {
    env: { ...process.env, DD_EDIT_TOKEN: token },
    // cwd must be a real directory. In a packaged app getAppPath() points
    // INSIDE app.asar — a file — and spawn fails with ENOTDIR; use the
    // bundled binary's own directory there instead.
    cwd: app.isPackaged ? path.dirname(cmd) : app.getAppPath(),
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  sidecar.on('exit', (code) => {
    console.error(`sidecar exited with code ${code}`)
    sidecar = null
  })
  sidecarUrl = `http://127.0.0.1:${port}`
  await waitForHealth(sidecarUrl)
}

// ------------------------------------------------------------- file I/O

const DICTIONARY_FILTERS = [
  { name: 'Data dictionaries (CSV, LinkML, dd-json)', extensions: ['csv', 'yaml', 'yml', 'json'] },
  { name: 'All files', extensions: ['*'] },
]
const REDCAP_FILTERS = [
  { name: 'REDCap data dictionary export (CSV)', extensions: ['csv'] },
  { name: 'All files', extensions: ['*'] },
]

// Tiny persisted settings: the folder last used in a file dialog (so Open
// re-opens where the user actually works) and the last dictionary file
// itself (so the welcome screen can offer to reopen it).
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json')
interface Settings {
  lastDir?: string
  lastFile?: string
  /** Most recent first, existing-at-open-time, capped. */
  recentFiles?: string[]
}

const RECENT_FILES_MAX = 10
let settings: Settings | null = null

async function getSettings(): Promise<Settings> {
  if (settings === null) {
    try {
      settings = JSON.parse(await readFile(settingsPath(), 'utf8'))
    } catch {
      settings = {}
    }
  }
  return settings!
}

async function saveSettings(): Promise<void> {
  try {
    await writeFile(settingsPath(), JSON.stringify(settings ?? {}), 'utf8')
  } catch {
    /* remembering is best-effort */
  }
}

async function rememberDir(filePath: string): Promise<void> {
  const s = await getSettings()
  s.lastDir = path.dirname(filePath)
  await saveSettings()
}

async function rememberFile(filePath: string): Promise<void> {
  const s = await getSettings()
  s.lastDir = path.dirname(filePath)
  s.lastFile = filePath
  s.recentFiles = [filePath, ...(s.recentFiles ?? []).filter((f) => f !== filePath)].slice(
    0,
    RECENT_FILES_MAX,
  )
  await saveSettings()
  buildMenu() // refresh the Open Recent submenu
}

async function openAndRead(filters: typeof DICTIONARY_FILTERS, remember = false) {
  const { lastDir } = await getSettings()
  const res = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters,
    ...(lastDir ? { defaultPath: lastDir } : {}),
  })
  const file = res.filePaths[0]
  if (res.canceled || !file) return null
  void (remember ? rememberFile(file) : rememberDir(file))
  return { path: file, content: await readFile(file, 'utf8') }
}

ipcMain.handle('sidecar-info', () => ({
  url: sidecarUrl,
  token: process.env.DD_EDIT_SIDECAR_URL ? null : token,
}))
ipcMain.handle('dialog:open', () => openAndRead(DICTIONARY_FILTERS, true))
ipcMain.handle('dialog:open-redcap', () => openAndRead(REDCAP_FILTERS))
// The last-opened dictionary, for the welcome screen's reopen button.
ipcMain.handle('last-file', async () => {
  const { lastFile } = await getSettings()
  return lastFile && existsSync(lastFile) ? lastFile : null
})
ipcMain.handle('file:open-path', async (_event, filePath: string) => {
  const content = await readFile(filePath, 'utf8')
  void rememberFile(filePath)
  return { path: filePath, content }
})
ipcMain.handle('dialog:save-as', async (_event, defaultName: string) => {
  // An absolute default (Save on an already-saved file) wins; otherwise
  // suggest the last-used folder.
  const { lastDir } = await getSettings()
  const defaultPath =
    path.isAbsolute(defaultName) ? defaultName
    : lastDir ? path.join(lastDir, defaultName)
    : defaultName
  const res = await dialog.showSaveDialog({ defaultPath, filters: DICTIONARY_FILTERS })
  if (res.canceled || !res.filePath) return null
  void rememberDir(res.filePath)
  return res.filePath
})
ipcMain.handle('file:save', async (_event, filePath: string, content: string) => {
  await writeFile(filePath, content, 'utf8')
  void rememberFile(filePath) // a save-as target becomes the reopen candidate
})
// The standard "save your changes?" three-button sheet, for replacing the
// current document (New / Open / Import with unsaved edits). The renderer
// runs the actual save; this just asks the question natively.
ipcMain.handle('dialog:confirm-discard', (event, name: string) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  const choice = dialog.showMessageBoxSync(win ?? BrowserWindow.getFocusedWindow()!, {
    type: 'warning',
    message: `Do you want to save the changes you made to ${name}?`,
    detail: "Your changes will be lost if you don't save them.",
    buttons: ['Save', "Don't Save", 'Cancel'],
    defaultId: 0,
    cancelId: 2,
  })
  return (['save', 'discard', 'cancel'] as const)[choice]
})
ipcMain.handle('shell:open-external', async (_event, url: string) => {
  // Only web URLs — never file:// or app-defined schemes from renderer input.
  if (/^https?:\/\//i.test(url)) await shell.openExternal(url)
})

// ----------------------------------------------------------------- menu

function sendMenu(action: string, payload?: string): void {
  BrowserWindow.getFocusedWindow()?.webContents.send('menu', action, payload)
}

/** The File ▸ Open Recent submenu, from the (cached) settings. */
function recentFilesSubmenu(): MenuItemConstructorOptions[] {
  const home = app.getPath('home')
  const recents = (settings?.recentFiles ?? []).filter((f) => existsSync(f))
  if (recents.length === 0) {
    return [{ label: 'No Recent Files', enabled: false }]
  }
  return [
    ...recents.map<MenuItemConstructorOptions>((f) => ({
      label: f.startsWith(home) ? `~${f.slice(home.length)}` : f,
      click: () => sendMenu('open-recent', f),
    })),
    { type: 'separator' },
    {
      label: 'Clear Menu',
      click: () => {
        void (async () => {
          const s = await getSettings()
          s.recentFiles = []
          await saveSettings()
          buildMenu()
        })()
      },
    },
  ]
}

function buildMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' } as MenuItemConstructorOptions] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New', accelerator: 'CmdOrCtrl+N', click: () => sendMenu('new') },
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: () => sendMenu('open') },
        { label: 'Open Recent', submenu: recentFilesSubmenu() },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => sendMenu('save') },
        { label: 'Save As…', accelerator: 'Shift+CmdOrCtrl+S', click: () => sendMenu('save-as') },
        { type: 'separator' },
        { label: 'Import REDCap Export…', click: () => sendMenu('import-redcap') },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        // Document-level undo/redo lives in the renderer's store, not the DOM.
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: () => sendMenu('undo') },
        { label: 'Redo', accelerator: 'Shift+CmdOrCtrl+Z', click: () => sendMenu('redo') },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Toggle Side Panel',
          accelerator: 'CmdOrCtrl+B',
          click: () => sendMenu('toggle-panel'),
        },
        {
          label: 'Toggle Problems',
          accelerator: 'Shift+CmdOrCtrl+M',
          click: () => sendMenu('toggle-problems'),
        },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// -------------------------------------------------------------- lifecycle

// The renderer reports document dirtiness so close can be guarded here —
// otherwise closing the window silently discards unsaved work.
let isDirty = false
ipcMain.on('dirty-changed', (_event, dirty: boolean) => {
  isDirty = dirty
})

// Resolve the app icon PNG for the Windows/Linux window. Packaged builds keep
// build/ next to the app resources; in dev it sits at the project root.
function appIcon(): string {
  const packaged = path.join(process.resourcesPath, 'build', 'icon.png')
  return existsSync(packaged) ? packaged : path.join(__dirname, '../../build/icon.png')
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    // Native-feeling chrome on macOS: traffic lights over the app toolbar.
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : {}),
    // Window/taskbar icon on Windows & Linux. macOS takes the icon from the
    // packaged .app bundle (build/icon.icns via electron-builder), not here.
    ...(process.platform !== 'darwin' ? { icon: appIcon() } : {}),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  win.on('close', (event) => {
    if (!isDirty) return
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Close Without Saving', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: 'You have unsaved changes.',
      detail: 'Your changes will be lost if you close without saving.',
    })
    if (choice === 1) event.preventDefault()
  })
  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL) // dev server (HMR)
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  await getSettings() // populate the cache so Open Recent fills on first build
  buildMenu()
  try {
    await startSidecar()
  } catch (err) {
    console.error(err)
  }
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  sidecar?.kill()
})
