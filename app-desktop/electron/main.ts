import { app, BrowserWindow, ipcMain, dialog, shell, Menu } from 'electron'
import { basename, dirname, extname, join, resolve } from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { startLocalServer, stopLocalServer } from './server'

let mainWindow: BrowserWindow | null = null
const isDev = process.env.NODE_ENV === 'development'
const gotSingleInstanceLock = app.requestSingleInstanceLock()
const allowedReadPaths = new Set<string>()
const allowedWritePaths = new Set<string>()
const allowedSavePrefixes = new Map<string, Set<string>>()

function normalizeUserPath(filePath: string) {
  return resolve(filePath)
}

function rememberOpenedPath(filePath: string) {
  const normalized = normalizeUserPath(filePath)
  allowedReadPaths.add(normalized)
  allowedWritePaths.add(normalized)
  return normalized
}

function rememberSavePath(filePath: string) {
  const normalized = normalizeUserPath(filePath)
  allowedReadPaths.add(normalized)
  allowedWritePaths.add(normalized)

  const dir = dirname(normalized)
  const stem = basename(normalized, extname(normalized))
  const stems = allowedSavePrefixes.get(dir) ?? new Set<string>()
  stems.add(stem)
  allowedSavePrefixes.set(dir, stems)
  return normalized
}

function canWritePath(filePath: string) {
  const normalized = normalizeUserPath(filePath)
  if (allowedWritePaths.has(normalized)) return true

  const dir = dirname(normalized)
  const stem = basename(normalized, extname(normalized))
  const allowedStems = allowedSavePrefixes.get(dir)
  if (!allowedStems) return false

  return Array.from(allowedStems).some(allowedStem => stem === allowedStem || stem.startsWith(`${allowedStem}-page-`))
}

function isSafeExternalUrl(url: string) {
  try {
    const parsed = new URL(url)
    return ['https:', 'http:', 'mailto:'].includes(parsed.protocol)
  } catch {
    return false
  }
}

function isAllowedRendererNavigation(url: string) {
  if (url.startsWith('file://')) return true
  if (isDev && (url.startsWith('http://localhost:5173') || url.startsWith('http://127.0.0.1:5173'))) return true
  return false
}

if (!gotSingleInstanceLock) {
  app.quit()
}

function showAndFocusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return

  if (mainWindow.isMinimized()) {
    mainWindow.restore()
  }

  if (!mainWindow.isVisible()) {
    mainWindow.show()
  }

  mainWindow.focus()
}

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    showAndFocusMainWindow()
    return
  }

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0f0f12',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0f0f12',
      symbolColor: '#a0a0b0',
      height: 40
    },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false
    },
    icon: join(__dirname, '../../assets/icon.png'),
    show: false
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.once('ready-to-show', () => {
    showAndFocusMainWindow()
  })

  mainWindow.webContents.on('did-finish-load', () => {
    showAndFocusMainWindow()
  })

  mainWindow.webContents.on('did-fail-load', (_, errorCode, errorDescription) => {
    console.error('[OportuniDocs] Failed to load window:', errorCode, errorDescription)
    showAndFocusMainWindow()
  })

  mainWindow.webContents.on('render-process-gone', (_, details) => {
    console.error('[OportuniDocs] Renderer process gone:', details.reason)
  })

  mainWindow.on('unresponsive', () => {
    console.error('[OportuniDocs] Main window became unresponsive')
  })

  mainWindow.webContents.session.setPermissionRequestHandler((_, __, callback) => {
    callback(false)
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isAllowedRendererNavigation(url)) return

    event.preventDefault()
    if (isSafeExternalUrl(url)) {
      shell.openExternal(url).catch(error => {
        console.error('[OportuniDocs] Failed to open external URL:', error)
      })
    }
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) {
      shell.openExternal(url).catch(error => {
        console.error('[OportuniDocs] Failed to open external URL:', error)
      })
    }
    return { action: 'deny' }
  })

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173').catch((error) => {
      console.error('[OportuniDocs] Failed to load dev URL:', error)
    })
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html')).catch((error) => {
      console.error('[OportuniDocs] Failed to load renderer file:', error)
      showAndFocusMainWindow()
    })
  }

  buildMenu()
}

