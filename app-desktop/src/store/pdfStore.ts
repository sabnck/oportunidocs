import { create } from 'zustand'
import { PDFDocument } from 'pdf-lib'
import type { EditableBlockKind, BackgroundType, BackgroundComplexity } from '../utils/documentModel'
import type { SourceKind } from '../utils/documentIO'

const HISTORY_LIMIT = 75

export type ToolType =
  | 'select'
  | 'text'
  | 'textEdit'
  | 'highlight'
  | 'underline'
  | 'strikethrough'
  | 'draw'
  | 'rectangle'
  | 'circle'
  | 'arrow'
  | 'image'
  | 'stamp'
  | 'signature'
  | 'eraser'
  | 'comment'

export interface Annotation {
  id: string
  type: ToolType
  pageIndex: number
  x: number
  y: number
  width?: number
  height?: number
  text?: string
  color?: string
  opacity?: number
  strokeWidth?: number
  points?: number[][]
  fontSize?: number
  fontFamily?: string
  imageSrc?: string
  backgroundColor?: string
  isOcrText?: boolean
  rotation?: number
  // textEdit-specific: original text that was replaced
  originalText?: string
  // textEdit-specific: raw PDF user-space coordinates (zoom-independent)
  // Used by flattenAnnotations for pixel-perfect coverage of the original text
  pdfRawX?: number
  pdfRawY?: number
  pdfRawWidth?: number
  pdfRawFontSize?: number
  // textEdit-specific: PDF font resource name (e.g. 'F1', 'TT2')
  // Used to look up embedded bytes in fontExtractor when saving
  pdfFontRef?: string
  // textEdit-specific: human-readable font name resolved from PDF.js
  fontDisplayName?: string
  // textEdit-specific: original PDF base name without subset prefix
  pdfBaseFontName?: string
  // textEdit-specific: extracted fill color at time of text draw (hex)
  textColor?: string
  // textEdit-specific: bold/italic detected from the original font
  isBold?: boolean
  isItalic?: boolean
  // textEdit-specific: viewport CSS px font size (for pixel-perfect canvas sync)
  vpFontSize?: number
  // textEdit-specific: Y coordinate of the text baseline in viewport px (top-left origin)
  // Used with textBaseline='alphabetic' for exact placement matching the original
  vpBaselineY?: number
  // textEdit-specific: line height in PDF pts (for multi-line paragraph export)
  pdfLineHeight?: number
  // textEdit-specific: line height in viewport px (for multi-line canvas preview)
  lineHeightVp?: number
  // textEdit-specific: exact background fill color from the PDF content stream.
  // Extracted via operatorParser rect tracking — used to perfectly cover the
  // original text without pixel-sampling artefacts on coloured backgrounds.
  bgColor?: string
  // textEdit-specific: sampled background approximation from the rendered page.
  // This is never structural truth; it is only a last-resort visual hint.
  sampledBgColor?: string
  sampledBgSpread?: number
  // textEdit-specific: whether the replacement is free text or constrained by
  // an original colored label/card/background rect.
  layoutMode?: 'free' | 'container'
  textAlign?: 'left' | 'center' | 'right'
  trackingMode?: 'normal' | 'spaced'
  letterSpacingEm?: number
  containerPdfX?: number
  containerPdfY?: number
  containerPdfWidth?: number
  containerPdfHeight?: number
  contentInsetPdfX?: number
  firstBaselineOffsetPdf?: number
  blockKind?: EditableBlockKind
  confidence?: number
  backgroundType?: BackgroundType
  backgroundComplexity?: BackgroundComplexity
  requiresReconstruction?: boolean
  layoutLocked?: boolean
  fontSizeScale?: number
  positionOffsetXPdf?: number
  positionOffsetYPdf?: number
  boxWidthScale?: number
  boxHeightScale?: number
  fitScale?: number
}

export interface PDFFile {
  id: string
  name: string
  path?: string
  sourcePath?: string
  sourceKind?: SourceKind
  data: Uint8Array
  pageCount: number
  annotations: Annotation[]
  modified: boolean
  savedAt?: Date
}

export interface HistoryState {
  annotations: Annotation[]
}

