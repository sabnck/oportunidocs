/**
 * PDF operations using pdf-lib.
 * All operations preserve original PDF quality — no re-rendering or re-compression.
 */

import { PDFDocument, rgb, StandardFonts, degrees } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import * as PDFJS from 'pdfjs-dist'
import type { Annotation } from '../store/pdfStore'
import { extractFontsFromPDF } from './fontExtractor'
import { mapToStandardFont } from './textExtractor'
import { resolvePdfTextEditFrame } from './textLayoutEngine'
import { replaceTextInPage, detectFontEncoding, encodeTextHex, type ReplaceTarget } from './streamSurgeon'
import { chooseTextEditStrategy } from './exportStrategy'
import { fitTextToBox } from './textBoxFit'
import { reconstructBackgroundPatchCanvas } from './localReconstruction'

// ─── Color helper ──────────────────────────────────────────────────────────

function hexToRgb(hex: string) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  return result ? {
    r: parseInt(result[1], 16) / 255,
    g: parseInt(result[2], 16) / 255,
    b: parseInt(result[3], 16) / 255
  } : { r: 0, g: 0, b: 0 }
}


function splitTrackedGlyphs(text: string): string[] {
  return Array.from(text)
}

function normalizeTrackedLine(text: string, trackingMode?: 'normal' | 'spaced'): string {
  if (trackingMode !== 'spaced') return text
  return text.replace(/\s+/g, '')
}

function measureTrackedTextWidth(
  measureGlyph: (glyph: string) => number,
  text: string,
  letterSpacing: number,
  trackingMode?: 'normal' | 'spaced'
): number {
  if (trackingMode !== 'spaced') return measureGlyph(text)
  const glyphs = splitTrackedGlyphs(normalizeTrackedLine(text, trackingMode))
  if (glyphs.length === 0) return 0
  return glyphs.reduce((sum, glyph, index) => {
    const advance = measureGlyph(glyph)
    return sum + advance + (index < glyphs.length - 1 ? letterSpacing : 0)
  }, 0)
}

function drawTrackedCanvasText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  letterSpacing: number,
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
    if (index < glyphs.length - 1) cursorX += letterSpacing
  })
}

function resolveStandardFontConstant(name: string) {
  switch (name) {
    case 'Helvetica': return StandardFonts.Helvetica
    case 'Helvetica-Bold': return StandardFonts.HelveticaBold
    case 'Helvetica-Oblique': return StandardFonts.HelveticaOblique
    case 'Helvetica-BoldOblique': return StandardFonts.HelveticaBoldOblique
    case 'Times-Roman': return StandardFonts.TimesRoman
    case 'Times-Bold': return StandardFonts.TimesRomanBold
    case 'Times-Italic': return StandardFonts.TimesRomanItalic
    case 'Times-BoldItalic': return StandardFonts.TimesRomanBoldItalic
    case 'Courier': return StandardFonts.Courier
    case 'Courier-Bold': return StandardFonts.CourierBold
    case 'Courier-Oblique': return StandardFonts.CourierOblique
    case 'Courier-BoldOblique': return StandardFonts.CourierBoldOblique
    default: return StandardFonts.Helvetica
  }
}

// ─── Render-to-image font system ───────────────────────────────────────────

/**
 * LAYER 1 — Render text to a PNG image using the browser's canvas,
 * which already has the @font-face loaded from fontExtractor.
 *
 * This completely bypasses the subset-font problem: we render using the
 * browser font engine (exact same rendering path as the AnnotationCanvas
 * preview), then embed the resulting PNG into the PDF.
 *
 * Returns null if the font cannot be confirmed loaded (triggers Layer 3 warning).
 *
 * @param cssFamily   The CSS font-family string (e.g. `'UltraPDF_Calibri_F1', sans-serif`)
 * @param pdfFontSize Font size in PDF points
 * @param textColor   Hex color string (e.g. '#e8462a')
 * @param lines       Array of text lines
 * @param pdfLineHeightPt  Line height in PDF points
 */
