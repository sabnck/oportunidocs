import React, { useEffect, useRef, useState, useCallback, Component, ErrorInfo, ReactNode } from 'react'
import * as PDFJS from 'pdfjs-dist'
import { usePDFStore } from '../store/pdfStore'
import { AnnotationCanvas } from './AnnotationCanvas'
import { TextEditOverlay } from './TextEditOverlay'
import { createEditableDocumentFromBytes, isSupportedInput, SUPPORTED_OPEN_ACCEPT } from '../utils/documentIO'

const WHEEL_ZOOM_SENSITIVITY = 0.0018
const MAX_WHEEL_ZOOM_STEP = 0.08

// ── Error Boundary — catches any runtime crash in TextEditOverlay/AnnotationCanvas
// so the page never goes completely black. On error it shows a small inline notice
// and logs the problem to the console for debugging.
class PageErrorBoundary extends Component<
  { children: ReactNode; onReset?: () => void },
  { hasError: boolean; errorMsg: string }
> {
  constructor(props: any) {
    super(props)
    this.state = { hasError: false, errorMsg: '' }
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, errorMsg: error?.message ?? 'Unknown error' }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[OportuniDocs] Component error caught by boundary:', error, info)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          className="absolute inset-0 z-30 flex items-center justify-center pointer-events-none"
          style={{ background: 'rgba(0,0,0,0.04)' }}
        >
          <div
            className="text-xs px-3 py-2 rounded-lg pointer-events-auto cursor-pointer select-none"
            style={{ background: 'rgba(239,68,68,0.15)', color: '#fca5a5', border: '1px solid rgba(239,68,68,0.3)' }}
            onClick={() => this.setState({ hasError: false, errorMsg: '' })}
            title={this.state.errorMsg}
          >
            ⚠ Erro na camada de edição — clique para tentar novamente
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

// Point PDF.js worker to bundled version (v4+ uses .mjs)
PDFJS.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString()

interface PDFPage {
  pageNum: number
  canvas: HTMLCanvasElement | null
  loaded: boolean
}

export function PDFViewer() {
  const { files, activeFileId, currentPage, zoom, setCurrentPage, setZoom } = usePDFStore()
  const activeFile = files.find(f => f.id === activeFileId)
  const containerRef = useRef<HTMLDivElement>(null)
  const pageRefs = useRef<Record<number, HTMLDivElement | null>>({})
  const pdfDocRef = useRef<PDFJS.PDFDocumentProxy | null>(null)
  // pdfDocState mirrors pdfDocRef but is reactive — used to prop-drill into overlays
  // so they receive new pdfDoc immediately when the active file changes.
  const [pdfDocState, setPdfDocState] = useState<PDFJS.PDFDocumentProxy | null>(null)
  const renderTasksRef = useRef<Record<number, PDFJS.RenderTask | null>>({})
  const [pageCount, setPageCount] = useState(0)
  const [pageSizes, setPageSizes] = useState<Record<number, { width: number; height: number }>>({})
  const [renderedPages, setRenderedPages] = useState<Set<number>>(new Set())
  const observerRef = useRef<IntersectionObserver | null>(null)
  const visiblePagesRef = useRef<Set<number>>(new Set())

  // Load PDF document
  useEffect(() => {
    if (!activeFile) {
      pdfDocRef.current = null
      setPageCount(0)
      setRenderedPages(new Set())
      return
    }

    let cancelled = false

    async function loadDoc() {
      try {
        if (pdfDocRef.current) {
          await pdfDocRef.current.destroy()
        }
        // Clear the reactive state immediately on file switch so overlays
        // see a null pdfDoc (not the stale doc from the previous file).
        setPdfDocState(null)

        const loadingTask = PDFJS.getDocument({
          data: activeFile!.data.slice(),
          disableAutoFetch: true,
          disableStream: false,
          isEvalSupported: false,   // bloqueia execução de JS em PDFs maliciosos
          useSystemFonts: true,
          fontExtraProperties: true
        })
        const pdf = await loadingTask.promise

        if (cancelled) return

        pdfDocRef.current = pdf
        setPdfDocState(pdf)           // triggers re-render so overlays get new pdfDoc
        setPageCount(pdf.numPages)
        setRenderedPages(new Set())

        // Get sizes for all pages
        const sizes: Record<number, { width: number; height: number }> = {}
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i)
          const viewport = page.getViewport({ scale: 1 })
          sizes[i - 1] = { width: viewport.width, height: viewport.height }
        }
        if (!cancelled) setPageSizes(sizes)
      } catch (e) {
        console.error('Failed to load PDF:', e)
      }
    }

    loadDoc()
    return () => { cancelled = true }
  }, [activeFile?.id, activeFile?.data])

  // Intersection observer — render only visible pages
  useEffect(() => {
    observerRef.current = new IntersectionObserver(
      (entries) => {
        entries.forEach(entry => {
          const idx = Number((entry.target as HTMLElement).dataset.pageIndex)
          if (entry.isIntersecting) {
            visiblePagesRef.current.add(idx)
            renderPage(idx)
          } else {
            visiblePagesRef.current.delete(idx)
          }
        })
      },
      { root: containerRef.current, rootMargin: '200px', threshold: 0 }
    )

    for (let i = 0; i < pageCount; i++) {
      const el = pageRefs.current[i]
      if (el) observerRef.current.observe(el)
    }

    return () => {
      observerRef.current?.disconnect()
    }
  }, [pageCount])

  const renderPage = useCallback(async (pageIndex: number) => {
    if (!pdfDocRef.current) return
    const canvas = pageRefs.current[pageIndex]?.querySelector('canvas') as HTMLCanvasElement
    if (!canvas) return

    // Cancel previous render for this page
    if (renderTasksRef.current[pageIndex]) {
      renderTasksRef.current[pageIndex]?.cancel()
    }

    try {
      const page = await pdfDocRef.current.getPage(pageIndex + 1)
      const viewport = page.getViewport({ scale: zoom })

      const dpr = window.devicePixelRatio || 1
      canvas.width = viewport.width * dpr
      canvas.height = viewport.height * dpr
      canvas.style.width = `${viewport.width}px`
      canvas.style.height = `${viewport.height}px`

      const ctx = canvas.getContext('2d', { alpha: false })!
      ctx.scale(dpr, dpr)

      const renderTask = page.render({ canvasContext: ctx, viewport })
      renderTasksRef.current[pageIndex] = renderTask

      await renderTask.promise
      renderTasksRef.current[pageIndex] = null

      setRenderedPages(prev => new Set([...prev, pageIndex]))
    } catch (e: any) {
      if (e.name !== 'RenderingCancelledException') {
        console.error(`Failed to render page ${pageIndex}:`, e)
      }
    }
  }, [zoom])

  // Re-render on zoom change
  useEffect(() => {
    if (!pdfDocRef.current) return
    visiblePagesRef.current.forEach(idx => renderPage(idx))
  }, [zoom, renderPage])

  // Track scroll to update current page indicator
  const handleScroll = useCallback(() => {
    if (!containerRef.current) return
    const container = containerRef.current
    const scrollTop = container.scrollTop
    const containerHeight = container.clientHeight

    let closestPage = 0
    let closestDist = Infinity

    for (let i = 0; i < pageCount; i++) {
      const el = pageRefs.current[i]
      if (!el) continue
      const rect = el.getBoundingClientRect()
      const containerRect = container.getBoundingClientRect()
      const relativeTop = rect.top - containerRect.top
      const dist = Math.abs(relativeTop + rect.height / 2 - containerHeight / 2)
      if (dist < closestDist) {
        closestDist = dist
        closestPage = i
      }
    }

    setCurrentPage(closestPage)
  }, [pageCount, setCurrentPage])

  const handleWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    const ctrl = e.ctrlKey || e.metaKey
    if (!ctrl || !containerRef.current) return

    e.preventDefault()

    const container = containerRef.current
    const rect = container.getBoundingClientRect()
    const pointerX = e.clientX - rect.left + container.scrollLeft
    const pointerY = e.clientY - rect.top + container.scrollTop
    const prevZoom = zoom
    const wheelStep = Math.min(MAX_WHEEL_ZOOM_STEP, Math.max(0.02, Math.abs(e.deltaY) * WHEEL_ZOOM_SENSITIVITY))
    const nextZoom = Math.max(0.25, Math.min(5, prevZoom + (e.deltaY < 0 ? wheelStep : -wheelStep)))
    if (Math.abs(nextZoom - prevZoom) < 0.0001) return

    setZoom(nextZoom)

    const ratio = nextZoom / prevZoom
    requestAnimationFrame(() => {
      container.scrollLeft = pointerX * ratio - (e.clientX - rect.left)
      container.scrollTop = pointerY * ratio - (e.clientY - rect.top)
    })
  }, [zoom, setZoom])

  // Scroll to page when currentPage changes externally (e.g., from sidebar)
  useEffect(() => {
    const el = pageRefs.current[currentPage]
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [currentPage])

  if (!activeFile) {
    return <EmptyState />
  }

  return (
    <div
      ref={containerRef}
      className="flex-1 overflow-y-auto bg-[#1a1a22] relative"
      onScroll={handleScroll}
      onWheel={handleWheel}
      style={{ scrollbarGutter: 'stable' }}
    >
      <div className="flex flex-col items-center py-8 gap-6 px-4 min-h-full">
        {Array.from({ length: pageCount }, (_, i) => {
          const size = pageSizes[i]
          const w = size ? size.width * zoom : 600 * zoom
          const h = size ? size.height * zoom : 800 * zoom

          return (
            <div
              key={i}
              data-page-index={i}
              ref={el => {
                pageRefs.current[i] = el
                if (el && observerRef.current) {
                  observerRef.current.observe(el)
                }
              }}
              className="relative flex-shrink-0"
              style={{ width: w, height: h }}
            >
              {/* PDF canvas */}
              <canvas
                className="pdf-page-canvas absolute top-0 left-0"
                style={{ width: w, height: h }}
              />

              {/* Annotation overlay + TextEdit overlay — wrapped in error boundary
                  so any runtime crash shows a recoverable notice instead of black screen */}
              <PageErrorBoundary>
                <AnnotationCanvas
                  pageIndex={i}
                  pageWidth={w}
                  pageHeight={h}
                  zoom={zoom}
                />

                {/* Text-edit overlay (active only when 'textEdit' tool is selected) */}
                <TextEditOverlay
                  pageIndex={i}
                  pageWidth={w}
                  pageHeight={h}
                  zoom={zoom}
                  pdfDoc={pdfDocState}
                  pdfData={activeFile?.data ?? null}
                />
              </PageErrorBoundary>

              {/* Page number badge */}
              <div className="absolute bottom-2 right-2 bg-black/50 text-white/70 text-xs px-2 py-0.5 rounded-full pointer-events-none">
                {i + 1}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function EmptyState() {
  const { addFile } = usePDFStore()

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    const files = Array.from(e.dataTransfer.files).filter(f => isSupportedInput(f.name, f.type))
    for (const file of files) {
      const buffer = await file.arrayBuffer()
      const prepared = await createEditableDocumentFromBytes({
        name: file.name,
        data: new Uint8Array(buffer),
        mimeType: file.type
      })
      addFile({
        id: crypto.randomUUID(),
        name: file.name,
        sourceKind: prepared.sourceKind,
        data: prepared.data,
        pageCount: 0,
        annotations: [],
        modified: false
      })
    }
  }, [addFile])

  const handleDragOver = (e: React.DragEvent) => e.preventDefault()

  const handleClick = async () => {
    if ((window as any).electronAPI) {
      const files = await (window as any).electronAPI.openFile()
      if (!files) return
      for (const file of files) {
        const data = Uint8Array.from(atob(file.data), (c: string) => c.charCodeAt(0))
        const prepared = await createEditableDocumentFromBytes({ name: file.name, data, mimeType: file.mimeType })
        addFile({
          id: crypto.randomUUID(),
          name: file.name,
          path: prepared.sourceKind === 'pdf' ? file.path : undefined,
          sourcePath: file.path,
          sourceKind: prepared.sourceKind,
          data: prepared.data,
          pageCount: 0,
          annotations: [],
          modified: false
        })
      }
    } else {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = SUPPORTED_OPEN_ACCEPT
      input.multiple = true
      input.onchange = async () => {
        for (const file of Array.from(input.files ?? [])) {
          if (!isSupportedInput(file.name, file.type)) continue
          const buffer = await file.arrayBuffer()
          const prepared = await createEditableDocumentFromBytes({
            name: file.name,
            data: new Uint8Array(buffer),
            mimeType: file.type
          })
          addFile({
            id: crypto.randomUUID(),
            name: file.name,
            sourceKind: prepared.sourceKind,
            data: prepared.data,
            pageCount: 0,
            annotations: [],
            modified: false
          })
        }
      }
      input.click()
    }
  }

  return (
    <div
      className="flex-1 flex flex-col items-center justify-center cursor-pointer group"
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onClick={handleClick}
    >
      <div className="border-2 border-dashed border-[var(--border)] group-hover:border-[var(--accent)] rounded-2xl p-16 flex flex-col items-center gap-4 transition-all duration-200 group-hover:bg-[var(--accent-subtle)]">
        <div className="w-16 h-16 rounded-2xl bg-[var(--bg-elevated)] flex items-center justify-center">
          <svg className="w-8 h-8 text-[var(--text-muted)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
        </div>
        <div className="text-center">
          <p className="text-[var(--text-primary)] font-medium text-lg">Open a PDF or image to get started</p>
          <p className="text-[var(--text-muted)] text-sm mt-1">Drop PDF, PNG, JPEG, or WebP files here</p>
        </div>
        <div className="flex items-center gap-2 mt-2">
          <kbd className="bg-[var(--bg-elevated)] text-[var(--text-secondary)] text-xs px-2 py-1 rounded border border-[var(--border)]">Ctrl</kbd>
          <span className="text-[var(--text-muted)] text-xs">+</span>
          <kbd className="bg-[var(--bg-elevated)] text-[var(--text-secondary)] text-xs px-2 py-1 rounded border border-[var(--border)]">O</kbd>
        </div>
      </div>
    </div>
  )
}
