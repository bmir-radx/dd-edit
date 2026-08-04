/** Context bridge: the only surface the renderer gets from the main process. */
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('ddEdit', {
  platform: process.platform,
  setDirty: (dirty: boolean) => ipcRenderer.send('dirty-changed', dirty),
  getSidecarInfo: () => ipcRenderer.invoke('sidecar-info'),
  openFile: () => ipcRenderer.invoke('dialog:open'),
  openRedcapFile: () => ipcRenderer.invoke('dialog:open-redcap'),
  lastFile: () => ipcRenderer.invoke('last-file'),
  openPath: (path: string) => ipcRenderer.invoke('file:open-path', path),
  chooseSavePath: (defaultName: string) => ipcRenderer.invoke('dialog:save-as', defaultName),
  saveFile: (path: string, content: string) => ipcRenderer.invoke('file:save', path, content),
  openExternal: (url: string) => ipcRenderer.invoke('shell:open-external', url),
  confirmDiscard: (name: string) => ipcRenderer.invoke('dialog:confirm-discard', name),
  onMenu: (cb: (action: string, payload?: string) => void) => {
    const listener = (_event: unknown, action: string, payload?: string) => cb(action, payload)
    ipcRenderer.on('menu', listener)
    return () => {
      ipcRenderer.removeListener('menu', listener)
    }
  },
  /**
   * The open file changed on disk and the user chose to reload it. Main has
   * already asked and already read the file, so the content comes with the
   * message — the renderer only has to parse and load it.
   */
  onFileReloaded: (cb: (path: string, content: string) => void) => {
    const listener = (_event: unknown, path: string, content: string) => cb(path, content)
    ipcRenderer.on('file-reloaded', listener)
    return () => {
      ipcRenderer.removeListener('file-reloaded', listener)
    }
  },
})
