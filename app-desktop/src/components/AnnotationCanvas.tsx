import React, { useRef, useState, useEffect, useCallback } from 'react'
import { usePDFStore, Annotation, ToolType } from '../store/pdfStore'
import { extractFontsFromPDF } from '../utils/fontExtractor'
import { resolveViewportTextEditFrame } from '../utils/textLayoutEngine'
import { chooseTextEditStrategy } from '../utils/exportStrategy'
import { reconstructBackgroundPatchCanvas } from '../utils/localReconstruction'
import { fitTextToBox } from '../utils/textBoxFit'

function splitTrackedGlyphs(text: string): string[] {
  return Array.from(text)
}

function normalizeTrackedLine(text: string, trackingMode?: 'normal' | 'spaced'): string {
  if (trackingMode !== 'spaced') return text
  return text.replace(/\s+/g, '')
}

function measureTrackedLineWidth(
  ctx: CanvasRenderingContext2D,
  text: string,
  letterSpacingPx: number,
  trackingMode?: 'normal' | 'spaced'
): number {
  if (trackingMode !== 'spaced') return ctx.measureText(text).width
  const glyphs = splitTrackedGlyphs(normalizeTrackedLine(text, trackingMode))
  if (glyphs.length === 0) return 0
  return glyphs.reduce((sum, glyph, index) => {
    const advance = ctx.measureText(glyph).width
    return sum + advance + (index < glyphs.length - 1 ? letterSpacingPx : 0)
  }, 0)
}

function drawTrackedLine(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  letterSpacingPx: number,
  trackingMode?: 'normal' | 'spaced'
) {
  if (trackingMode !== 'spaced') {
    ctx.fillText(text, x, y)
    return
  }

  const glyphs = splitTrackedGlyphs(normalizeTrackedLine(text, trackingMode))
  let cursorX = x
  glyphs.forEach((glyph, index) => {
    ctx.fillText(glyph, cursorX, y)
    cursorX += ctx.measureText(glyph).width
    if (index < glyphs.length - 1) cursorX += letterSpacingPx
  })
}

interface Props {
  pageIndex: number
  pageWidth: number
  pageHeight: number
  zoom: number
}