function buildMenu() {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Open PDF',
          accelerator: 'CmdOrCtrl+O',
          click: () => mainWindow?.webContents.send('menu-open-file')
        },
        {
          label: 'Save',
          accelerator: 'CmdOrCtrl+S',
          click: () => mainWindow?.webContents.send('menu-save')
        },
        {
          label: 'Save As',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => mainWindow?.webContents.send('menu-save-as')
        },
        { type: 'separator' },
        {
          label: 'Open in Browser',
          accelerator: 'CmdOrCtrl+B',
          click: () => shell.openExternal('http://localhost:47411')
        },
        { type: 'separator' },
        { role: 'quit', label: 'Exit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        {
          label: 'Undo',
          accelerator: 'CmdOrCtrl+Z',
          click: () => mainWindow?.webContents.send('menu-undo')
        },
        {
          label: 'Redo',
          accelerator: 'CmdOrCtrl+Y',
          click: () => mainWindow?.webContents.send('menu-redo')
        }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { type: 'separator' },
        {
          label: 'Zoom In',
          accelerator: 'CmdOrCtrl+Plus',
          click: () => mainWindow?.webContents.send('menu-zoom-in')
        },
        {
          label: 'Zoom Out',
          accelerator: 'CmdOrCtrl+-',
          click: () => mainWindow?.webContents.send('menu-zoom-out')
        },
        {
          label: 'Fit to Page',
          accelerator: 'CmdOrCtrl+0',
          click: () => mainWindow?.webContents.send('menu-zoom-fit')
        },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Portfolio | StudioElevatio.com',
          click: () => shell.openExternal('https://studioelevatio.com')
        },
        {
          label: 'Criado por Henrique Fernandes',
          enabled: false
        }
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// IPC: Open file dialog
ipcMain.handle('dialog:openFile', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Open document or image',
    filters: [
      { name: 'Documents and images', extensions: ['pdf', 'png', 'jpg', 'jpeg', 'webp'] },
      { name: 'PDF files', extensions: ['pdf'] },
      { name: 'Image files', extensions: ['png', 'jpg', 'jpeg', 'webp'] }
    ],
    properties: ['openFile', 'multiSelections']
  })
  if (result.canceled) return null
  const files = result.filePaths.map(filePath => {
    const normalizedPath = rememberOpenedPath(filePath)
    const ext = normalizedPath.split('.').pop()?.toLowerCase()
    const mimeType = ext === 'png'
      ? 'image/png'
      : ext === 'jpg' || ext === 'jpeg'
        ? 'image/jpeg'
        : ext === 'webp'
          ? 'image/webp'
          : 'application/pdf'

    return {
      path: normalizedPath,
      data: readFileSync(normalizedPath).toString('base64'),
      name: basename(normalizedPath) || 'document.pdf',
      mimeType
    }
  })
  return files
})
// IPC: Save file
ipcMain.handle('dialog:saveFile', async (_, { defaultName }: { defaultName: string; formats?: string[] }) => {
  const result = await dialog.showSaveDialog({
    title: 'Save as',
    defaultPath: defaultName || 'document.pdf',
    filters: [
      { name: 'PDF document', extensions: ['pdf'] },
      { name: 'PNG image', extensions: ['png'] },
      { name: 'JPEG image', extensions: ['jpg', 'jpeg'] }
    ]
  })
  return result.canceled || !result.filePath ? null : rememberSavePath(result.filePath)
})
// IPC: Write file bytes
ipcMain.handle('fs:writeFile', async (_, { path, data }: { path: string; data: number[] }) => {
  try {
    const normalizedPath = normalizeUserPath(path)
    if (!canWritePath(normalizedPath)) {
      return { success: false, error: 'Write path was not selected by the user.' }
    }
    writeFileSync(normalizedPath, Buffer.from(data))
    allowedReadPaths.add(normalizedPath)
    allowedWritePaths.add(normalizedPath)
    return { success: true }
  } catch (e: any) {
    return { success: false, error: e.message }
  }
})

// IPC: Read file
ipcMain.handle('fs:readFile', async (_, filePath: string) => {
  try {
    const normalizedPath = normalizeUserPath(filePath)
    if (!allowedReadPaths.has(normalizedPath)) {
      return { success: false, error: 'Read path was not selected by the user.' }
    }
    const data = readFileSync(normalizedPath)
    return { success: true, data: Array.from(data) }
  } catch (e: any) {
    return { success: false, error: e.message }
  }
})

// IPC: Open in browser
ipcMain.handle('app:openBrowser', async () => {
  shell.openExternal('http://localhost:47411')
})

// IPC: Get app version
ipcMain.handle('app:version', () => app.getVersion())

app.on('second-instance', () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }

  showAndFocusMainWindow()
})

app.whenReady().then(() => {
  app.setAppUserModelId('com.studioelevatio.oportunidocs')

  startLocalServer()
  createWindow()

  app.on('activate', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow()
      return
    }

    showAndFocusMainWindow()
  })
})

app.on('window-all-closed', () => {
  stopLocalServer()
  if (process.platform !== 'darwin') app.quit()
})