interface PDFStore {
  // Files
  files: PDFFile[]
  activeFileId: string | null

  // UI state
  currentPage: number
  zoom: number
  activeTool: ToolType
  sidebarOpen: boolean
  sidebarTab: 'pages' | 'annotations' | 'properties'
  propertiesPanelOpen: boolean

  // Drawing state
  drawColor: string
  drawOpacity: number
  strokeWidth: number
  fontSize: number
  fontFamily: string
  highlightColor: string
  textColor: string

  // History (per file)
  history: Record<string, HistoryState[]>
  historyIndex: Record<string, number>

  // Signature slots
  savedSignatures: string[]

  // Actions
  addFile: (file: PDFFile) => void
  removeFile: (id: string) => void
  setActiveFile: (id: string) => void
  updateFileData: (id: string, data: Uint8Array) => void
  markModified: (id: string) => void
  markSaved: (id: string) => void

  setCurrentPage: (page: number) => void
  setZoom: (zoom: number) => void
  setActiveTool: (tool: ToolType) => void
  toggleSidebar: () => void
  setSidebarTab: (tab: 'pages' | 'annotations' | 'properties') => void

  setDrawColor: (color: string) => void
  setDrawOpacity: (opacity: number) => void
  setStrokeWidth: (width: number) => void
  setFontSize: (size: number) => void
  setFontFamily: (family: string) => void
  setHighlightColor: (color: string) => void
  setTextColor: (color: string) => void

  addAnnotation: (fileId: string, annotation: Annotation) => void
  addAnnotations: (fileId: string, annotations: Annotation[]) => void
  updateAnnotation: (fileId: string, id: string, updates: Partial<Annotation>) => void
  removeAnnotation: (fileId: string, id: string) => void
  clearPageAnnotations: (fileId: string, pageIndex: number) => void

  undo: (fileId: string) => void
  redo: (fileId: string) => void
  pushHistory: (fileId: string) => void

  addSignature: (dataUrl: string) => void
  removeSignature: (index: number) => void

  recentFiles: Array<{ name: string; path: string; openedAt: Date }>
  addRecentFile: (file: { name: string; path: string }) => void
}