export function AnnotationCanvas({ pageIndex, pageWidth, pageHeight, zoom }: Props) {
  const {
    activeFileId, files, activeTool,
    drawColor, drawOpacity, strokeWidth,
    fontSize, fontFamily, highlightColor, textColor,
    addAnnotation, removeAnnotation, updateAnnotation
  } = usePDFStore()

  const activeFile = files.find(f => f.id === activeFileId)
  const pageAnnotations = activeFile?.annotations.filter(a => a.pageIndex === pageIndex) ?? []

  const canvasRef = useRef<HTMLCanvasElement>(null)
  // Incremented when textEdit fonts finish loading → triggers canvas redraw
  const [fontLoadVersion, setFontLoadVersion] = useState(0)
  const [drawing, setDrawing] = useState(false)
  const [startPos, setStartPos] = useState({ x: 0, y: 0 })
  const [currentPoints, setCurrentPoints] = useState<number[][]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editingTextId, setEditingTextId] = useState<string | null>(null)
  const [editingText, setEditingText] = useState('')
  const editInputRef = useRef<HTMLTextAreaElement>(null)

  // When textEdit annotations are added/changed, ensure embedded PDF fonts are
  // registered as @font-face AND loaded into browser memory before redrawing.
  // extractFontsFromPDF() is cached by PDF fingerprint — subsequent calls are free.
  useEffect(() => {
    const textEdits = pageAnnotations.filter(a => a.type === 'textEdit' && a.fontFamily)
    if (textEdits.length === 0 || !activeFile?.data) return

    extractFontsFromPDF(activeFile.data)
      .then(async () => {
        // Pre-load each font into browser memory so ctx.font uses the real typeface
        await Promise.allSettled(
          textEdits.map(ann => {
            if (!ann.fontFamily) return Promise.resolve()
            const size   = ann.vpFontSize ?? 16
            const family = ann.fontFamily.split(',')[0].trim().replace(/['"]/g, '')
            return document.fonts.load(`${size}px '${family}'`).catch(() => {})
          })
        )
        setFontLoadVersion(v => v + 1)
      })
      .catch(() => {})
  }, [activeFile?.id, pageAnnotations.filter(a => a.type === 'textEdit').length])

  // Redraw annotation overlay when annotations change
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!

    // Scale the canvas to match the device pixel ratio so annotations are
    // as sharp as the underlying PDF.js canvas (which also applies DPR).
    const dpr = window.devicePixelRatio || 1
    canvas.width  = pageWidth  * dpr
    canvas.height = pageHeight * dpr
    canvas.style.width  = `${pageWidth}px`
    canvas.style.height = `${pageHeight}px`
    ctx.scale(dpr, dpr)

    ctx.clearRect(0, 0, pageWidth, pageHeight)

    for (const ann of pageAnnotations) {
      drawAnnotation(ctx, ann)
      if (selectedId === ann.id) {
        drawSelectionHandle(ctx, ann)
      }
    }

    // Draw in-progress freehand
    if (drawing && currentPoints.length > 1) {
      ctx.beginPath()
      ctx.strokeStyle = drawColor
      ctx.lineWidth = strokeWidth
      ctx.globalAlpha = drawOpacity
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.moveTo(currentPoints[0][0], currentPoints[0][1])
      for (let i = 1; i < currentPoints.length; i++) {
        ctx.lineTo(currentPoints[i][0], currentPoints[i][1])
      }
      ctx.stroke()
      ctx.globalAlpha = 1
    }
  }, [pageAnnotations, drawing, currentPoints, selectedId, pageWidth, pageHeight, fontLoadVersion])

  function drawAnnotation(ctx: CanvasRenderingContext2D, ann: Annotation) {
    ctx.save()
    ctx.globalAlpha = ann.opacity ?? 1

    const color = ann.color ?? drawColor

    switch (ann.type) {
      case 'highlight': {
        ctx.fillStyle = color
        ctx.globalAlpha = 0.35
        ctx.fillRect(ann.x, ann.y, ann.width ?? 100, ann.height ?? 20)
        break
      }
      case 'underline': {
        ctx.strokeStyle = color
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.moveTo(ann.x, ann.y + (ann.height ?? 20))
        ctx.lineTo(ann.x + (ann.width ?? 100), ann.y + (ann.height ?? 20))
        ctx.stroke()
        break
      }
      case 'strikethrough': {
        ctx.strokeStyle = color
        ctx.lineWidth = 2
        ctx.beginPath()
        const midY = ann.y + (ann.height ?? 20) / 2
        ctx.moveTo(ann.x, midY)
        ctx.lineTo(ann.x + (ann.width ?? 100), midY)
        ctx.stroke()
        break
      }
      case 'text': {
        const fontSize = ann.fontSize ?? 14
        const lineHeight = fontSize * 1.2
        const lines = (ann.text ?? '').split('\n')
        if (ann.backgroundColor) {
          ctx.fillStyle = ann.backgroundColor
          ctx.fillRect(ann.x, ann.y, ann.width ?? 100, ann.height ?? Math.max(lineHeight, lines.length * lineHeight))
        }
        ctx.font = `${fontSize}px ${ann.fontFamily ?? 'sans-serif'}`
        ctx.fillStyle = color
        lines.forEach((line, i) => {
          ctx.fillText(line, ann.x + (ann.backgroundColor ? 2 : 0), ann.y + fontSize + i * lineHeight)
        })
        break
      }
      case 'rectangle': {
        ctx.strokeStyle = color
        ctx.lineWidth = ann.strokeWidth ?? 2
        ctx.strokeRect(ann.x, ann.y, ann.width ?? 100, ann.height ?? 60)
        break
      }
      case 'circle': {
        ctx.strokeStyle = color
        ctx.lineWidth = ann.strokeWidth ?? 2
        ctx.beginPath()
        ctx.ellipse(
          ann.x + (ann.width ?? 100) / 2,
          ann.y + (ann.height ?? 60) / 2,
          (ann.width ?? 100) / 2,
          (ann.height ?? 60) / 2,
          0, 0, Math.PI * 2
        )
        ctx.stroke()
        break
      }
      case 'draw':
      case 'signature': {
        if (ann.imageSrc) {
          const img = new Image()
          img.src = ann.imageSrc
          img.onload = () => {
            ctx.drawImage(img, ann.x, ann.y, ann.width ?? 200, ann.height ?? 80)
          }
          if (img.complete) {
            ctx.drawImage(img, ann.x, ann.y, ann.width ?? 200, ann.height ?? 80)
          }
        } else if (ann.points && ann.points.length > 1) {
          ctx.strokeStyle = color
          ctx.lineWidth = ann.strokeWidth ?? 2
          ctx.lineCap = 'round'
          ctx.lineJoin = 'round'
          ctx.beginPath()
          ctx.moveTo(ann.points[0][0], ann.points[0][1])
          for (let i = 1; i < ann.points.length; i++) {
            ctx.lineTo(ann.points[i][0], ann.points[i][1])
          }
          ctx.stroke()
        }
        break
      }
      case 'image': {
        if (ann.imageSrc) {
          const img = new Image()
          img.src = ann.imageSrc
          if (img.complete) {
            ctx.drawImage(img, ann.x, ann.y, ann.width ?? 200, ann.height ?? 150)
          } else {
            img.onload = () => {
              ctx.drawImage(img, ann.x, ann.y, ann.width ?? 200, ann.height ?? 150)
            }
          }
        }
        break
      }
      case 'stamp': {
        const w = ann.width ?? 150
        const h = ann.height ?? 50
        ctx.strokeStyle = color
        ctx.lineWidth = 2
        ctx.strokeRect(ann.x, ann.y, w, h)
        ctx.font = 'bold 16px sans-serif'
        ctx.fillStyle = color
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(ann.text ?? 'APPROVED', ann.x + w / 2, ann.y + h / 2)
        ctx.textAlign = 'left'
        ctx.textBaseline = 'alphabetic'
        break
      }
      case 'comment': {
        ctx.fillStyle = '#fbbf24'
        ctx.beginPath()
        ctx.arc(ann.x + 10, ann.y + 10, 10, 0, Math.PI * 2)
        ctx.fill()
        ctx.fillStyle = '#000'
        ctx.font = 'bold 12px sans-serif'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText('!', ann.x + 10, ann.y + 10)
        ctx.textAlign = 'left'
        ctx.textBaseline = 'alphabetic'
        break
      }

      // textEdit: pixel-perfect text replacement.
      // Background color comes directly from the PDF content stream (ann.bgColor),
      // so it exactly matches the original fill — no pixel-sampling artefacts.
      case 'textEdit': {
        const newText = ann.text   ?? ''
        const lines   = newText.split('\n')
        const frame = resolveViewportTextEditFrame(ann, pageHeight, zoom)
        const baseFontSize = frame.fontSize
        const baseLineHeightVp = frame.lineHeight
        const anchorX = frame.anchorX
        const baselineY = frame.baselineY
        const container = frame.container
        const strategy = chooseTextEditStrategy(ann)
        const freeCenterX = !container && ann.textAlign === 'center' && ann.pdfRawX !== undefined && ann.pdfRawWidth !== undefined
          ? (ann.pdfRawX + ann.pdfRawWidth / 2) * zoom
          : null

        const weightSpec = ann.isBold   ? 'bold '   : ''
        const styleSpec  = ann.isItalic ? 'italic ' : ''

        const fontStack = ann.fontFamily
          ? `${styleSpec}${weightSpec}${baseFontSize}px ${ann.fontFamily}`
          : `${styleSpec}${weightSpec}${baseFontSize}px sans-serif`
        const baseLetterSpacingPx = (ann.letterSpacingEm ?? 0) * baseFontSize
        ctx.font = fontStack
        const w = frame.boxWidth
        const h = frame.boxHeight
        const insetLeft = container?.insetX ?? 0
        const insetRight = container?.insetX ?? 0
        const availableWidth = Math.max(4, w - insetLeft - insetRight)
        const availableHeight = Math.max(4, h)
        const fitted = fitTextToBox({
          lines,
          baseFontSize,
          baseLineHeight: baseLineHeightVp,
          maxWidth: availableWidth,
          maxHeight: availableHeight,
          measureLine: (fontSize, _lineHeight, line) => {
            const letterSpacingPx = (ann.letterSpacingEm ?? 0) * fontSize
            const fitStack = ann.fontFamily
              ? `${styleSpec}${weightSpec}${fontSize}px ${ann.fontFamily}`
              : `${styleSpec}${weightSpec}${fontSize}px sans-serif`
            ctx.font = fitStack
            return measureTrackedLineWidth(ctx, line, letterSpacingPx, ann.trackingMode)
          },
        })

        const fontSize = fitted.fontSize
        const lineHeightVp = fitted.lineHeight
        const letterSpacingPx = (ann.letterSpacingEm ?? 0) * fontSize
        ctx.font = ann.fontFamily
          ? `${styleSpec}${weightSpec}${fontSize}px ${ann.fontFamily}`
          : `${styleSpec}${weightSpec}${fontSize}px sans-serif`
        const textMetrics = lines.map(line => ctx.measureText(line || ' '))
        const maxAscent = Math.max(...textMetrics.map(metric => metric.actualBoundingBoxAscent ?? fontSize * 0.78), fontSize * 0.78)
        const maxDescent = Math.max(...textMetrics.map(metric => metric.actualBoundingBoxDescent ?? fontSize * 0.22), fontSize * 0.22)
        const totalH       = lineHeightVp * Math.max(lines.length - 1, 0) + maxAscent + maxDescent
        const topPad       = Math.max(3, fontSize * 0.18)
        const bottomPad    = Math.max(2, fontSize * 0.14)
        const sidePad      = Math.max(2, fontSize * 0.18)
        const coverX       = container
          ? container.x
          : freeCenterX !== null
            ? freeCenterX - (w + sidePad * 2) / 2
            : anchorX - sidePad
        const coverY       = container ? container.y : (baselineY - maxAscent - topPad)
        const coverW       = container ? container.width : w + sidePad * 2
        const coverH       = container ? container.height : Math.max(h, totalH + topPad + bottomPad)

        // Structural PDF color is truth. Sampled color is only a controlled
        // visual hint for simpler strategies, never the document truth.
        const canUseApproximateBackground =
          strategy === 'solidCoverRedraw' || strategy === 'containerRebuild'
        const bgFill: string | null = ann.bgColor
          ?? ann.sampledBgColor
          ?? (canUseApproximateBackground ? '#ffffff' : null)
        let restoredBackground = false

        const shouldReconstructPreview =
          strategy === 'localReconstruction' &&
          ann.blockKind !== 'textOverImage' &&
          coverW >= 8 &&
          coverH >= 6 &&
          zoom >= 0.5

        try {
          const pdfCanvas = canvasRef.current
            ?.closest('[data-page-index]')
            ?.querySelector('.pdf-page-canvas') as HTMLCanvasElement | null
          const patch = shouldReconstructPreview && pdfCanvas
            ? reconstructBackgroundPatchCanvas(pdfCanvas, coverX, coverY, coverW, coverH)
            : null
          if (patch) {
            ctx.drawImage(patch, coverX, coverY, coverW, coverH)
            restoredBackground = true
          }
        } catch { /* preview patch stays empty */ }

        if (!restoredBackground && bgFill && strategy !== 'nativePatch') {
          ctx.fillStyle = bgFill
          ctx.fillRect(coverX, coverY, coverW, coverH)
        }

        // ── 2. Draw replacement text with the original font + color ───────────
        ctx.font = ann.fontFamily
          ? `${styleSpec}${weightSpec}${fontSize}px ${ann.fontFamily}`
          : `${styleSpec}${weightSpec}${fontSize}px sans-serif`
        ctx.fillStyle    = ann.textColor ?? ann.color ?? '#111111'
        ctx.textBaseline = 'alphabetic'
        ctx.save()
        ctx.beginPath()
        ctx.rect(coverX, coverY, coverW, coverH)
        ctx.clip()

        lines.forEach((line, i) => {
          const lineY = (container?.baselineY ?? baselineY) + i * lineHeightVp
          let lineX = anchorX
          if (container) {
            const measured = measureTrackedLineWidth(ctx, line, letterSpacingPx, ann.trackingMode)
            if (ann.textAlign === 'center') {
              lineX = container.x + (container.width - measured) / 2
            } else if (ann.textAlign === 'right') {
              lineX = container.x + container.width - measured - container.insetX
            } else {
              lineX = container.x + container.insetX
            }
          } else if (freeCenterX !== null) {
            const measured = measureTrackedLineWidth(ctx, line, letterSpacingPx, ann.trackingMode)
            lineX = freeCenterX - measured / 2
          }
          drawTrackedLine(ctx, line, lineX, lineY, letterSpacingPx, ann.trackingMode)
        })

        ctx.restore()

        ctx.textBaseline = 'alphabetic'
        break
      }
    }
    ctx.restore()
  }

  function getAnnotationBounds(ann: Annotation) {
    if (ann.type === 'textEdit') {
      const frame = resolveViewportTextEditFrame(ann, pageHeight, zoom)
      const x = frame.container?.x ?? frame.anchorX
      const y = frame.container?.y ?? (frame.baselineY - frame.fontSize)
      return { x, y, width: frame.boxWidth, height: frame.boxHeight }
    }
    return {
      x: ann.x,
      y: ann.y,
      width: ann.width ?? 100,
      height: ann.height ?? 40,
    }
  }

  function drawSelectionHandle(ctx: CanvasRenderingContext2D, ann: Annotation) {
    const bounds = getAnnotationBounds(ann)
    const x = bounds.x - 3
    const y = bounds.y - 3
    const w = bounds.width + 6
    const h = bounds.height + 6

    ctx.save()
    ctx.strokeStyle = '#6366f1'
    ctx.lineWidth = 1.5
    ctx.setLineDash([4, 2])
    ctx.strokeRect(x, y, w, h)
    ctx.setLineDash([])

    // Corner handles
    const corners = [[x, y], [x + w, y], [x, y + h], [x + w, y + h]]
    corners.forEach(([cx, cy]) => {
      ctx.fillStyle = '#6366f1'
      ctx.fillRect(cx - 4, cy - 4, 8, 8)
    })
    ctx.restore()
  }

  function getPos(e: React.MouseEvent<HTMLCanvasElement>) {
    const rect = canvasRef.current!.getBoundingClientRect()
    // Use CSS dimensions (rect.width/height) which equal pageWidth/pageHeight
    // regardless of DPR — annotation coordinates are always in CSS px.
    return {
      x: (e.clientX - rect.left) * (pageWidth  / rect.width),
      y: (e.clientY - rect.top)  * (pageHeight / rect.height)
    }
  }

  function hitTest(ann: Annotation, x: number, y: number): boolean {
    const margin = 8
    const bounds = getAnnotationBounds(ann)
    return (
      x >= bounds.x - margin &&
      x <= bounds.x + bounds.width + margin &&
      y >= bounds.y - margin &&
      y <= bounds.y + bounds.height + margin
    )
  }

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!activeFileId) return
    const pos = getPos(e)

    // Select tool
    if (activeTool === 'select') {
      const hit = [...pageAnnotations].reverse().find(a => hitTest(a, pos.x, pos.y))
      setSelectedId(hit?.id ?? null)
      return
    }

    // Eraser
    if (activeTool === 'eraser') {
      const hit = [...pageAnnotations].reverse().find(a => hitTest(a, pos.x, pos.y))
      if (hit) removeAnnotation(activeFileId, hit.id)
      return
    }

    setDrawing(true)
    setStartPos(pos)
    setCurrentPoints([[pos.x, pos.y]])
  }, [activeTool, activeFileId, pageAnnotations])

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!drawing) return
    const pos = getPos(e)
    setCurrentPoints(prev => [...prev, [pos.x, pos.y]])
  }, [drawing])

  const handleMouseUp = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!drawing || !activeFileId) return
    setDrawing(false)

    const pos = getPos(e)
    const dx = pos.x - startPos.x
    const dy = pos.y - startPos.y
    const id = crypto.randomUUID()

    switch (activeTool) {
      case 'draw':
        if (currentPoints.length > 2) {
          addAnnotation(activeFileId, {
            id, type: 'draw', pageIndex,
            x: Math.min(startPos.x, pos.x),
            y: Math.min(startPos.y, pos.y),
            width: Math.abs(dx), height: Math.abs(dy),
            points: currentPoints,
            color: drawColor,
            opacity: drawOpacity,
            strokeWidth
          })
        }
        break

      case 'highlight':
        addAnnotation(activeFileId, {
          id, type: 'highlight', pageIndex,
          x: Math.min(startPos.x, pos.x),
          y: Math.min(startPos.y, pos.y),
          width: Math.abs(dx) || 100,
          height: Math.abs(dy) || 18,
          color: highlightColor,
          opacity: 0.35
        })
        break

      case 'underline':
        addAnnotation(activeFileId, {
          id, type: 'underline', pageIndex,
          x: Math.min(startPos.x, pos.x),
          y: startPos.y,
          width: Math.abs(dx) || 100,
          height: 20,
          color: drawColor,
          opacity: drawOpacity
        })
        break

      case 'strikethrough':
        addAnnotation(activeFileId, {
          id, type: 'strikethrough', pageIndex,
          x: Math.min(startPos.x, pos.x),
          y: startPos.y,
          width: Math.abs(dx) || 100,
          height: 20,
          color: drawColor,
          opacity: drawOpacity
        })
        break

      case 'rectangle':
        addAnnotation(activeFileId, {
          id, type: 'rectangle', pageIndex,
          x: Math.min(startPos.x, pos.x),
          y: Math.min(startPos.y, pos.y),
          width: Math.abs(dx) || 80,
          height: Math.abs(dy) || 60,
          color: drawColor,
          opacity: drawOpacity,
          strokeWidth
        })
        break

      case 'circle':
        addAnnotation(activeFileId, {
          id, type: 'circle', pageIndex,
          x: Math.min(startPos.x, pos.x),
          y: Math.min(startPos.y, pos.y),
          width: Math.abs(dx) || 80,
          height: Math.abs(dy) || 60,
          color: drawColor,
          opacity: drawOpacity,
          strokeWidth
        })
        break

      case 'text':
        setEditingTextId(id)
        setEditingText('')
        addAnnotation(activeFileId, {
          id, type: 'text', pageIndex,
          x: startPos.x, y: startPos.y,
          width: 200, height: fontSize + 8,
          text: '', color: textColor,
          fontSize, fontFamily,
          opacity: 1
        })
        break

      case 'comment':
        addAnnotation(activeFileId, {
          id, type: 'comment', pageIndex,
          x: startPos.x, y: startPos.y,
          width: 20, height: 20,
          color: '#fbbf24', opacity: 1
        })
        break

      case 'stamp':
        addAnnotation(activeFileId, {
          id, type: 'stamp', pageIndex,
          x: startPos.x, y: startPos.y,
          width: 150, height: 50,
          text: 'APPROVED',
          color: drawColor,
          opacity: drawOpacity
        })
        break
    }

    setCurrentPoints([])
  }, [drawing, activeTool, activeFileId, startPos, currentPoints, pageIndex, drawColor, drawOpacity, strokeWidth, highlightColor, textColor, fontSize, fontFamily])

  const handleDoubleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const pos = getPos(e)
    const hit = [...pageAnnotations].reverse().find(a => a.type === 'text' && hitTest(a, pos.x, pos.y))
    if (hit && activeFileId) {
      setEditingTextId(hit.id)
      setEditingText(hit.text ?? '')
      setTimeout(() => editInputRef.current?.focus(), 50)
    }
  }, [pageAnnotations, activeFileId])

  const commitText = () => {
    if (!editingTextId || !activeFileId) return
    if (editingText.trim()) {
      updateAnnotation(activeFileId, editingTextId, { text: editingText })
    } else {
      removeAnnotation(activeFileId, editingTextId)
    }
    setEditingTextId(null)
    setEditingText('')
  }

  const editingAnn = pageAnnotations.find(a => a.id === editingTextId)

  const cursorMap: Record<ToolType, string> = {
    select: 'default',
    text: 'text',
    textEdit: 'text',
    highlight: 'crosshair',
    underline: 'crosshair',
    strikethrough: 'crosshair',
    draw: 'crosshair',
    rectangle: 'crosshair',
    circle: 'crosshair',
    arrow: 'crosshair',
    image: 'copy',
    stamp: 'copy',
    signature: 'crosshair',
    eraser: 'cell',
    comment: 'copy'
  }

  return (
    <div className="annotation-layer" style={{ width: pageWidth, height: pageHeight }}>
      <canvas
        ref={canvasRef}
        width={pageWidth}
        height={pageHeight}
        style={{
          width: pageWidth,
          height: pageHeight,
          cursor: cursorMap[activeTool],
          // TextEditOverlay sits above this canvas; let it handle pointer events
          pointerEvents: activeTool === 'textEdit' ? 'none' : 'auto'
        }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onDoubleClick={handleDoubleClick}
      />
      {editingTextId && editingAnn && (
        <textarea
          ref={editInputRef}
          autoFocus
          value={editingText}
          onChange={e => setEditingText(e.target.value)}
          onBlur={commitText}
          onKeyDown={e => { if (e.key === 'Escape') { setEditingTextId(null) } }}
          style={{
            position: 'absolute',
            left: editingAnn.x,
            top: editingAnn.y,
            fontSize: editingAnn.fontSize ?? 14,
            fontFamily: editingAnn.fontFamily ?? 'sans-serif',
            color: editingAnn.color ?? '#000',
            background: editingAnn.backgroundColor ?? 'rgba(255,255,255,0.9)',
            border: '1px solid #6366f1',
            borderRadius: 4,
            padding: 4,
            minWidth: editingAnn.width ?? 200,
            minHeight: editingAnn.height ?? 30,
            outline: 'none',
            resize: 'none',
            lineHeight: 1.4
          }}
          rows={3}
        />
      )}
    </div>
  )
}
