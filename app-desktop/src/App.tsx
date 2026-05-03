import React, { useEffect, useCallback } from 'react'
import { TitleBar } from './components/TitleBar'
import { Toolbar } from './components/Toolbar'
import { Sidebar } from './components/Sidebar'
import { PDFViewer } from './components/PDFViewer'
import { StatusBar } from './components/StatusBar'
import { usePDFStore } from './store/pdfStore'
import { useDocumentActions } from './hooks/useDocumentActions'

const ZOOM_STEP = 0.08

export default function App() {
  const {
    activeFileId, setZoom, undo, redo
  } = usePDFStore()
  const { openFile, save, saveAs, openDroppedFiles } = useDocumentActions()

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
  }, [activeFileId, undo, redo, setZoom, openFile, save, saveAs])

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
  }, [openFile, save, saveAs])

  // ── Global drag & drop (on the app body) ─────────────────────────────

  useEffect(() => {
    const handleDragOver = (e: DragEvent) => e.preventDefault()
    const handleDrop = async (e: DragEvent) => {
      e.preventDefault()
      await openDroppedFiles(Array.from(e.dataTransfer?.files ?? []))
    }

    window.addEventListener('dragover', handleDragOver)
    window.addEventListener('drop', handleDrop)
    return () => {
      window.removeEventListener('dragover', handleDragOver)
      window.removeEventListener('drop', handleDrop)
    }
  }, [openDroppedFiles])

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