async function renderTextToImage(
  cssFamily: string,
  pdfFontSize: number,
  textColor: string,
  lines: string[],
  pdfLineHeightPt: number,
  isBold   = false,
  isItalic = false,
  options?: {
    align?: 'left' | 'center' | 'right'
    boxWidthPt?: number
    boxHeightPt?: number
    insetLeftPt?: number
    insetRightPt?: number
    trackingMode?: 'normal' | 'spaced'
    letterSpacingEm?: number
    lockToBox?: boolean
  }
): Promise<{
  pngBytes: Uint8Array
  widthPt: number
  heightPt: number
  baselineOffsetPt: number   // distance from image top to the first baseline, in PDF pts
} | null> {
  const SCALE = 3  // render at 3× for crisp output (PDF viewer will scale back down)

  const renderFontSize   = pdfFontSize   * SCALE
  const renderLineHeight = pdfLineHeightPt * SCALE
  const letterSpacingPx = (options?.letterSpacingEm ?? 0) * renderFontSize

  // ── Ensure @font-face is loaded ──────────────────────────────────────────
  const primaryFamily = cssFamily.split(',')[0].trim().replace(/['"]/g, '')
  const weightSpec    = isBold   ? 'bold '   : ''
  const styleSpec     = isItalic ? 'italic ' : ''
  const fontSpec      = `${styleSpec}${weightSpec}${renderFontSize}px '${primaryFamily}'`
  const fontSpecFull  = `${styleSpec}${weightSpec}${renderFontSize}px '${primaryFamily}', sans-serif`

  try {
    const loaded = await document.fonts.load(fontSpec)
    if (loaded.length === 0) {
      console.warn(`[renderTextToImage] Font '${primaryFamily}' not loaded — rendering with browser fallback stack`)
    }
  } catch {
    console.warn(`[renderTextToImage] Font '${primaryFamily}' load check failed — rendering with browser fallback stack`)
  }

  // ── Measure text dimensions ──────────────────────────────────────────────
  const measureCanvas = document.createElement('canvas')
  const mCtx = measureCanvas.getContext('2d')!
  mCtx.font = fontSpecFull

  const maxWidthPx = options?.boxWidthPt ? Math.max(1, options.boxWidthPt * SCALE) : Number.POSITIVE_INFINITY
  const maxHeightPx = options?.boxHeightPt ? Math.max(1, options.boxHeightPt * SCALE) : Number.POSITIVE_INFINITY
  const fitted = fitTextToBox({
    lines,
    baseFontSize: renderFontSize,
    baseLineHeight: renderLineHeight,
    maxWidth: Number.isFinite(maxWidthPx)
      ? Math.max(1, maxWidthPx - ((options?.insetLeftPt ?? 0) + (options?.insetRightPt ?? 0)) * SCALE - 4)
      : Number.POSITIVE_INFINITY,
    maxHeight: Number.isFinite(maxHeightPx) ? Math.max(1, maxHeightPx - 4) : Number.POSITIVE_INFINITY,
    measureLine: (fontSize, _lineHeight, line) => {
      const letterSpacing = (options?.letterSpacingEm ?? 0) * fontSize
      mCtx.font = `${styleSpec}${weightSpec}${fontSize}px '${primaryFamily}', sans-serif`
      return measureTrackedTextWidth(
        glyph => mCtx.measureText(glyph).width,
        line,
        letterSpacing,
        options?.trackingMode
      )
    },
  })

  const fittedFontSize = fitted.fontSize
  const fittedLineHeight = fitted.lineHeight
  const fittedLetterSpacingPx = (options?.letterSpacingEm ?? 0) * fittedFontSize
  mCtx.font = `${styleSpec}${weightSpec}${fittedFontSize}px '${primaryFamily}', sans-serif`

  let maxAscent  = 0
  let maxDescent = 0
  let maxWidth   = 1
  for (const line of lines) {
    const m = mCtx.measureText(line)
    maxWidth = Math.max(
      maxWidth,
      measureTrackedTextWidth(
        glyph => mCtx.measureText(glyph).width,
        line,
        fittedLetterSpacingPx,
        options?.trackingMode
      )
    )
    maxAscent  = Math.max(maxAscent,  m.actualBoundingBoxAscent  ?? fittedFontSize * 0.8)
    maxDescent = Math.max(maxDescent, m.actualBoundingBoxDescent ?? fittedFontSize * 0.2)
  }

  // ── Render to canvas ─────────────────────────────────────────────────────
  const PAD        = 2                             // px padding around text
  const totalLines = lines.length
  const minBoxWidth = options?.boxWidthPt ? Math.ceil(options.boxWidthPt * SCALE) : 0
  const minBoxHeight = options?.boxHeightPt ? Math.ceil(options.boxHeightPt * SCALE) : 0
  const measuredW = Math.ceil(maxWidth) + PAD * 2
  const measuredH = Math.ceil(
    totalLines === 1
      ? maxAscent + maxDescent + PAD * 2
      : fittedLineHeight * (totalLines - 1) + maxAscent + maxDescent + PAD * 2
  )
  const canvasW = options?.lockToBox && minBoxWidth > 0 ? minBoxWidth : Math.max(measuredW, minBoxWidth)
  const canvasH = options?.lockToBox && minBoxHeight > 0 ? minBoxHeight : Math.max(measuredH, minBoxHeight)

  const canvas = document.createElement('canvas')
  canvas.width  = canvasW
  canvas.height = canvasH
  const ctx = canvas.getContext('2d')!

  ctx.clearRect(0, 0, canvasW, canvasH)
  ctx.font         = `${styleSpec}${weightSpec}${fittedFontSize}px '${primaryFamily}', sans-serif`
  ctx.fillStyle    = textColor
  ctx.textBaseline = 'alphabetic'
  ctx.textAlign    = options?.align === 'center'
    ? 'center'
    : options?.align === 'right'
      ? 'right'
      : 'left'

  ctx.save()
  ctx.beginPath()
  ctx.rect(0, 0, canvasW, canvasH)
  ctx.clip()

  lines.forEach((line, i) => {
    const x = ctx.textAlign === 'center'
      ? canvasW / 2
      : ctx.textAlign === 'right'
        ? canvasW - PAD - ((options?.insetRightPt ?? 0) * SCALE)
        : PAD + ((options?.insetLeftPt ?? 0) * SCALE)
    const drawX = ctx.textAlign === 'center'
      ? x - measureTrackedTextWidth(
          glyph => ctx.measureText(glyph).width,
          line,
          fittedLetterSpacingPx,
          options?.trackingMode
        ) / 2
      : ctx.textAlign === 'right'
        ? x - measureTrackedTextWidth(
            glyph => ctx.measureText(glyph).width,
            line,
            fittedLetterSpacingPx,
            options?.trackingMode
          )
        : x
    drawTrackedCanvasText(
      ctx,
      line,
      drawX,
      PAD + maxAscent + i * fittedLineHeight,
      fittedLetterSpacingPx,
      options?.trackingMode
    )
  })
  ctx.restore()

  // ── Convert canvas → PNG bytes ───────────────────────────────────────────
  const dataUrl = canvas.toDataURL('image/png')
  const base64  = dataUrl.split(',')[1]
  const binary  = atob(base64)
  const pngBytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) pngBytes[i] = binary.charCodeAt(i)

  return {
    pngBytes,
    widthPt:          canvasW / SCALE,
    heightPt:         canvasH / SCALE,
    baselineOffsetPt: (PAD + maxAscent) / SCALE,  // from image top to baseline
  }
}

// ─── Background color sampling ─────────────────────────────────────────────

// ─── Load PDF ──────────────────────────────────────────────────────────────

export async function loadPDF(data: Uint8Array) {
  const pdf = await PDFDocument.load(data, { ignoreEncryption: true })
  return pdf
}

// ─── Flatten annotations into PDF ─────────────────────────────────────────

export async function flattenAnnotations(
  originalData: Uint8Array,
  annotations: Annotation[],
  renderScale: number
): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(originalData)
  pdf.registerFontkit(fontkit)

  const helvetica     = await pdf.embedFont(StandardFonts.Helvetica)
  const helveticaBold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const standardFontCache = new Map<string, any>([
    [StandardFonts.Helvetica, helvetica],
    [StandardFonts.HelveticaBold, helveticaBold],
  ])

  // Pre-extract embedded font bytes for textEdit annotations that need them
  // Keyed by PDF font resource name (e.g. 'F1', 'TT2')
  let embeddedFontMap: Map<string, { bytes: Uint8Array }> | null = null
  const hasTextEdits = annotations.some(a => a.type === 'textEdit' && a.pdfFontRef)
  if (hasTextEdits) {
    try {
      const extracted = await extractFontsFromPDF(originalData)
      embeddedFontMap = new Map(
        Array.from(extracted.entries()).map(([k, v]) => [k, { bytes: v.bytes }])
      )
    } catch {
      // continue with standard font fallback
    }
  }

  // Cache embedded fonts that are already embedded in this pdf-lib document
  // to avoid re-embedding the same font bytes for every annotation
  const embeddedCache = new Map<string, any>()

  const pages = pdf.getPages()

  // PASS 1 is intentionally disabled for now.
  // Canva-style PDFs commonly place text inside Form XObjects / nested resources,
  // which makes page-level font detection and operator replacement unreliable.
  // A deterministic visual replacement is preferable to a partial stream edit.
  const replacedAnnotationIds = new Set<string>()

  const pagesToRender = Array.from(new Set(annotations.filter(a => a.type === 'textEdit').map(a => a.pageIndex)))
  const renderedPageCanvases = new Map<number, HTMLCanvasElement>()
  // Use a fixed high background render scale regardless of the current display zoom.
  // This ensures background patch coordinates (PDF pts × BG_SCALE = canvas px) are
  // stable even if the user zoomed in/out before saving.
  const BG_RENDER_SCALE = 3
  if (pagesToRender.length > 0) {
    try {
      const loadingTask = PDFJS.getDocument({
        data: originalData.slice(),
        disableAutoFetch: true,
        disableStream: false,
        isEvalSupported: false,
        useSystemFonts: true,
        fontExtraProperties: true,
      } as any)
      const pdfjsDoc = await loadingTask.promise

      for (const pageIndex of pagesToRender) {
        const pdfjsPage = await pdfjsDoc.getPage(pageIndex + 1)
        const viewport = pdfjsPage.getViewport({ scale: BG_RENDER_SCALE })
        const canvas = document.createElement('canvas')
        canvas.width = Math.ceil(viewport.width)
        canvas.height = Math.ceil(viewport.height)
        const ctx = canvas.getContext('2d', { alpha: false })!
        await pdfjsPage.render({ canvasContext: ctx as any, viewport }).promise
        renderedPageCanvases.set(pageIndex, canvas)
      }
    } catch (e) {
      console.warn('[flattenAnnotations] PDF.js page render cache failed:', e)
    }
  }

  for (const ann of annotations) {
    const page = pages[ann.pageIndex]
    if (!page) continue

    const { width: pageWidth, height: pageHeight } = page.getSize()
    const scaleX = pageWidth / (pageWidth * renderScale)
    const scaleY = pageHeight / (pageHeight * renderScale)

    // Convert from canvas coords to PDF coords (PDF origin is bottom-left)
    const pdfX = ann.x / renderScale
    const pdfY = pageHeight - (ann.y / renderScale) - ((ann.height ?? 20) / renderScale)

    const color = ann.color ? hexToRgb(ann.color) : { r: 0, g: 0, b: 0 }
    const opacity = ann.opacity ?? 1

    switch (ann.type) {
      case 'text': {
        const fontSize = (ann.fontSize ?? 14) / renderScale
        const lineHeight = fontSize * 1.2
        const lines = (ann.text ?? '').split('\n')
        if (ann.backgroundColor) {
          const bg = hexToRgb(ann.backgroundColor)
          page.drawRectangle({
            x: pdfX,
            y: pdfY,
            width: (ann.width ?? 100) / renderScale,
            height: (ann.height ?? Math.max(ann.fontSize ?? 14, lines.length * (ann.fontSize ?? 14) * 1.2)) / renderScale,
            color: rgb(bg.r, bg.g, bg.b),
            opacity: 1
          })
        }
        lines.forEach((line, i) => {
          page.drawText(line, {
            x: pdfX + (ann.backgroundColor ? 2 / renderScale : 0),
            y: pdfY + ((ann.height ?? 20) / renderScale) - fontSize - i * lineHeight + fontSize * 0.18,
            size: fontSize,
            font: helvetica,
            color: rgb(color.r, color.g, color.b),
            opacity
          })
        })
        break
      }

      case 'highlight': {
        const annColor = ann.color ? hexToRgb(ann.color) : { r: 0.99, g: 0.88, b: 0.27 }
        page.drawRectangle({
          x: pdfX,
          y: pdfY,
          width: (ann.width ?? 100) / renderScale,
          height: (ann.height ?? 20) / renderScale,
          color: rgb(annColor.r, annColor.g, annColor.b),
          opacity: 0.4
        })
        break
      }

      case 'underline':
        page.drawLine({
          start: { x: pdfX, y: pdfY },
          end: { x: pdfX + (ann.width ?? 100) / renderScale, y: pdfY },
          thickness: 1.5 / renderScale,
          color: rgb(color.r, color.g, color.b),
          opacity
        })
        break

      case 'strikethrough': {
        const midY = pdfY + (ann.height ?? 20) / renderScale / 2
        page.drawLine({
          start: { x: pdfX, y: midY },
          end: { x: pdfX + (ann.width ?? 100) / renderScale, y: midY },
          thickness: 1.5 / renderScale,
          color: rgb(color.r, color.g, color.b),
          opacity
        })
        break
      }

      case 'rectangle':
        page.drawRectangle({
          x: pdfX,
          y: pdfY,
          width: (ann.width ?? 100) / renderScale,
          height: (ann.height ?? 60) / renderScale,
          borderColor: rgb(color.r, color.g, color.b),
          borderWidth: (ann.strokeWidth ?? 2) / renderScale,
          opacity: 0,
          borderOpacity: opacity
        })
        break

      case 'circle':
        page.drawEllipse({
          x: pdfX + (ann.width ?? 100) / renderScale / 2,
          y: pdfY + (ann.height ?? 60) / renderScale / 2,
          xScale: (ann.width ?? 100) / renderScale / 2,
          yScale: (ann.height ?? 60) / renderScale / 2,
          borderColor: rgb(color.r, color.g, color.b),
          borderWidth: (ann.strokeWidth ?? 2) / renderScale,
          opacity: 0,
          borderOpacity: opacity
        })
        break

      case 'draw':
      case 'signature':
        if (ann.imageSrc) {
          try {
            const imageData = ann.imageSrc.startsWith('data:image/png')
              ? await pdf.embedPng(ann.imageSrc)
              : await pdf.embedJpg(ann.imageSrc)
            page.drawImage(imageData, {
              x: pdfX,
              y: pdfY,
              width: (ann.width ?? 200) / renderScale,
              height: (ann.height ?? 80) / renderScale,
              opacity
            })
          } catch {}
        }
        break

      case 'image':
        if (ann.imageSrc) {
          try {
            const imageData = ann.imageSrc.startsWith('data:image/png')
              ? await pdf.embedPng(ann.imageSrc)
              : await pdf.embedJpg(ann.imageSrc)
            page.drawImage(imageData, {
              x: pdfX,
              y: pdfY,
              width: (ann.width ?? 200) / renderScale,
              height: (ann.height ?? 150) / renderScale,
              opacity
            })
          } catch {}
        }
        break

      case 'stamp':
        page.drawRectangle({
          x: pdfX,
          y: pdfY,
          width: (ann.width ?? 150) / renderScale,
          height: (ann.height ?? 50) / renderScale,
          borderColor: rgb(color.r, color.g, color.b),
          borderWidth: 2 / renderScale,
          borderOpacity: opacity,
          opacity: 0
        })
        page.drawText(ann.text ?? 'APPROVED', {
          x: pdfX + 8 / renderScale,
          y: pdfY + (ann.height ?? 50) / renderScale / 2 - 6 / renderScale,
          size: 14 / renderScale,
          font: helveticaBold,
          color: rgb(color.r, color.g, color.b),
          opacity
        })
        break

      // ── textEdit ─────────────────────────────────────────────────────────
      //
      // PASS 1 (stream surgery) already replaced the text in the content
      // stream for most annotations — no further action needed for those.
      //
      // If PASS 1 failed (stream surgery couldn't locate the exact text run),
      // we fall back to a PNG overlay so the edit is still visible.
      //
      case 'textEdit': {
        // If stream surgery succeeded, nothing to do here.
        if (replacedAnnotationIds.has(ann.id)) break
        const newText = ann.text ?? ''
        if (!newText) break

        const lines = newText.split('\n')
        const hasContainer = ann.layoutMode === 'container' &&
          ann.containerPdfX !== undefined &&
          ann.containerPdfY !== undefined &&
          ann.containerPdfWidth !== undefined &&
          ann.containerPdfHeight !== undefined

        // ── Resolve PDF-space coordinates ──────────────────────────────────
        const frame = resolvePdfTextEditFrame(ann, pageHeight, renderScale)
        const coverX = frame.anchorX
        const coverY = frame.baselineY
        const pdfFontSize = frame.fontSize
        const pdfLineHeight = frame.lineHeight
        const freeCenterX = !hasContainer && ann.textAlign === 'center' && ann.pdfRawX !== undefined && ann.pdfRawWidth !== undefined
          ? ann.pdfRawX + ann.pdfRawWidth / 2
          : null

        const container = hasContainer
          ? {
              x: ann.containerPdfX!,
              y: ann.containerPdfY!,
              width: ann.containerPdfWidth!,
              height: ann.containerPdfHeight!,
              insetX: ann.contentInsetPdfX ?? 0,
              firstBaselineOffset: ann.firstBaselineOffsetPdf ?? Math.max(pdfFontSize, ann.containerPdfHeight! * 0.5),
            }
          : null
        const firstBaselineY = frame.container?.baselineY ?? (
          container
            ? container.y + container.height - container.firstBaselineOffset
            : coverY
        )

        const strategy = chooseTextEditStrategy(ann)
        const availableWidth = Math.max(4, frame.boxWidth - (container?.insetX ?? 0) * 2)
        const availableHeight = Math.max(4, frame.boxHeight)
        const cssFamily = ann.fontFamily ?? ''

        const measureCanvas = document.createElement('canvas')
        const measureCtx = measureCanvas.getContext('2d')!
        const weightSpec = ann.isBold ? 'bold ' : ''
        const styleSpec = ann.isItalic ? 'italic ' : ''
        const primaryFamily = cssFamily.split(',')[0].trim().replace(/['"]/g, '')
        const fitted = fitTextToBox({
          lines,
          baseFontSize: pdfFontSize,
          baseLineHeight: pdfLineHeight,
          maxWidth: availableWidth,
          maxHeight: availableHeight,
          measureLine: (fontSize, _lineHeight, line) => {
            const letterSpacing = (ann.letterSpacingEm ?? 0) * fontSize
            measureCtx.font = `${styleSpec}${weightSpec}${fontSize}px '${primaryFamily}', sans-serif`
            return measureTrackedTextWidth(
              glyph => measureCtx.measureText(glyph).width,
              line,
              letterSpacing,
              ann.trackingMode
            )
          },
        })
        const fittedFontSize = fitted.fontSize
        const fittedLineHeight = fitted.lineHeight

        // ── Resolve text color ─────────────────────────────────────────────
        const textHex      = ann.textColor ?? '#000000'
        const textRgb      = hexToRgb(textHex)
        const textColorPdf = rgb(textRgb.r, textRgb.g, textRgb.b)

        measureCtx.font = `${styleSpec}${weightSpec}${fittedFontSize}px '${primaryFamily}', sans-serif`
        const lineMetrics = lines.map(line => measureCtx.measureText(line || ' '))
        const maxAscent = Math.max(...lineMetrics.map(metric => metric.actualBoundingBoxAscent ?? fittedFontSize * 0.78), fittedFontSize * 0.78)
        const maxDescent = Math.max(...lineMetrics.map(metric => metric.actualBoundingBoxDescent ?? fittedFontSize * 0.22), fittedFontSize * 0.22)
        const totalHeight = fittedLineHeight * Math.max(lines.length - 1, 0) + maxAscent + maxDescent
        const topPad = Math.max(1.1, fittedFontSize * 0.18)
        const bottomPad = Math.max(0.9, fittedFontSize * 0.14)
        const sidePad = Math.max(1, fittedFontSize * 0.18)
        const coverRect = container
          ? {
              x: container.x,
              y: container.y,
              width: container.width,
              height: container.height,
            }
          : {
              x: freeCenterX !== null ? freeCenterX - (frame.boxWidth + sidePad * 2) / 2 : coverX - sidePad,
              // PDF coordinate space has Y increasing upward (origin = bottom-left).
              // The baseline is at coverY; descenders go below (lower Y), ascenders go above (higher Y).
              // So the BOTTOM of the cover rect = baseline − maxDescent − bottomPad,
              // and the TOP = y + height = baseline + maxAscent + topPad. ✓
              y: coverY - maxDescent - bottomPad,
              width: frame.boxWidth + sidePad * 2,
              height: Math.max(frame.boxHeight, totalHeight + topPad + bottomPad),
            }

        const bgFill = ann.bgColor
          ?? ann.sampledBgColor
          ?? (strategy === 'solidCoverRedraw' || strategy === 'containerRebuild' ? '#ffffff' : null)
        let restoredBackground = false
        const sourceCanvas = renderedPageCanvases.get(ann.pageIndex)
        if (sourceCanvas) {
          try {
            // Background canvas was rendered at BG_RENDER_SCALE — use the same to convert
            // PDF-space coords (pts) → canvas pixels for the patch extraction.
            const pageHeightPx = pageHeight * BG_RENDER_SCALE
            const patchX = coverRect.x * BG_RENDER_SCALE
            const patchY = pageHeightPx - (coverRect.y + coverRect.height) * BG_RENDER_SCALE
            const patchW = coverRect.width * BG_RENDER_SCALE
            const patchH = coverRect.height * BG_RENDER_SCALE
            const patchCanvas = reconstructBackgroundPatchCanvas(sourceCanvas, patchX, patchY, patchW, patchH, 1)
            if (patchCanvas) {
              const patchPng = await pdf.embedPng(patchCanvas.toDataURL('image/png'))
              page.drawImage(patchPng, {
                x: coverRect.x,
                y: coverRect.y,
                width: coverRect.width,
                height: coverRect.height,
                opacity: 1,
              })
              restoredBackground = true
            }
          } catch (e) {
            console.warn('[pdfOperations] background reconstruction patch failed:', e)
          }
        }
        if (!restoredBackground && bgFill && strategy !== 'nativePatch') {
          const fill = hexToRgb(bgFill)
          page.drawRectangle({
            x: coverRect.x,
            y: coverRect.y,
            width: coverRect.width,
            height: coverRect.height,
            color: rgb(fill.r, fill.g, fill.b),
            opacity: 1,
          })
        }

        // ══════════════════════════════════════════════════════════════════
        // LAYER 1: Render new text to PNG via browser canvas + @font-face.
        //   Stream surgery already removed the original text, so we place
        //   this PNG directly — the background is 100% clean underneath.
        // ══════════════════════════════════════════════════════════════════
        const imgResult = cssFamily
          ? await renderTextToImage(
              cssFamily, fittedFontSize, textHex, lines, fittedLineHeight,
              ann.isBold   ?? false,
              ann.isItalic ?? false,
              {
                align:           ann.textAlign ?? 'left',
                boxWidthPt:      frame.boxWidth,
                boxHeightPt:     frame.boxHeight,
                insetLeftPt:     container?.insetX,
                trackingMode:    ann.trackingMode,
                letterSpacingEm: ann.letterSpacingEm,
                lockToBox:       true,
              }
            )
          : null

        if (imgResult) {
          const imgBottomFromBaseline = imgResult.heightPt - imgResult.baselineOffsetPt
          const imgPdfY = firstBaselineY - imgBottomFromBaseline
          const imgPdfX = container
            ? container.x
            : freeCenterX !== null
              ? freeCenterX - imgResult.widthPt / 2
              : coverX

          try {
            const pngImage = await pdf.embedPng(imgResult.pngBytes)
            page.drawImage(pngImage, {
              x:       imgPdfX,
              y:       imgPdfY,
              width:   imgResult.widthPt,
              height:  imgResult.heightPt,
              opacity: ann.opacity ?? 1,
            })
          } catch (embedErr) {
            console.error('[pdfOperations] PNG embed failed:', embedErr)
          }
          break
        }

        // ══════════════════════════════════════════════════════════════════
        // LAYER 2: Fallback — draw text with original embedded font bytes.
        //   (Used when @font-face canvas render failed.)
        //   No background rectangle here either — stream surgery cleaned it.
        // ══════════════════════════════════════════════════════════════════
        let textFont: any = null

        if (ann.pdfFontRef && embeddedFontMap) {
          const cacheHit = embeddedCache.get(ann.pdfFontRef)
          if (cacheHit) {
            textFont = cacheHit
          } else {
            const fontEntry = embeddedFontMap.get(ann.pdfFontRef)
            if (fontEntry) {
              try {
                textFont = await pdf.embedFont(fontEntry.bytes)
                embeddedCache.set(ann.pdfFontRef, textFont)
              } catch {
                textFont = null
              }
            }
          }
        }

        if (!textFont) {
          const standardFontName = mapToStandardFont(
            ann.pdfBaseFontName ?? ann.fontFamily ?? ann.pdfFontRef ?? ''
          )
          const cachedStandard = standardFontCache.get(standardFontName)
          if (cachedStandard) {
            textFont = cachedStandard
          } else {
            try {
              textFont = await pdf.embedFont(resolveStandardFontConstant(standardFontName))
            } catch {
              textFont = null
            }
            if (textFont) standardFontCache.set(standardFontName, textFont)
          }
        }

        if (textFont) {
          const drawFontSize = Math.max(fittedFontSize, 4)
          const drawLineHeight = fittedLineHeight
          lines.forEach((line, i) => {
            const lineY = firstBaselineY - i * drawLineHeight
            let lineX = coverX
            const trackedWidth = measureTrackedTextWidth(
              glyph => textFont.widthOfTextAtSize(glyph, drawFontSize),
              line,
              (ann.letterSpacingEm ?? 0) * drawFontSize,
              ann.trackingMode
            )
            if (container) {
              if (ann.textAlign === 'center') {
                lineX = container.x + (container.width - trackedWidth) / 2
              } else if (ann.textAlign === 'right') {
                lineX = container.x + container.width - trackedWidth - container.insetX
              } else {
                lineX = container.x + container.insetX
              }
            } else if (freeCenterX !== null) {
              lineX = freeCenterX - trackedWidth / 2
            }

            if (ann.trackingMode === 'spaced' && (ann.letterSpacingEm ?? 0) > 0) {
              let cursorX = lineX
              const glyphs = splitTrackedGlyphs(normalizeTrackedLine(line, ann.trackingMode))
              glyphs.forEach((glyph, gi) => {
                page.drawText(glyph, {
                  x: cursorX, y: lineY,
                  size: drawFontSize,
                  font: textFont, color: textColorPdf, opacity: ann.opacity ?? 1,
                })
                cursorX += textFont.widthOfTextAtSize(glyph, drawFontSize)
                if (gi < glyphs.length - 1) cursorX += (ann.letterSpacingEm ?? 0) * drawFontSize
              })
            } else {
              page.drawText(line, {
                x: lineX, y: lineY,
                size: drawFontSize,
                font: textFont, color: textColorPdf, opacity: ann.opacity ?? 1,
              })
            }
          })
          break
        }

        // ══════════════════════════════════════════════════════════════════
        // LAYER 3: Font unavailable — log warning only, nothing drawn
        // ══════════════════════════════════════════════════════════════════
        console.warn(
          `[pdfOperations] LAYER 3: No font available for annotation ${ann.id} — ` +
          `'${ann.fontFamily ?? ann.pdfFontRef}'. ` +
          `Text "${newText.slice(0, 40)}" will NOT appear in the saved PDF.`
        )
        break
      }
    }
  }

  // Set metadata
  pdf.setCreator('OportuniDocs')
  pdf.setProducer('OportuniDocs')

  return pdf.save()
}

// ─── Merge PDFs ───────────────────────────────────────────────────────────

export async function mergePDFs(documents: Uint8Array[]): Promise<Uint8Array> {
  const merged = await PDFDocument.create()
  for (const data of documents) {
    const pdf = await PDFDocument.load(data)
    const pages = await merged.copyPages(pdf, pdf.getPageIndices())
    pages.forEach(p => merged.addPage(p))
  }
  return merged.save()
}

// ─── Split PDF ────────────────────────────────────────────────────────────

export async function splitPDF(
  data: Uint8Array,
  ranges: Array<{ from: number; to: number }>
): Promise<Uint8Array[]> {
  const source = await PDFDocument.load(data)
  const results: Uint8Array[] = []

  for (const range of ranges) {
    const doc = await PDFDocument.create()
    const indices = Array.from(
      { length: range.to - range.from + 1 },
      (_, i) => range.from + i - 1
    )
    const pages = await doc.copyPages(source, indices)
    pages.forEach(p => doc.addPage(p))
    results.push(await doc.save())
  }

  return results
}

// ─── Reorder pages ────────────────────────────────────────────────────────

export async function reorderPages(data: Uint8Array, order: number[]): Promise<Uint8Array> {
  const source = await PDFDocument.load(data)
  const doc = await PDFDocument.create()
  const pages = await doc.copyPages(source, order)
  pages.forEach(p => doc.addPage(p))
  return doc.save()
}

// ─── Rotate pages ─────────────────────────────────────────────────────────

export async function rotatePages(
  data: Uint8Array,
  pageIndices: number[],
  angleDeg: number
): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(data)
  const pages = pdf.getPages()
  for (const idx of pageIndices) {
    if (pages[idx]) {
      const current = pages[idx].getRotation().angle
      pages[idx].setRotation(degrees((current + angleDeg) % 360))
    }
  }
  return pdf.save()
}

// ─── Delete pages ─────────────────────────────────────────────────────────

export async function deletePages(data: Uint8Array, pageIndices: number[]): Promise<Uint8Array> {
  const source = await PDFDocument.load(data)
  const total = source.getPageCount()
  const keep = Array.from({ length: total }, (_, i) => i).filter(i => !pageIndices.includes(i))
  const doc = await PDFDocument.create()
  const pages = await doc.copyPages(source, keep)
  pages.forEach(p => doc.addPage(p))
  return doc.save()
}

// ─── Duplicate page ───────────────────────────────────────────────────────

export async function duplicatePage(data: Uint8Array, pageIndex: number): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(data)
  const [page] = await pdf.copyPages(pdf, [pageIndex])
  pdf.insertPage(pageIndex + 1, page)
  return pdf.save()
}

