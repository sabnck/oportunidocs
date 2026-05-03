import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  // File operations
  openFile: () => ipcRenderer.invoke('dialog:openFile'),
  saveFile: (opts: { defaultName: string; formats?: string[] }) => ipcRenderer.invoke('dialog:saveFile', opts),
  writeFile: (opts: { path: string; data: number[] }) => ipcRenderer.invoke('fs:writeFile', opts),
  readFile: (path: string) => ipcRenderer.invoke('fs:readFile', path),

  // App
  openBrowser: () => ipcRenderer.invoke('app:openBrowser'),
  getVersion: () => ipcRenderer.invoke('app:version'),

  // Menu events
  onMenuEvent: (callback: (event: string) => void) => {
    const events = [
      'menu-open-file', 'menu-save', 'menu-save-as',
      'menu-undo', 'menu-redo',
      'menu-zoom-in', 'menu-zoom-out', 'menu-zoom-fit'
    ]
    const handlers = events.map(event => {
      const handler = () => callback(event)
      ipcRenderer.on(event, handler)
      return { event, handler }
    })
    return () => handlers.forEach(({ event, handler }) => ipcRenderer.off(event, handler))
  }
})

export type ElectronAPI = {
  openFile: () => Promise<Array<{ path: string; data: string; name: string; mimeType?: string }> | null>
  saveFile: (opts: { defaultName: string; formats?: string[] }) => Promise<string | null>
  writeFile: (opts: { path: string; data: number[] }) => Promise<{ success: boolean; error?: string }>
  readFile: (path: string) => Promise<{ success: boolean; data?: number[]; error?: string }>
  openBrowser: () => Promise<void>
  getVersion: () => Promise<string>
  onMenuEvent: (callback: (event: string) => void) => () => void
}
