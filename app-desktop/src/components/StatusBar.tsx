import React from 'react'
import { usePDFStore } from '../store/pdfStore'
import { Check, AlertCircle } from 'lucide-react'

export function StatusBar() {
  const { files, activeFileId, currentPage, zoom } = usePDFStore()
  const activeFile = files.find(f => f.id === activeFileId)

  return (
    <div className="h-6 bg-[var(--bg-primary)] border-t border-[var(--border)] flex items-center px-4 gap-4 text-[10px] text-[var(--text-muted)] select-none">
      {activeFile ? (
        <>
          {/* Save status */}
          <div className="flex items-center gap-1">
            {activeFile.modified ? (
              <>
                <AlertCircle size={10} className="text-[var(--warning)]" />
                <span>Unsaved changes</span>
              </>
            ) : (
              <>
                <Check size={10} className="text-[var(--success)]" />
                <span>Saved</span>
              </>
            )}
          </div>

          <div className="w-px h-3 bg-[var(--border)]" />

          {/* Page */}
          <span>Page {currentPage + 1}</span>

          <div className="w-px h-3 bg-[var(--border)]" />

          {/* Zoom */}
          <span>{Math.round(zoom * 100)}%</span>

          <div className="flex-1" />

          {/* Branding */}
          <span className="text-[var(--text-muted)] opacity-60">
            OportuniDocs por Henrique Fernandes | StudioElevatio.com
          </span>
        </>
      ) : (
        <span>Ready</span>
      )}
    </div>
  )
}
