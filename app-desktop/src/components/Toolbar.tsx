import React, { useState, useRef } from 'react'
import {
  MousePointer2, Type, Highlighter, Underline, Strikethrough,
  PenLine, Square, Circle, ArrowUpRight, Image, Stamp, FileSignature,
  Eraser, MessageSquare, ZoomIn, ZoomOut, Save, SaveAll, FolderOpen,
  Undo2, Redo2, Layers, SlidersHorizontal, Globe, ChevronDown,
  PencilLine, ScanText, Wand2
} from 'lucide-react'
import { usePDFStore, ToolType } from '../store/pdfStore'
import { flattenAnnotations } from '../utils/pdfOperations'
import { useDocumentActions } from '../hooks/useDocumentActions'
import { ocrPageToTextAnnotations } from '../utils/ocr'
import { enhancePdfScan } from '../utils/scanEnhance'
import { SignatureModal } from './SignatureModal'
import { MergeModal } from './MergeModal'
import { PropertiesModal } from './PropertiesModal'

const ZOOM_STEP = 0.08

const TOOLS: Array<{ id: ToolType; label: string; icon: React.ComponentType<any>; group: string }> = [
  { id: 'select', label: 'Select', icon: MousePointer2, group: 'basic' },
  { id: 'text', label: 'Add Text', icon: Type, group: 'annotate' },
  { id: 'highlight', label: 'Highlight', icon: Highlighter, group: 'annotate' },
  { id: 'underline', label: 'Underline', icon: Underline, group: 'annotate' },
  { id: 'strikethrough', label: 'Strikethrough', icon: Strikethrough, group: 'annotate' },
  { id: 'draw', label: 'Draw', icon: PenLine, group: 'draw' },
  { id: 'rectangle', label: 'Rectangle', icon: Square, group: 'draw' },
  { id: 'circle', label: 'Ellipse', icon: Circle, group: 'draw' },
  { id: 'image', label: 'Image', icon: Image, group: 'insert' },
  { id: 'stamp', label: 'Stamp', icon: Stamp, group: 'insert' },
  { id: 'signature', label: 'Signature', icon: FileSignature, group: 'insert' },
  { id: 'comment', label: 'Comment', icon: MessageSquare, group: 'annotate' },
  { id: 'eraser', label: 'Eraser', icon: Eraser, group: 'basic' },
]

const HIGHLIGHT_COLORS = ['#fde047', '#86efac', '#93c5fd', '#f9a8d4', '#fdba74']
const DRAW_COLORS = ['#6366f1', '#ef4444', '#22c55e', '#f59e0b', '#3b82f6', '#000000', '#ffffff']