export const usePDFStore = create<PDFStore>((set, get) => ({
  files: [],
  activeFileId: null,
  currentPage: 0,
  zoom: 1.2,
  activeTool: 'select',
  sidebarOpen: true,
  sidebarTab: 'pages',
  propertiesPanelOpen: false,
  drawColor: '#6366f1',
  drawOpacity: 1,
  strokeWidth: 2,
  fontSize: 14,
  fontFamily: 'Helvetica',
  highlightColor: '#fde047',
  textColor: '#1a1a2e',
  history: {},
  historyIndex: {},
  savedSignatures: [],
  recentFiles: [],

  addFile: (file) => set(state => ({
    files: [...state.files, file],
    activeFileId: file.id,
    currentPage: 0,
    history: { ...state.history, [file.id]: [{ annotations: [] }] },
    historyIndex: { ...state.historyIndex, [file.id]: 0 }
  })),

  removeFile: (id) => set(state => {
    const files = state.files.filter(f => f.id !== id)
    const activeFileId = state.activeFileId === id
      ? (files[files.length - 1]?.id ?? null)
      : state.activeFileId
    return { files, activeFileId }
  }),

  setActiveFile: (id) => set({ activeFileId: id, currentPage: 0 }),

  updateFileData: (id, data) => set(state => ({
    files: state.files.map(f => f.id === id ? { ...f, data } : f)
  })),

  markModified: (id) => set(state => ({
    files: state.files.map(f => f.id === id ? { ...f, modified: true } : f)
  })),

  markSaved: (id) => set(state => ({
    files: state.files.map(f => f.id === id ? { ...f, modified: false, savedAt: new Date() } : f)
  })),

  setCurrentPage: (page) => set({ currentPage: page }),
  setZoom: (zoom) => set({ zoom: Math.max(0.25, Math.min(5, zoom)) }),
  setActiveTool: (tool) => set({ activeTool: tool }),
  toggleSidebar: () => set(state => ({ sidebarOpen: !state.sidebarOpen })),
  setSidebarTab: (tab) => set({ sidebarTab: tab }),

  setDrawColor: (color) => set({ drawColor: color }),
  setDrawOpacity: (opacity) => set({ drawOpacity: opacity }),
  setStrokeWidth: (width) => set({ strokeWidth: width }),
  setFontSize: (size) => set({ fontSize: size }),
  setFontFamily: (family) => set({ fontFamily: family }),
  setHighlightColor: (color) => set({ highlightColor: color }),
  setTextColor: (color) => set({ textColor: color }),

  addAnnotation: (fileId, annotation) => {
    get().pushHistory(fileId)
    set(state => ({
      files: state.files.map(f => f.id === fileId
        ? { ...f, annotations: [...f.annotations, annotation], modified: true }
        : f
      )
    }))
  },

  addAnnotations: (fileId, annotations) => {
    if (annotations.length === 0) return
    get().pushHistory(fileId)
    set(state => ({
      files: state.files.map(f => f.id === fileId
        ? { ...f, annotations: [...f.annotations, ...annotations], modified: true }
        : f
      )
    }))
  },
  updateAnnotation: (fileId, id, updates) => set(state => ({
    files: state.files.map(f => f.id === fileId
      ? {
          ...f,
          annotations: f.annotations.map(a => a.id === id ? { ...a, ...updates } : a),
          modified: true
        }
      : f
    )
  })),

  removeAnnotation: (fileId, id) => {
    get().pushHistory(fileId)
    set(state => ({
      files: state.files.map(f => f.id === fileId
        ? { ...f, annotations: f.annotations.filter(a => a.id !== id), modified: true }
        : f
      )
    }))
  },

  clearPageAnnotations: (fileId, pageIndex) => {
    get().pushHistory(fileId)
    set(state => ({
      files: state.files.map(f => f.id === fileId
        ? { ...f, annotations: f.annotations.filter(a => a.pageIndex !== pageIndex), modified: true }
        : f
      )
    }))
  },

  pushHistory: (fileId) => {
    const state = get()
    const file = state.files.find(f => f.id === fileId)
    if (!file) return
    const idx = state.historyIndex[fileId] ?? 0
    const hist = (state.history[fileId] ?? []).slice(0, idx + 1)
    hist.push({ annotations: [...file.annotations] })
    const cappedHist = hist.slice(-HISTORY_LIMIT)
    const newIdx = cappedHist.length - 1
    set(s => ({
      history: { ...s.history, [fileId]: cappedHist },
      historyIndex: { ...s.historyIndex, [fileId]: newIdx }
    }))
  },

  undo: (fileId) => {
    const state = get()
    const idx = state.historyIndex[fileId] ?? 0
    if (idx <= 0) return
    const newIdx = idx - 1
    const hist = state.history[fileId] ?? []
    const snapshot = hist[newIdx]
    set(s => ({
      historyIndex: { ...s.historyIndex, [fileId]: newIdx },
      files: s.files.map(f => f.id === fileId
        ? { ...f, annotations: snapshot.annotations, modified: true }
        : f
      )
    }))
  },

  redo: (fileId) => {
    const state = get()
    const idx = state.historyIndex[fileId] ?? 0
    const hist = state.history[fileId] ?? []
    if (idx >= hist.length - 1) return
    const newIdx = idx + 1
    const snapshot = hist[newIdx]
    set(s => ({
      historyIndex: { ...s.historyIndex, [fileId]: newIdx },
      files: s.files.map(f => f.id === fileId
        ? { ...f, annotations: snapshot.annotations, modified: true }
        : f
      )
    }))
  },

  addSignature: (dataUrl) => set(state => ({
    savedSignatures: [...state.savedSignatures.slice(-4), dataUrl]
  })),

  removeSignature: (index) => set(state => ({
    savedSignatures: state.savedSignatures.filter((_, i) => i !== index)
  })),

  addRecentFile: (file) => set(state => {
    const existing = state.recentFiles.filter(r => r.path !== file.path)
    return {
      recentFiles: [{ ...file, openedAt: new Date() }, ...existing].slice(0, 20)
    }
  })
}))
