/** The API the preload script bridges into the renderer. */
export {}

declare global {
  interface Window {
    ddEdit: {
      platform: string
      /** Report document dirtiness so the main process can guard window close. */
      setDirty: (dirty: boolean) => void
      getSidecarInfo: () => Promise<{ url: string | null; token: string | null }>
      /** Open dialog + read: any dictionary format. Null on cancel. */
      openFile: () => Promise<{ path: string; content: string } | null>
      /** Open dialog + read: REDCap export CSV. Null on cancel. */
      openRedcapFile: () => Promise<{ path: string; content: string } | null>
      /** The last-opened dictionary path, if it still exists. */
      lastFile: () => Promise<string | null>
      /** Read a known path (the reopen button); remembers it as last-used. */
      openPath: (path: string) => Promise<{ path: string; content: string }>
      /** Save dialog only (no write) — the caller converts by chosen extension. */
      chooseSavePath: (defaultName: string) => Promise<string | null>
      saveFile: (path: string, content: string) => Promise<void>
      /** Open an http(s) URL in the system browser. */
      openExternal: (url: string) => Promise<void>
      /** Subscribe to application-menu actions; returns unsubscribe. */
      onMenu: (cb: (action: string, payload?: string) => void) => () => void
    }
  }
}
