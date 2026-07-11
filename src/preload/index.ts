/** Context bridge: the only surface the renderer gets from the main process. */
import { contextBridge, ipcRenderer } from 'electron'

export interface SidecarInfo {
  url: string | null
  token: string | null
}

contextBridge.exposeInMainWorld('ddEdit', {
  getSidecarInfo: (): Promise<SidecarInfo> => ipcRenderer.invoke('sidecar-info'),
})
