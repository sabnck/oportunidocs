import React, { useRef, useState, useEffect } from 'react'
import { X, Trash2, PenLine, Type } from 'lucide-react'
import { usePDFStore } from '../store/pdfStore'

interface Props {
  onClose: () => void
}

export function SignatureModal({ onClose }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [drawing, setDrawing] = useState(false)
  const [mode, setMode] = useState<'draw' | 'type'>('draw')
  const [typedSig, setTypedSig] = useState('')
  const [typedFont, setTypedFont] = useState('Dancing Script, cursive')
  const [penColor, setPenColor] = useState('#1a1a2e')
  const [isEmpty, setIsEmpty] = useState(true)
  const lastPos = useRef({ x: 0, y: 0 })

  const { activeFileId, currentPage, addAnnotation, addSignature, savedSignatures } = usePDFStore()

  useEffect(() => {
    if (mode !== 'draw') return
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    setIsEmpty(true)
  }, [mode])

  function getPos(e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    const scaleX = canvas.width / rect.width
    const scaleY = canvas.height / rect.height

    if ('touches' in e) {
      const touch = e.touches[0]
      return {
        x: (touch.clientX - rect.left) * scaleX,
        y: (touch.clientY - rect.top) * scaleY
      }
    }
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY
    }
  }

  function startDraw(e: React.MouseEvent<HTMLCanvasElement>) {
    const pos = getPos(e)
    lastPos.current = pos
    setDrawing(true)
    setIsEmpty(false)
  }

  function draw(e: React.MouseEvent<HTMLCanvasElement>) {
    if (!drawing) return
    const canvas = canvasRef.current!
    const ctx = canvas.getContext('2d')!
    const pos = getPos(e)

    ctx.beginPath()
    ctx.strokeStyle = penColor
    ctx.lineWidth = 2
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.moveTo(lastPos.current.x, lastPos.current.y)
    ctx.lineTo(pos.x, pos.y)
    ctx.stroke()

    lastPos.current = pos
  }

  function endDraw() {
    setDrawing(false)
  }

  function clearCanvas() {
    const canvas = canvasRef.current!
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    setIsEmpty(true)
  }

  function getTypedDataUrl(): string {
    const canvas = document.createElement('canvas')
    canvas.width = 400
    canvas.height = 120
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.font = `48px ${typedFont}`
    ctx.fillStyle = penColor
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'center'
    ctx.fillText(typedSig, canvas.width / 2, canvas.height / 2)
    return canvas.toDataURL()
  }

  function applySignature() {
    if (!activeFileId) return

    let dataUrl: string
    if (mode === 'type') {
      if (!typedSig.trim()) return
      dataUrl = getTypedDataUrl()
    } else {
      if (isEmpty) return
      dataUrl = canvasRef.current!.toDataURL()
    }

    addAnnotation(activeFileId, {
      id: crypto.randomUUID(),
      type: 'signature',
      pageIndex: currentPage,
      x: 100, y: 400,
      width: 200, height: 80,
      imageSrc: dataUrl,
      opacity: 1
    })

    addSignature(dataUrl)
    onClose()
  }

  function applySaved(dataUrl: string) {
    if (!activeFileId) return
    addAnnotation(activeFileId, {
      id: crypto.randomUUID(),
      type: 'signature',
      pageIndex: currentPage,
      x: 100, y: 400,
      width: 200, height: 80,
      imageSrc: dataUrl,
      opacity: 1
    })
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center fade-in">
      <div className="bg-[var(--bg-secondary)] rounded-2xl border border-[var(--border)] w-full max-w-xl shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border)]">
          <h2 className="text-base font-semibold text-[var(--text-primary)]">Add Signature</h2>
          <button onClick={onClose} className="tool-btn">
            <X size={16} />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-0 border-b border-[var(--border)]">
          {[
            { id: 'draw', label: 'Draw', icon: PenLine },
            { id: 'type', label: 'Type', icon: Type }
          ].map(tab => (
            <button
              key={tab.id}
              onClick={() => setMode(tab.id as 'draw' | 'type')}
              className={`flex items-center gap-2 px-6 py-3 text-sm font-medium border-b-2 transition-colors ${
                mode === tab.id
                  ? 'border-[var(--accent)] text-[var(--accent)]'
                  : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              <tab.icon size={14} />
              {tab.label}
            </button>
          ))}
        </div>

        <div className="p-6 space-y-4">
          {mode === 'draw' && (
            <>
              <div className="flex items-center gap-2 mb-2">
                <label className="text-xs text-[var(--text-muted)]">Color</label>
                {['#1a1a2e', '#1e40af', '#15803d', '#b91c1c'].map(c => (
                  <button
                    key={c}
                    onClick={() => setPenColor(c)}
                    className="w-5 h-5 rounded-full border-2 transition-all"
                    style={{
                      background: c,
                      borderColor: penColor === c ? 'var(--accent)' : 'transparent',
                      transform: penColor === c ? 'scale(1.2)' : 'scale(1)'
                    }}
                  />
                ))}
              </div>
              <div className="relative rounded-xl overflow-hidden border border-[var(--border)] bg-white">
                <canvas
                  ref={canvasRef}
                  width={520}
                  height={150}
                  className="signature-canvas w-full block"
                  onMouseDown={startDraw}
                  onMouseMove={draw}
                  onMouseUp={endDraw}
                  onMouseLeave={endDraw}
                />
                {isEmpty && (
                  <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                    <span className="text-gray-300 text-lg">Draw your signature here</span>
                  </div>
                )}
              </div>
              <button onClick={clearCanvas} className="btn-ghost flex items-center gap-1.5 text-xs">
                <Trash2 size={12} /> Clear
              </button>
            </>
          )}

          {mode === 'type' && (
            <>
              <div>
                <label className="block text-xs text-[var(--text-muted)] mb-1.5">Your name</label>
                <input
                  type="text"
                  value={typedSig}
                  onChange={e => setTypedSig(e.target.value)}
                  placeholder="Type your name..."
                  className="input-field w-full"
                />
              </div>
              <div>
                <label className="block text-xs text-[var(--text-muted)] mb-1.5">Style</label>
                <div className="grid grid-cols-2 gap-2">
                  {[
                    { label: 'Cursive', font: 'Dancing Script, cursive' },
                    { label: 'Script', font: 'Pacifico, cursive' },
                    { label: 'Formal', font: 'Georgia, serif' },
                    { label: 'Modern', font: 'sans-serif' }
                  ].map(s => (
                    <button
                      key={s.font}
                      onClick={() => setTypedFont(s.font)}
                      className={`px-3 py-3 rounded-lg border text-sm transition-all ${
                        typedFont === s.font
                          ? 'border-[var(--accent)] bg-[var(--accent-subtle)]'
                          : 'border-[var(--border)] hover:border-[var(--border)]'
                      }`}
                      style={{ fontFamily: s.font, fontSize: 20, color: penColor }}
                    >
                      {typedSig || s.label}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}

          {/* Saved signatures */}
          {savedSignatures.length > 0 && (
            <div>
              <p className="text-xs text-[var(--text-muted)] mb-2">Saved signatures</p>
              <div className="flex gap-2 flex-wrap">
                {savedSignatures.map((sig, i) => (
                  <button
                    key={i}
                    onClick={() => applySaved(sig)}
                    className="border border-[var(--border)] rounded-lg overflow-hidden hover:border-[var(--accent)] transition-colors bg-white"
                  >
                    <img src={sig} alt={`Signature ${i + 1}`} className="h-12 w-auto max-w-[120px] object-contain" />
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button onClick={onClose} className="btn-ghost">Cancel</button>
            <button
              onClick={applySignature}
              className="btn-primary"
              disabled={mode === 'draw' ? isEmpty : !typedSig.trim()}
            >
              Apply Signature
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