export function Toolbar() {
  const {
    activeFileId, files, activeTool, zoom, currentPage,
    setActiveTool, setZoom,
    drawColor, setDrawColor,
    strokeWidth, setStrokeWidth,
    fontSize, setFontSize,
    highlightColor, setHighlightColor,
    textColor, setTextColor,
    undo, redo, addAnnotations, updateFileData
  } = usePDFStore()

  const activeFile = files.find(f => f.id === activeFileId)
  const { openFile: handleOpen, save: handleSave, saveAs: handleSaveAs, saving } = useDocumentActions()
  const [showSignatureModal, setShowSignatureModal] = useState(false)
  const [showMergeModal, setShowMergeModal] = useState(false)
  const [showPropertiesModal, setShowPropertiesModal] = useState(false)
  const [ocrRunning, setOcrRunning] = useState(false)
  const [ocrStatus, setOcrStatus] = useState('')
  const [enhancingScan, setEnhancingScan] = useState(false)
  const [enhanceStatus, setEnhanceStatus] = useState('')

  const flushOpenTextEdit = () => {
    window.dispatchEvent(new CustomEvent('oportunidocs:commit-text-edit'))
  }

  const handleToolClick = async (toolId: ToolType) => {
    flushOpenTextEdit()
    if (toolId === 'signature') {
      setShowSignatureModal(true)
      return
    }
    if (toolId === 'image') {
      await handleInsertImage()
      return
    }
    setActiveTool(toolId)
  }

  const handleInsertImage = async () => {
    if (!activeFileId) return
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return
      const reader = new FileReader()
      reader.onload = () => {
        const src = reader.result as string
        const { addAnnotation, currentPage } = usePDFStore.getState()
        addAnnotation(activeFileId, {
          id: crypto.randomUUID(),
          type: 'image',
          pageIndex: currentPage,
          x: 100, y: 100,
          width: 300, height: 200,
          imageSrc: src,
          opacity: 1
        })
      }
      reader.readAsDataURL(file)
    }
    input.click()
  }

  const handleOCR = async () => {
    if (!activeFile || !activeFileId || ocrRunning) return
    setOcrRunning(true)
    setOcrStatus('OCR')
    try {
      flushOpenTextEdit()
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const state = usePDFStore.getState()
      const latestFile = state.files.find(f => f.id === activeFileId)
      if (!latestFile) return
      const annotations = await ocrPageToTextAnnotations({
        pdfData: latestFile.data,
        pageIndex: state.currentPage,
        displayZoom: state.zoom,
        onProgress: setOcrStatus
      })
      if (annotations.length === 0) {
        window.alert('No text was detected on this page.')
        return
      }
      addAnnotations(activeFileId, annotations)
      setActiveTool('select')
    } catch (error) {
      console.error('[OportuniDocs] OCR failed:', error)
      window.alert('OCR failed. Check your connection the first time because OCR language files may need to download.')
    } finally {
      setOcrRunning(false)
      setOcrStatus('')
    }
  }

  const handleEnhanceScan = async () => {
    if (!activeFile || !activeFileId || enhancingScan) return
    setEnhancingScan(true)
    setEnhanceStatus('Enhancing scan')
    try {
      flushOpenTextEdit()
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const state = usePDFStore.getState()
      const latestFile = state.files.find(f => f.id === activeFileId)
      if (!latestFile) return

      const hasAnnotations = latestFile.annotations.length > 0
      if (hasAnnotations) {
        const ok = window.confirm('Enhance scan will bake current edits into the document and clear the editable overlay layers. Continue?')
        if (!ok) return
      }

      const bakedPdf = hasAnnotations
        ? await flattenAnnotations(latestFile.data, latestFile.annotations, state.zoom)
        : latestFile.data
      const enhancedPdf = await enhancePdfScan({
        pdfData: bakedPdf,
        renderScale: 2.5,
        onProgress: setEnhanceStatus
      })

      usePDFStore.setState(current => ({
        files: current.files.map(file => file.id === latestFile.id
          ? { ...file, data: enhancedPdf, annotations: [], modified: true }
          : file
        )
      }))
      window.dispatchEvent(new CustomEvent('oportunidocs:ocr-cache-clear'))
    } catch (error) {
      console.error('[OportuniDocs] scan enhancement failed:', error)
      window.alert('Scan enhancement failed for this file.')
    } finally {
      setEnhancingScan(false)
      setEnhanceStatus('')
    }
  }

  const openInBrowser = () => {
    if ((window as any).electronAPI) {
      (window as any).electronAPI.openBrowser()
    } else {
      window.open('http://localhost:47411', '_blank')
    }
  }

  return (
    <div className="flex flex-col bg-[var(--bg-secondary)] border-b border-[var(--border)]">
      {/* Primary toolbar */}
      <div className="flex items-center gap-1 px-3 h-12 select-none">
        {/* File operations */}
        <ToolbarGroup>
          <TBtn icon={FolderOpen} label="Open (Ctrl+O)" onClick={handleOpen} />
          <TBtn
            icon={Save}
            label={saving ? 'Saving...' : 'Save (Ctrl+S)'}
            onClick={handleSave}
            disabled={!activeFile || saving}
            active={false}
          />
          <TBtn
            icon={SaveAll}
            label="Save As (Ctrl+Shift+S)"
            onClick={() => handleSaveAs()}
            disabled={!activeFile || saving}
            active={false}
          />
          <TBtn
            icon={PencilLine}
            label="Edit original text"
            onClick={() => handleToolClick('textEdit')}
            disabled={!activeFile}
            active={activeTool === 'textEdit'}
          />
        </ToolbarGroup>

        <Divider />

        {/* Undo / Redo */}
        <ToolbarGroup>
          <TBtn icon={Undo2} label="Undo (Ctrl+Z)" onClick={() => activeFileId && undo(activeFileId)} disabled={!activeFileId} />
          <TBtn icon={Redo2} label="Redo (Ctrl+Y)" onClick={() => activeFileId && redo(activeFileId)} disabled={!activeFileId} />
        </ToolbarGroup>

        <Divider />

        {/* Tools */}
        <ToolbarGroup>
          {TOOLS.map(tool => (
            <TBtn
              key={tool.id}
              icon={tool.icon}
              label={tool.label}
              active={activeTool === tool.id}
              onClick={() => handleToolClick(tool.id)}
              disabled={!activeFile}
            />
          ))}
        </ToolbarGroup>

        <Divider />

        {/* Colors */}
        <ToolbarGroup>
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-[var(--text-muted)] pr-1">Color</span>
            {DRAW_COLORS.map(c => (
              <button
                key={c}
                title={c}
                onClick={() => setDrawColor(c)}
                className="w-5 h-5 rounded-full border-2 transition-all"
                style={{
                  background: c,
                  borderColor: drawColor === c ? '#6366f1' : 'transparent',
                  transform: drawColor === c ? 'scale(1.2)' : 'scale(1)'
                }}
              />
            ))}
            <input
              type="color"
              value={drawColor}
              onChange={e => setDrawColor(e.target.value)}
              className="w-5 h-5 rounded cursor-pointer border-0"
              title="Custom color"
            />
          </div>
        </ToolbarGroup>

        <Divider />

        {/* Stroke width */}
        <ToolbarGroup>
          <span className="text-[10px] text-[var(--text-muted)]">Size</span>
          <input
            type="range" min={1} max={12} value={strokeWidth}
            onChange={e => setStrokeWidth(Number(e.target.value))}
            className="w-16 accent-indigo-500"
          />
          <span className="text-xs text-[var(--text-secondary)] w-5 text-center">{strokeWidth}</span>
        </ToolbarGroup>

        <div className="flex-1" />

        {/* Zoom */}
        <ToolbarGroup>
          <TBtn icon={ZoomOut} label="Zoom Out" onClick={() => setZoom(zoom - ZOOM_STEP)} />
          <span className="text-xs text-[var(--text-secondary)] w-12 text-center">
            {Math.round(zoom * 100)}%
          </span>
          <TBtn icon={ZoomIn} label="Zoom In" onClick={() => setZoom(zoom + ZOOM_STEP)} />
        </ToolbarGroup>

        <Divider />

        {/* Actions */}
        <ToolbarGroup>
          <TBtn icon={ScanText} label={ocrRunning ? ocrStatus || 'Running OCR...' : 'OCR current page'} onClick={handleOCR} disabled={!activeFile || ocrRunning} />
          <TBtn icon={Wand2} label={enhancingScan ? enhanceStatus || 'Enhancing scan...' : 'Enhance scan quality'} onClick={handleEnhanceScan} disabled={!activeFile || enhancingScan} />
          <TBtn icon={Layers} label="Merge PDFs" onClick={() => setShowMergeModal(true)} />
          <TBtn icon={SlidersHorizontal} label="Properties" onClick={() => setShowPropertiesModal(true)} disabled={!activeFile} />
          <TBtn icon={Globe} label="Open in Browser" onClick={openInBrowser} />
        </ToolbarGroup>
      </div>

      {/* Modals */}
      {showSignatureModal && (
        <SignatureModal onClose={() => setShowSignatureModal(false)} />
      )}
      {showMergeModal && (
        <MergeModal onClose={() => setShowMergeModal(false)} />
      )}
      {showPropertiesModal && activeFile && (
        <PropertiesModal file={activeFile} onClose={() => setShowPropertiesModal(false)} />
      )}
    </div>
  )
}

function ToolbarGroup({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center gap-0.5">{children}</div>
}

function Divider() {
  return <div className="w-px h-6 bg-[var(--border)] mx-1" />
}

interface TBtnProps {
  icon: React.ComponentType<any>
  label: string
  onClick?: () => void
  active?: boolean
  disabled?: boolean
}

function TBtn({ icon: Icon, label, onClick, active = false, disabled = false }: TBtnProps) {
  return (
    <button
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={`tool-btn ${active ? 'active' : ''} ${disabled ? 'opacity-30 cursor-not-allowed' : ''}`}
    >
      <Icon size={16} />
    </button>
  )
}
