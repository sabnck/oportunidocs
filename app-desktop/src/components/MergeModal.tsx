import React, { useState, useCallback } from 'react'
import { X, Layers, GripVertical, Trash2, Plus } from 'lucide-react'
import { usePDFStore } from '../store/pdfStore'
import { mergePDFs } from '../utils/pdfOperations'

interface MergeFile {
  id: string
  name: string
  data: Uint8Array
}

interface Props {
  onClose: () => void
}

export function MergeModal({ onClose }: Props) {
  const { addFile } = usePDFStore()
  const [files, setFiles] = useState<MergeFile[]>([])
  const [merging, setMerging] = useState(false)
  const [dragging, setDragging] = useState<number | null>(null)
  const [dragOver, setDragOver] = useState<number | null>(null)

  const addFiles = useCallback(async (newFiles: File[]) => {
    const loaded = await Promise.all(
      newFiles.filter(f => f.type === 'application/pdf').map(async f => ({
        id: crypto.randomUUID(),
        name: f.name,
        data: new Uint8Array(await f.arrayBuffer())
      }))
    )
    setFiles(prev => [...prev, ...loaded])
  }, [])

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    addFiles(Array.from(e.dataTransfer.files))
  }

  const handleBrowse = async () => {
    const input = document.createElement('input')
    input.type = 'file'; input.accept = '.pdf'; input.multiple = true
    input.onchange = () => addFiles(Array.from(input.files ?? []))
    input.click()
  }

  const handleRemove = (id: string) => {
    setFiles(prev => prev.filter(f => f.id !== id))
  }

  const handleDragStart = (index: number) => setDragging(index)
  const handleDragOverItem = (e: React.DragEvent, index: number) => {
    e.preventDefault()
    setDragOver(index)
  }

  const handleDropItem = (dropIndex: number) => {
    if (dragging === null || dragging === dropIndex) return
    const newFiles = [...files]
    const [moved] = newFiles.splice(dragging, 1)
    newFiles.splice(dropIndex, 0, moved)
    setFiles(newFiles)
    setDragging(null)
    setDragOver(null)
  }

  const handleMerge = async () => {
    if (files.length < 1) return
    setMerging(true)
    try {
      const merged = await mergePDFs(files.map(f => f.data))
      const firstName = files[0].name.replace('.pdf', '')
      const name = `${firstName}_merged.pdf`

      addFile({
        id: crypto.randomUUID(), name, data: merged,
        pageCount: 0, annotations: [], modified: true
      })
      onClose()
    } catch (e) {
      console.error('Merge failed:', e)
    } finally {
      setMerging(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center fade-in">
      <div className="bg-[var(--bg-secondary)] rounded-2xl border border-[var(--border)] w-full max-w-lg shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border)]">
          <div className="flex items-center gap-2">
            <Layers size={16} className="text-[var(--accent)]" />
            <h2 className="text-base font-semibold">Merge PDFs</h2>
          </div>
          <button onClick={onClose} className="tool-btn"><X size={16} /></button>
        </div>

        <div className="p-6 space-y-4">
          {/* Drop zone */}
          <div
            onDrop={handleDrop}
            onDragOver={e => e.preventDefault()}
            onClick={handleBrowse}
            className="border-2 border-dashed border-[var(--border)] hover:border-[var(--accent)] rounded-xl p-6 flex flex-col items-center gap-2 cursor-pointer transition-colors hover:bg-[var(--accent-subtle)]"
          >
            <Plus size={24} className="text-[var(--text-muted)]" />
            <p className="text-sm text-[var(--text-secondary)]">Add PDF files</p>
            <p className="text-xs text-[var(--text-muted)]">Drop files or click to browse</p>
          </div>

          {/* File list */}
          {files.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs text-[var(--text-muted)]">
                {files.length} file{files.length !== 1 ? 's' : ''} — drag to reorder
              </p>
              {files.map((file, i) => (
                <div
                  key={file.id}
                  draggable
                  onDragStart={() => handleDragStart(i)}
                  onDragOver={e => handleDragOverItem(e, i)}
                  onDrop={() => handleDropItem(i)}
                  onDragLeave={() => setDragOver(null)}
                  className={`flex items-center gap-3 px-3 py-2.5 rounded-lg border transition-all ${
                    dragOver === i ? 'border-[var(--accent)] bg-[var(--accent-subtle)]' : 'border-[var(--border)] bg-[var(--bg-tertiary)]'
                  }`}
                  style={{ opacity: dragging === i ? 0.4 : 1 }}
                >
                  <GripVertical size={14} className="text-[var(--text-muted)] cursor-grab" />
                  <span className="text-xs text-[var(--text-muted)] w-5 text-center">{i + 1}</span>
                  <span className="flex-1 text-sm text-[var(--text-primary)] truncate">{file.name}</span>
                  <button
                    onClick={() => handleRemove(file.id)}
                    className="tool-btn text-[var(--danger)] hover:text-[var(--danger)]"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button onClick={onClose} className="btn-ghost">Cancel</button>
            <button
              onClick={handleMerge}
              disabled={files.length < 1 || merging}
              className="btn-primary disabled:opacity-40"
            >
              {merging ? 'Merging...' : `Merge ${files.length} file${files.length !== 1 ? 's' : ''}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
