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
  onMenu: (cb: (action: string, payload?: string) => void) => {
    const listener = (_event: unknown, action: string, payload?: string) => cb(action, payload)
    ipcRenderer.on('menu', listener)
    return () => {
      ipcRenderer.removeListener('menu', listener)
    }
  },
})