// ─── Extract text (basic) ─────────────────────────────────────────────────

export async function extractText(data: Uint8Array): Promise<string> {
  // pdf-lib doesn't have text extraction; this is a placeholder.
  // For production, use pdf.js text layer or a server-side tool.
  return '[Text extraction requires the OCR module. Enable it in Settings.]'
}

// ─── Add watermark ────────────────────────────────────────────────────────

export async function addWatermark(
  data: Uint8Array,
  text: string,
  options?: { color?: string; opacity?: number; angle?: number }
): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(data)
  const font = await pdf.embedFont(StandardFonts.HelveticaBold)
  const color = options?.color ? hexToRgb(options.color) : { r: 0.7, g: 0.7, b: 0.7 }
  const opacity = options?.opacity ?? 0.3
  const angle = options?.angle ?? 45

  for (const page of pdf.getPages()) {
    const { width, height } = page.getSize()
    page.drawText(text, {
      x: width / 2 - (text.length * 20) / 2,
      y: height / 2,
      size: 60,
      font,
      color: rgb(color.r, color.g, color.b),
      opacity,
      rotate: degrees(angle)
    })
  }

  return pdf.save()
}

// ─── Set metadata ─────────────────────────────────────────────────────────

export async function setMetadata(
  data: Uint8Array,
  meta: {
    title?: string
    author?: string
    subject?: string
    keywords?: string[]
    creator?: string
    producer?: string
  }
): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(data)
  if (meta.title !== undefined) pdf.setTitle(meta.title)
  if (meta.author !== undefined) pdf.setAuthor(meta.author)
  if (meta.subject !== undefined) pdf.setSubject(meta.subject)
  if (meta.keywords !== undefined) pdf.setKeywords(meta.keywords)
  pdf.setCreator(meta.creator?.trim() || 'OportuniDocs')
  pdf.setProducer(meta.producer?.trim() || 'OportuniDocs')
  return pdf.save()
}

export async function getMetadata(data: Uint8Array) {
  const pdf = await PDFDocument.load(data)
  return {
    title: pdf.getTitle() ?? '',
    author: pdf.getAuthor() ?? '',
    subject: pdf.getSubject() ?? '',
    keywords: pdf.getKeywords() ?? '',
    creator: pdf.getCreator() ?? '',
    producer: pdf.getProducer() ?? '',
    pageCount: pdf.getPageCount()
  }
}
