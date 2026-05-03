import React, { useState, useEffect } from 'react'
import { X, SlidersHorizontal, Save } from 'lucide-react'
import { usePDFStore, PDFFile } from '../store/pdfStore'
import { getMetadata, setMetadata } from '../utils/pdfOperations'

interface Props {
  file: PDFFile
  onClose: () => void
}

export function PropertiesModal({ file, onClose }: Props) {
  const { updateFileData, markModified } = usePDFStore()
  const [meta, setMeta] = useState({
    title: '', author: '', subject: '', keywords: '', creator: '', producer: '', pageCount: 0
  })
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getMetadata(file.data).then(m => {
      setMeta(m)
      setLoading(false)
    })
  }, [file.id])

  const handleSave = async () => {
    setSaving(true)
    try {
      const updated = await setMetadata(file.data, {
        title: meta.title,
        author: meta.author,
        subject: meta.subject,
        keywords: meta.keywords ? [meta.keywords] : [],
        creator: meta.creator,
        producer: meta.producer
      })
      updateFileData(file.id, updated)
      markModified(file.id)
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center fade-in">
      <div className="bg-[var(--bg-secondary)] rounded-2xl border border-[var(--border)] w-full max-w-md shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border)]">
          <div className="flex items-center gap-2">
            <SlidersHorizontal size={16} className="text-[var(--accent)]" />
            <h2 className="text-base font-semibold">Document Properties</h2>
          </div>
          <button onClick={onClose} className="tool-btn"><X size={16} /></button>
        </div>

        <div className="p-6 space-y-4">
          {loading ? (
            <div className="text-[var(--text-muted)] text-sm py-4 text-center">Loading...</div>
          ) : (
            <>
              <Field label="File name" value={file.name} readOnly />
              <Field label="Pages" value={String(meta.pageCount)} readOnly />

              <div className="h-px bg-[var(--border)]" />

              <Field
                label="Title"
                value={meta.title}
                onChange={v => setMeta(m => ({ ...m, title: v }))}
                placeholder="Document title..."
              />
              <Field
                label="Author"
                value={meta.author}
                onChange={v => setMeta(m => ({ ...m, author: v }))}
                placeholder="Author name..."
              />
              <Field
                label="Subject"
                value={meta.subject}
                onChange={v => setMeta(m => ({ ...m, subject: v }))}
                placeholder="Subject..."
              />
              <Field
                label="Keywords"
                value={meta.keywords}
                onChange={v => setMeta(m => ({ ...m, keywords: v }))}
                placeholder="keyword1, keyword2..."
              />

              <div className="h-px bg-[var(--border)]" />
              <Field
                label="Created by"
                value={meta.creator}
                onChange={v => setMeta(m => ({ ...m, creator: v }))}
                placeholder="OportuniDocs"
              />
              <Field
                label="Producer"
                value={meta.producer}
                onChange={v => setMeta(m => ({ ...m, producer: v }))}
                placeholder="OportuniDocs"
              />

              <div className="h-px bg-[var(--border)]" />
              <div className="text-xs text-[var(--text-muted)]">
                Edited with OportuniDocs by Henrique Fernandes
              </div>
            </>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button onClick={onClose} className="btn-ghost">Cancel</button>
            <button onClick={handleSave} disabled={saving || loading} className="btn-primary flex items-center gap-1.5 disabled:opacity-40">
              <Save size={13} />
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function Field({
  label, value, onChange, readOnly = false, placeholder
}: {
  label: string
  value: string
  onChange?: (v: string) => void
  readOnly?: boolean
  placeholder?: string
}) {
  return (
    <div>
      <label className="block text-xs text-[var(--text-muted)] mb-1">{label}</label>
      <input
        type="text"
        value={value}
        onChange={e => onChange?.(e.target.value)}
        readOnly={readOnly}
        placeholder={placeholder}
        className={`input-field w-full ${readOnly ? 'opacity-60 cursor-default' : ''}`}
      />
    </div>
  )
}
