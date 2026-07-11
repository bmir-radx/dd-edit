/** Context bridge: the only surface the renderer gets from the main process. */
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('ddEdit', {
  platform: process.platform,
  setDirty: (dirty: boolean) => ipcRenderer.send('dirty-changed', dirty),
  getSidecarInfo: () => ipcRenderer.invoke('sidecar-info'),
  openFile: () => ipcRenderer.invoke('dialog:open'),
  openRedcapFile: () => ipcRenderer.invoke('dialog:open-redcap'),
  chooseSavePath: (defaultName: string) => ipcRenderer.invoke('dialog:save-as', defaultName),
  saveFile: (path: string, content: string) => ipcRenderer.invoke('file:save', path, content),
  onMenu: (cb: (action: string) => void) => {
    const listener = (_event: unknown, action: string) => cb(action)
    ipcRenderer.on('menu', listener)
    return () => {
      ipcRenderer.removeListener('menu', listener)
    }
  },
})
