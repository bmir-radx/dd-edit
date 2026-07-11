/** The API the preload script bridges into the renderer. */
export {}

declare global {
  interface Window {
    ddEdit: {
      getSidecarInfo: () => Promise<{ url: string | null; token: string | null }>
      /** Open dialog + read: any dictionary format. Null on cancel. */
      openFile: () => Promise<{ path: string; content: string } | null>
      /** Open dialog + read: REDCap export CSV. Null on cancel. */
      openRedcapFile: () => Promise<{ path: string; content: string } | null>
      /** Save dialog only (no write) — the caller converts by chosen extension. */
      chooseSavePath: (defaultName: string) => Promise<string | null>
      saveFile: (path: string, content: string) => Promise<void>
      /** Subscribe to application-menu actions; returns unsubscribe. */
      onMenu: (cb: (action: string) => void) => () => void
    }
  }
}
