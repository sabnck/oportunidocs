import React, { useEffect, useRef, useState } from 'react'
import * as PDFJS from 'pdfjs-dist'
import { RotateCw, Trash2, Copy, ChevronUp, ChevronDown, X } from 'lucide-react'
import { usePDFStore } from '../store/pdfStore'
import { rotatePages, deletePages, duplicatePage, reorderPages } from '../utils/pdfOperations'

export function Sidebar() {
  const {
    files, activeFileId, currentPage, sidebarOpen,
    setCurrentPage, updateFileData, removeFile
  } = usePDFStore()

  const activeFile = files.find(f => f.id === activeFileId)
  const [thumbnails, setThumbnails] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [dragOver, setDragOver] = useState<number | null>(null)
  const [dragging, setDragging] = useState<number | null>(null)
  const [pageOrder, setPageOrder] = useState<number[]>([])

  useEffect(() => {
    if (!activeFile) {
      setThumbnails([])
      setPageOrder([])
      return
    }
    generateThumbnails(activeFile.data)
  }, [activeFile?.id, activeFile?.data])

  async function generateThumbnails(data: Uint8Array) {
    setLoading(true)
    setThumbnails([])
    try {
      const pdf = await PDFJS.getDocument({ data: data.slice() }).promise
      const thumbs: string[] = []
      const order: number[] = []
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i)
        const viewport = page.getViewport({ scale: 0.3 })
        const canvas = document.createElement('canvas')
        canvas.width = viewport.width
        canvas.height = viewport.height
        const ctx = canvas.getContext('2d')!
        await page.render({ canvasContext: ctx, viewport }).promise
        thumbs.push(canvas.toDataURL())
        order.push(i - 1)
      }
      setThumbnails(thumbs)
      setPageOrder(order)
    } catch (e) {
      console.error('Thumbnail generation failed:', e)
    } finally {
      setLoading(false)
    }
  }

  async function handleRotate(pageIndex: number) {
    if (!activeFile) return
    const newData = await rotatePages(activeFile.data, [pageIndex], 90)
    updateFileData(activeFile.id, newData)
  }

  async function handleDelete(pageIndex: number) {
    if (!activeFile) return
    if (thumbnails.length <= 1) return
    const newData = await deletePages(activeFile.data, [pageIndex])
    updateFileData(activeFile.id, newData)
  }

  async function handleDuplicate(pageIndex: number) {
    if (!activeFile) return
    const newData = await duplicatePage(activeFile.data, pageIndex)
    updateFileData(activeFile.id, newData)
  }

  // Drag and drop reordering
  function handleDragStart(e: React.DragEvent, index: number) {
    setDragging(index)
    e.dataTransfer.effectAllowed = 'move'
  }

  function handleDragOver(e: React.DragEvent, index: number) {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDragOver(index)
  }

  async function handleDrop(e: React.DragEvent, dropIndex: number) {
    e.preventDefault()
    if (dragging === null || dragging === dropIndex || !activeFile) return

    const newOrder = [...pageOrder]
    const [moved] = newOrder.splice(dragging, 1)
    newOrder.splice(dropIndex, 0, moved)
    setPageOrder(newOrder)

    const newData = await reorderPages(activeFile.data, newOrder)
    updateFileData(activeFile.id, newData)
    setDragging(null)
    setDragOver(null)
  }

  if (!sidebarOpen) return null

  return (
    <div className="w-48 bg-[var(--bg-secondary)] border-r border-[var(--border)] flex flex-col">
      {/* File tabs */}
      <div className="flex items-center gap-0.5 px-2 pt-2 overflow-x-auto scrollbar-none">
        {files.map(f => (
          <button
            key={f.id}
            onClick={() => usePDFStore.getState().setActiveFile(f.id)}
            className={`flex items-center gap-1 px-2 py-1 rounded text-xs whitespace-nowrap max-w-[110px] transition-colors ${
              f.id === activeFileId
                ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)]'
                : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
            }`}
            title={f.name}
          >
            <span className="truncate">{f.name}</span>
            {f.modified && <span className="text-[var(--accent)] ml-0.5">•</span>}
            <span
              className="ml-auto opacity-50 hover:opacity-100"
              onClick={e => { e.stopPropagation(); removeFile(f.id) }}
            >
              <X size={10} />
            </span>
          </button>
        ))}
      </div>

      {/* Page count */}
      {activeFile && (
        <div className="px-3 py-1.5 text-[10px] text-[var(--text-muted)]">
          {thumbnails.length} pages
        </div>
      )}

      {/* Thumbnails */}
      <div className="flex-1 sidebar-scroll px-2 py-1 flex flex-col gap-2">
        {loading && (
          <div className="flex items-center justify-center py-8 text-[var(--text-muted)] text-xs">
            Rendering pages...
          </div>
        )}

        {thumbnails.map((thumb, index) => (
          <div
            key={index}
            draggable
            onDragStart={e => handleDragStart(e, index)}
            onDragOver={e => handleDragOver(e, index)}
            onDrop={e => handleDrop(e, index)}
            onDragLeave={() => setDragOver(null)}
            className={`page-thumb group flex flex-col gap-1 ${currentPage === index ? 'active' : ''} ${dragOver === index ? 'border-[var(--accent)]' : ''}`}
            style={{ opacity: dragging === index ? 0.4 : 1 }}
          >
            <div
              className="relative overflow-hidden rounded bg-white cursor-pointer"
              onClick={() => setCurrentPage(index)}
            >
              <img
                src={thumb}
                alt={`Page ${index + 1}`}
                className="w-full block"
                draggable={false}
              />

              {/* Page actions overlay */}
              <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-1">
                <PageAction icon={RotateCw} label="Rotate" onClick={() => handleRotate(index)} />
                <PageAction icon={Copy} label="Duplicate" onClick={() => handleDuplicate(index)} />
                <PageAction icon={Trash2} label="Delete" onClick={() => handleDelete(index)} danger />
              </div>
            </div>

            <div className="text-center text-[10px] text-[var(--text-muted)] pb-0.5 select-none">
              {index + 1}
            </div>
          </div>
        ))}

        {!loading && !activeFile && (
          <div className="text-center text-[var(--text-muted)] text-xs py-8">
            No document open
          </div>
        )}
      </div>
    </div>
  )
}

function PageAction({
  icon: Icon,
  label,
  onClick,
  danger = false
}: {
  icon: React.ComponentType<any>
  label: string
  onClick: () => void
  danger?: boolean
}) {
  return (
    <button
      title={label}
      onClick={e => { e.stopPropagation(); onClick() }}
      className={`w-7 h-7 rounded flex items-center justify-center transition-colors ${
        danger
          ? 'bg-red-500/80 hover:bg-red-500 text-white'
          : 'bg-white/80 hover:bg-white text-gray-800'
      }`}
    >
      <Icon size={12} />
    </button>
  )
}
