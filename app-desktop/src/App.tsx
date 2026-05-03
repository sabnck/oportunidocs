import React, { useEffect, useCallback } from 'react'
import { TitleBar } from './components/TitleBar'
import { Toolbar } from './components/Toolbar'
import { Sidebar } from './components/Sidebar'
import { PDFViewer } from './components/PDFViewer'
import { StatusBar } from './components/StatusBar'
import { usePDFStore } from './store/pdfStore'
import { flattenAnnotations } from './utils/pdfOperations'
import {
  chooseExportFormat,
  createEditableDocumentFromBytes,
  defaultExportName,
  exportPdfPagesAsImages,
  inferExportFormatFromPath,
  isSupportedInput,
  SUPPORTED_OPEN_ACCEPT,
  withExportExtension,
  type ExportFormat
} from './utils/documentIO'

const ZOOM_STEP = 0.08

export default function App() {
  const {
    files, activeFileId, zoom, setZoom, undo, redo,
    addFile, updateFileData, markSaved, addRecentFile
  } = usePDFStore()
  const activeFile = files.find(f => f.id === activeFileId)

  const flushTextEdit = async () => {
    window.dispatchEvent(new CustomEvent('oportunidocs:commit-text-edit'))
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  }

  const addOpenedFile = async (input: { name: string; data: Uint8Array; path?: string; mimeType?: string }) => {
    const prepared = await createEditableDocumentFromBytes(input)
    addFile({
      id: crypto.randomUUID(),
      name: input.name,
      path: prepared.sourceKind === 'pdf' ? input.path : undefined,
      sourcePath: input.path,
      sourceKind: prepared.sourceKind,
      data: prepared.data,
      pageCount: 0,
      annotations: [],
      modified: false
    })
    if (input.path) addRecentFile({ name: input.name, path: input.path })
  }

  // ── Keyboard shortcuts ────────────────────────────────────────────────

  const handleKeyDown = useCallback(async (e: KeyboardEvent) => {
    const ctrl = e.ctrlKey || e.metaKey

    if (ctrl && e.key === 'o') {
      e.preventDefault()
      await openFile()
    }

    if (ctrl && e.key === 's' && !e.shiftKey) {
      e.preventDefault()
      await save()
    }

    if (ctrl && e.key === 's' && e.shiftKey) {
      e.preventDefault()
      await saveAs()
    }

    if (ctrl && e.key === 'z') {
      e.preventDefault()
      if (activeFileId) undo(activeFileId)
    }

    if (ctrl && (e.key === 'y' || (e.shiftKey && e.key === 'Z'))) {
      e.preventDefault()
      if (activeFileId) redo(activeFileId)
    }

    if (ctrl && e.key === '=') {
      e.preventDefault()
      setZoom(usePDFStore.getState().zoom + ZOOM_STEP)
    }

    if (ctrl && e.key === '-') {
      e.preventDefault()
      setZoom(usePDFStore.getState().zoom - ZOOM_STEP)
    }

    if (ctrl && e.key === '0') {
      e.preventDefault()
      setZoom(1)
    }
  }, [activeFileId, undo, redo, setZoom])

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      const hasUnsavedChanges = usePDFStore.getState().files.some(file => file.modified)
      if (!hasUnsavedChanges) return

      event.preventDefault()
      event.returnValue = ''
    }

    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [])

  // ── Electron menu events ──────────────────────────────────────────────

  useEffect(() => {
    const api = (window as any).electronAPI
    if (!api?.onMenuEvent) return

    const cleanup = api.onMenuEvent(async (event: string) => {
      const state = usePDFStore.getState()
      switch (event) {
        case 'menu-open-file': await openFile(); break
        case 'menu-save': await save(); break
        case 'menu-save-as': await saveAs(); break
        case 'menu-undo': if (state.activeFileId) state.undo(state.activeFileId); break
        case 'menu-redo': if (state.activeFileId) state.redo(state.activeFileId); break
        case 'menu-zoom-in': state.setZoom(state.zoom + ZOOM_STEP); break
        case 'menu-zoom-out': state.setZoom(state.zoom - ZOOM_STEP); break
        case 'menu-zoom-fit': state.setZoom(1); break
      }
    })

    return cleanup
  }, [])

  // ── Global drag & drop (on the app body) ─────────────────────────────

  useEffect(() => {
    const handleDragOver = (e: DragEvent) => e.preventDefault()
    const handleDrop = async (e: DragEvent) => {
      e.preventDefault()
      const items = Array.from(e.dataTransfer?.files ?? []).filter(
        f => isSupportedInput(f.name, f.type)
      )
      for (const f of items) {
        const data = new Uint8Array(await f.arrayBuffer())
        await addOpenedFile({ name: f.name, data, mimeType: f.type })
      }
    }

    window.addEventListener('dragover', handleDragOver)
    window.addEventListener('drop', handleDrop)
    return () => {
      window.removeEventListener('dragover', handleDragOver)
      window.removeEventListener('drop', handleDrop)
    }
  }, [addFile])

  // ── File operations ───────────────────────────────────────────────────

  async function openFile() {
    const api = (window as any).electronAPI
    if (api) {
      const result = await api.openFile()
      if (!result) return
      for (const f of result) {
        const data = Uint8Array.from(atob(f.data), (c: string) => c.charCodeAt(0))
        await addOpenedFile({ name: f.name, path: f.path, data, mimeType: f.mimeType })
      }
    } else {
      const input = document.createElement('input')
      input.type = 'file'; input.accept = SUPPORTED_OPEN_ACCEPT; input.multiple = true
      input.onchange = async () => {
        for (const f of Array.from(input.files ?? [])) {
          if (!isSupportedInput(f.name, f.type)) continue
          const data = new Uint8Array(await f.arrayBuffer())
          await addOpenedFile({ name: f.name, data, mimeType: f.type })
        }
      }
      input.click()
    }
  }

  async function save() {
    await flushTextEdit()
    const state = usePDFStore.getState()
    const file = state.files.find(f => f.id === state.activeFileId)
    if (!file) return

    const pdfBytes = await flattenAnnotations(file.data, file.annotations, state.zoom)
    const api = (window as any).electronAPI

    if (api && file.path) {
      await api.writeFile({ path: file.path, data: Array.from(pdfBytes) })
      updateFileData(file.id, pdfBytes)
      markSaved(file.id)
      return
    }

    await saveAs(pdfBytes)
  }

  async function saveAs(existingPdfBytes?: Uint8Array) {
    await flushTextEdit()
    const state = usePDFStore.getState()
    const file = state.files.find(f => f.id === state.activeFileId)
    if (!file) return

    const pdfBytes = existingPdfBytes ?? await flattenAnnotations(file.data, file.annotations, state.zoom)
    const api = (window as any).electronAPI
    const defaultFormat: ExportFormat = file.sourceKind === 'image' ? 'png' : 'pdf'
    const defaultName = defaultExportName(file.name, defaultFormat)

    if (api) {
      const selectedPath = await api.saveFile({ defaultName, formats: ['pdf', 'png', 'jpeg'] })
      if (!selectedPath) return
      const format = inferExportFormatFromPath(selectedPath)
      await writeExportedFile({ api, fileId: file.id, selectedPath, pdfBytes, format })
    } else {
      const format = chooseExportFormat(defaultFormat)
      if (!format) return
      await downloadExport(file.name, pdfBytes, format)
    }
  }

  async function writeExportedFile({
    api,
    fileId,
    selectedPath,
    pdfBytes,
    format
  }: {
    api: any
    fileId: string
    selectedPath: string
    pdfBytes: Uint8Array
    format: ExportFormat
  }) {
    if (format === 'pdf') {
      const path = withExportExtension(selectedPath, 'pdf')
      await api.writeFile({ path, data: Array.from(pdfBytes) })
      updateFileData(fileId, pdfBytes)
      markSaved(fileId)
      return
    }

    const images = await exportPdfPagesAsImages(pdfBytes, format, selectedPath)
    const target = withExportExtension(selectedPath, format)
    const ext = format === 'png' ? 'png' : 'jpg'
    const withoutExt = target.replace(/\.[^.\\/]+$/, '')
    for (const image of images) {
      const path = images.length === 1
        ? target
        : `${withoutExt}-page-${String(image.pageIndex + 1).padStart(2, '0')}.${ext}`
      await api.writeFile({ path, data: Array.from(image.bytes) })
    }
  }

  async function downloadExport(name: string, pdfBytes: Uint8Array, format: ExportFormat) {
    if (format === 'pdf') {
      downloadBlob(pdfBytes, defaultExportName(name, 'pdf'), 'application/pdf')
      return
    }

    const images = await exportPdfPagesAsImages(pdfBytes, format, name)
    for (const image of images) {
      downloadBlob(image.bytes, image.name, image.mimeType)
    }
  }

  function downloadBlob(bytes: Uint8Array, name: string, mimeType: string) {
    const arrayBuffer = new ArrayBuffer(bytes.byteLength)
    new Uint8Array(arrayBuffer).set(bytes)
    const blob = new Blob([arrayBuffer], { type: mimeType })
    const url = URL.createObjectURL(blob)

    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !(window as any).MSStream
    if (isIOS) {
      const win = window.open(url, '_blank')
      if (!win) window.location.href = url
      setTimeout(() => URL.revokeObjectURL(url), 30_000)
      return
    }

    const a = document.createElement('a')
    a.href = url
    a.download = name
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return (
    <div className="h-screen flex flex-col bg-primary overflow-hidden">
      {/* Custom title bar (hidden in web mode since titleBarStyle:hidden) */}
      <TitleBar />

      {/* Toolbar */}
      <Toolbar />

      {/* Main content area */}
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <PDFViewer />
      </div>

      {/* Status bar */}
      <StatusBar />
    </div>
  )
}
