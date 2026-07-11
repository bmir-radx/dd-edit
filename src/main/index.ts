/**
 * Electron main process: owns the Python sidecar's lifecycle and the window.
 *
 * Startup: pick a free port -> spawn the sidecar with a fresh bearer token ->
 * poll /health until it answers -> open the window. The renderer gets the
 * port + token over IPC and talks to the sidecar directly.
 *
 * Dev overrides:
 *   DD_EDIT_SIDECAR_URL  use an already-running sidecar (e.g. uvicorn --reload)
 *   DD_EDIT_SIDECAR_CMD  custom spawn command, e.g. "/path/python -m dd_edit_sidecar"
 */
import { app, BrowserWindow, ipcMain } from 'electron'
import { type ChildProcess, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'

const token = randomBytes(24).toString('hex')
let sidecar: ChildProcess | null = null
let sidecarUrl: string | null = process.env.DD_EDIT_SIDECAR_URL ?? null

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
  // Dev: prefer the sidecar's own venv; fall back to whatever python3 is around.
  // (Packaged builds will point this at the bundled PyInstaller binary instead.)
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
    cwd: app.getAppPath(),
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  sidecar.on('exit', (code) => {
    console.error(`sidecar exited with code ${code}`)
    sidecar = null
  })
  sidecarUrl = `http://127.0.0.1:${port}`
  await waitForHealth(sidecarUrl)
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL) // dev server (HMR)
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

ipcMain.handle('sidecar-info', () => ({
  url: sidecarUrl,
  token: process.env.DD_EDIT_SIDECAR_URL ? null : token,
}))

app.whenReady().then(async () => {
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
