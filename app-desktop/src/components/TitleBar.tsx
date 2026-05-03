import React from 'react'
import { PanelLeft } from 'lucide-react'
import { usePDFStore } from '../store/pdfStore'

export function TitleBar() {
  const { files, activeFileId, toggleSidebar, sidebarOpen } = usePDFStore()
  const activeFile = files.find(f => f.id === activeFileId)
  const isElectron = !!(window as any).electronAPI

  return (
    <div
      className="h-10 bg-[var(--bg-primary)] flex items-center px-3 gap-3 select-none border-b border-[var(--border-subtle)]"
      style={isElectron ? {} : undefined}
    >
      {/* App icon + name */}
      <div className="flex items-center gap-2">
        <div className="w-5 h-5 rounded bg-[var(--accent)] flex items-center justify-center">
          <span className="text-white text-[9px] font-bold">O</span>
        </div>
        <span className="text-xs font-semibold text-[var(--text-secondary)]">OportuniDocs</span>
      </div>

      {activeFile && (
        <>
          <span className="text-[var(--text-muted)] text-xs">/</span>
          <span className="text-xs text-[var(--text-primary)] font-medium truncate max-w-[300px]">
            {activeFile.name}
            {activeFile.modified && <span className="text-[var(--accent)] ml-1">●</span>}
          </span>
        </>
      )}

      <div className="flex-1" />

      <button
        onClick={toggleSidebar}
        className={`tool-btn ${sidebarOpen ? 'active' : ''}`}
        title="Toggle sidebar"
      >
        <PanelLeft size={14} />
      </button>
    </div>
  )
}
