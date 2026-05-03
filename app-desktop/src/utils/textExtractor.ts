/**
 * textExtractor.ts
 * Extracts text items from a PDF page using PDF.js,
 * returning both viewport coordinates (for UI display) and
 * raw PDF-space coordinates (for accurate pdf-lib operations).
 *
 * Now also resolves:
 *   - cssFontFamily  — @font-face family registered by fontExtractor (or generic fallback)
 *   - color          — fill color active when the text was drawn (from operatorParser)
 *   - vpFontSize     — CSS px font size at the given zoom (for pixel-perfect canvas sync)
 *   - vpBaselineY    — Y of the text baseline in viewport coords (for alphabetic placement)
 */

import * as PDFJS from 'pdfjs-dist'
import type { ExtractedFont } from './fontExtractor'
import { isBoldFont, isItalicFont } from './fontExtractor'
import { resolvePDFJSFont } from './pdfJsFontResolver'
import {
  extractTextColors,
  matchColorToItem,
  extractBackgroundRects,
  matchBgColorToItem,
  matchBgRectToItem,
  type BackgroundRect,
} from './operatorParser'

/** Minimal shape we need from a PDF.js text item (avoids the missing TextItem export) */
interface PDFTextItem {
  str: string
  transform: number[]   // [a, b, c, d, e, f] — text matrix
  width: number         // advance width in PDF user-space units
  fontName: string      // PDF.js internal font id (e.g. 'g_d0_f1')
  [key: string]: unknown
}

// ─── Types ─────────────────────────────────────────────────────────────────

export interface ExtractedTextItem {
  str: string

  // Viewport coordinates (CSS pixels at the given zoom, top-left origin)
  vpX: number
  vpY: number
  vpWidth: number
  vpHeight: number

  // Baseline Y in viewport coords — use with ctx.textBaseline = 'alphabetic'
  vpBaselineY: number

  // CSS px font size at the given zoom — use directly in ctx.font
  vpFontSize: number

  // Raw PDF user-space coordinates (scale=1, bottom-left origin)
  pdfX: number
  pdfY: number
  pdfWidth: number
  pdfFontSize: number

  /** Internal PDF.js font id (e.g. 'g_d0_f2') */
  fontName: string

  /** Human-readable font name when PDF.js exposes it */
  fontDisplayName: string

  /** Clean PDF base name without subset prefix/style cleanup */
  pdfBaseFontName?: string

  /** CSS font-family string to apply in the edit input (extracted or fallback) */
  cssFontFamily: string

  /** Hex fill color in effect when this text was drawn (e.g. '#1a1a1a') */
  color: string

  /** Exact background fill color of the rect that covers this text in the PDF.
   *  Extracted directly from the PDF content stream (not from rendered pixels).
   *  null when no explicit rect was found (e.g. image-backed backgrounds). */
  bgColor: string | null

  /** Exact background rect that contains this item when one exists. */
  bgRect: BackgroundRect | null
  bgRectKey: string | null

  /** Text layout mode: free text on page or text constrained by a box/card. */
  layoutMode: 'free' | 'container'
  textAlign: 'left' | 'center' | 'right'
  containerPdfX?: number
  containerPdfY?: number
  containerPdfWidth?: number
  containerPdfHeight?: number
  contentInsetPdfX?: number
  firstBaselineOffsetPdf?: number

  /** True when the font's baseName indicates a bold variant */
  isBold: boolean
  /** True when the font's baseName indicates an italic/oblique variant */
  isItalic: boolean
  pdfLineHeight?: number
  lineHeightVp?: number
}

// ─── Extraction ────────────────────────────────────────────────────────────

/**
 * Extract all text items on a page with full font + color metadata.
 *
 * @param fontMap  Optional map from fontExtractor.extractFontsFromPDF —
 *                 if provided, cssFontFamily is resolved from the embedded font.
 */
export async function extractPageTextItems(
  pdfDoc: PDFJS.PDFDocumentProxy,
  pageIndex: number,
  zoom: number,
  fontMap?: Map<string, ExtractedFont>
): Promise<ExtractedTextItem[]> {
  try {
    const page = await pdfDoc.getPage(pageIndex + 1)
    const viewport = page.getViewport({ scale: zoom })
    const textContent = await page.getTextContent()

    // Extract color hints AND background rects in parallel
    const [colorHints, bgRects] = await Promise.all([
      extractTextColors(page),
      extractBackgroundRects(page),
    ])

    const items: ExtractedTextItem[] = []
    const resolvedFonts = new Map<string, Awaited<ReturnType<typeof resolvePDFJSFont>> | null>()

    for (const rawItem of textContent.items) {
      if (!('str' in rawItem)) continue
      const item = rawItem as unknown as PDFTextItem

      const text = item.str
      if (!text || !text.trim()) continue

      const [a, b, c, d, e, f] = item.transform

      // Font size in PDF user-space units
      const pdfFontSize = Math.sqrt(d * d + b * b)
      if (pdfFontSize < 0.5) continue

      const pdfX = e
      const pdfY = f
      const pdfWidth = item.width > 0 ? item.width : text.length * pdfFontSize * 0.5

      // Convert PDF-space baseline + cap-top to viewport space
      const [vpBaseX, vpBaseY] = viewport.convertToViewportPoint(pdfX, pdfY)
      const [vpTopX,  vpTopY ] = viewport.convertToViewportPoint(pdfX, pdfY + pdfFontSize)
      const [vpRightX        ] = viewport.convertToViewportPoint(pdfX + pdfWidth, pdfY)

      const vpX     = Math.min(vpBaseX, vpTopX, vpRightX)
      const vpYTop  = Math.min(vpBaseY, vpTopY) - 1
      const vpWidth = Math.abs(vpRightX - vpBaseX)
      const vpHeight = Math.abs(vpBaseY - vpTopY) + Math.abs(vpBaseY - vpTopY) * 0.2 + 2

      // vpFontSize = font size in CSS px at this zoom level
      const vpFontSize = Math.abs(vpBaseY - vpTopY)

      // vpBaselineY = Y of the text baseline in viewport coords (for ctx.textBaseline='alphabetic')
      const vpBaselineY = Math.max(vpBaseY, vpTopY)  // larger Y = lower on screen = baseline

      // Font resolution
      const pdfFontName = item.fontName || ''
      let pdfJsFont = resolvedFonts.get(pdfFontName)
      if (pdfJsFont === undefined) {
        pdfJsFont = await resolvePDFJSFont(page as any, pdfFontName)
        resolvedFonts.set(pdfFontName, pdfJsFont)
      }

      const extractedFont = fontMap?.get(pdfFontName)
      const cssFontFamily = pdfJsFont
        ? pdfJsFont.cssFontFamily
        : extractedFont
          ? `'${extractedFont.cssFamily}', ${genericFallback(extractedFont.baseName)}`
          : genericFallbackFromPdfName(pdfFontName)
      const fontDisplayName = pdfJsFont?.displayName || extractedFont?.baseName || pdfFontName
      const pdfBaseFontName = pdfJsFont?.baseName || extractedFont?.baseName || undefined

      // Bold / italic detection — from extracted font metadata or PDF font name heuristic
      const isBold   = pdfJsFont ? pdfJsFont.isBold : extractedFont ? extractedFont.isBold : isBoldFont(pdfFontName)
      const isItalic = pdfJsFont ? pdfJsFont.isItalic : extractedFont ? extractedFont.isItalic : isItalicFont(pdfFontName)

      // Color resolution
      const color   = matchColorToItem(colorHints, pdfX, pdfY)
      const bgColor = matchBgColorToItem(bgRects,  pdfX, pdfY, pdfWidth, pdfFontSize)
      const bgRect  = matchBgRectToItem(bgRects, pdfX, pdfY, pdfWidth, pdfFontSize)
      const containerLayout = inferContainerLayout(bgRect, pdfX, pdfY, pdfWidth, pdfFontSize, color)

      items.push({
        str: text,
        vpX,
        vpY: vpYTop,
        vpWidth: Math.max(vpWidth, 4),
        vpHeight: Math.max(vpHeight, pdfFontSize * zoom * 0.5),
        vpBaselineY,
        vpFontSize: Math.max(vpFontSize, 4),
        pdfX,
        pdfY,
        pdfWidth,
        pdfFontSize,
        fontName: pdfFontName,
        fontDisplayName,
        pdfBaseFontName,
        cssFontFamily,
        color,
        bgColor,
        bgRect,
        bgRectKey: bgRect
          ? `${roundRect(bgRect.x)}:${roundRect(bgRect.y)}:${roundRect(bgRect.width)}:${roundRect(bgRect.height)}:${bgRect.color}`
          : null,
        layoutMode: containerLayout?.layoutMode ?? 'free',
        textAlign: containerLayout?.textAlign ?? 'left',
        containerPdfX: containerLayout?.containerPdfX,
        containerPdfY: containerLayout?.containerPdfY,
        containerPdfWidth: containerLayout?.containerPdfWidth,
        containerPdfHeight: containerLayout?.containerPdfHeight,
        contentInsetPdfX: containerLayout?.contentInsetPdfX,
        firstBaselineOffsetPdf: containerLayout?.firstBaselineOffsetPdf,
        isBold,
        isItalic,
        pdfLineHeight: pdfFontSize * 1.2,
        lineHeightVp: Math.max(vpFontSize * 1.2, vpFontSize + 2),
      })
    }

    return items
  } catch (err) {
    console.error('[textExtractor] Failed to extract text items:', err)
    return []
  }
}

// ─── Paragraph grouping ─────────────────────────────────────────────────────

/**
 * Phase 1 of paragraph grouping: merge items on the SAME visual line.
 *
 * PDF.js often splits letter-spaced or tracked text into many tiny items
 * (one per character or per glyph group) that all share the same Y coordinate.
 * This function fuses horizontally adjacent items that share font + color into
 * a single item, so the downstream paragraph grouper sees whole lines rather
 * than individual letters.
 *
 * Merging criteria (all must be true):
 *  - Y ranges overlap (items on the same baseline band)
 *  - Same fontName and color
 *  - Similar font size (within 15%)
 *  - Horizontal gap between right edge of previous and left edge of current
 *    is within [-4px, 2× font-size] — allows for small overlaps and tracking
 */
function mergeInlineItems(items: ExtractedTextItem[]): ExtractedTextItem[] {
  if (items.length === 0) return []

  // Sort top-to-bottom, then left-to-right within each line
  const sorted = [...items].sort((a, b) => {
    const yOverlap = a.vpY < b.vpY + b.vpHeight && b.vpY < a.vpY + a.vpHeight
    if (yOverlap) return a.vpX - b.vpX
    return a.vpY - b.vpY
  })

  const result: ExtractedTextItem[] = []

  for (const item of sorted) {
    const prev = result.length > 0 ? result[result.length - 1] : null

    if (!prev) {
      result.push({ ...item })
      continue
    }

    // Same-line check: Y midpoints must be within 40% of the font height.
    // Using midpoints (instead of Y-range overlap) prevents merging items on
    // adjacent lines when leading is tight and vpHeight has the 20% padding.
    const midPrev = prev.vpY + prev.vpHeight / 2
    const midItem = item.vpY + item.vpHeight / 2
    const lineOverlap = Math.abs(midPrev - midItem) <
                        Math.max(prev.vpFontSize, item.vpFontSize) * 0.4
    if (!lineOverlap) { result.push({ ...item }); continue }

    // Same font and color
    if (
      item.fontName !== prev.fontName ||
      item.color !== prev.color ||
      item.bgRectKey !== prev.bgRectKey ||
      item.textAlign !== prev.textAlign ||
      item.layoutMode !== prev.layoutMode
    ) {
      result.push({ ...item }); continue
    }

    // Similar font size (within 15%)
    const sizeSimilar = Math.abs(item.vpFontSize - prev.vpFontSize) /
                        Math.max(prev.vpFontSize, 1) < 0.15
    if (!sizeSimilar) { result.push({ ...item }); continue }

    // Horizontal gap must be reasonable (allows tracking/letter-spacing up to 2em)
    const prevRight = prev.vpX + prev.vpWidth
    const gap = item.vpX - prevRight
    const maxGap = prev.vpFontSize * 2.0

    if (gap >= -4 && gap <= maxGap) {
      // Fuse into previous item
      const needsSpace = gap > prev.vpFontSize * 0.2
      prev.str        = prev.str + (needsSpace ? ' ' : '') + item.str
      prev.vpWidth    = item.vpX + item.vpWidth - prev.vpX
      prev.vpHeight   = Math.max(prev.vpHeight, item.vpHeight)
      prev.vpFontSize = Math.max(prev.vpFontSize, item.vpFontSize)
      prev.vpBaselineY = Math.max(prev.vpBaselineY, item.vpBaselineY)
      prev.pdfWidth   = prev.pdfWidth + item.pdfWidth
      prev.lineHeightVp = Math.max(prev.lineHeightVp ?? 0, item.lineHeightVp ?? 0, prev.vpFontSize * 1.2)
      prev.pdfLineHeight = Math.max(prev.pdfLineHeight ?? 0, item.pdfLineHeight ?? 0, prev.pdfFontSize * 1.2)
    } else {
      result.push({ ...item })
    }
  }

  return result
}

/**
 * Groups consecutive text items that belong to the same paragraph into a
 * single ExtractedTextItem.  Items are merged when they share the same font,
 * the same color, and their vertical gap matches the expected line height
 * (between 0.3× and 1.6× the font size).
 *
 * Before vertical grouping, runs mergeInlineItems() to fuse letter-spaced
 * text on the same line into whole-line items.
 *
 * The merged item's `str` uses '\n' as the line separator so downstream
 * editors can split lines correctly.
 */
export function groupTextItemsIntoParagraphs(
  items: ExtractedTextItem[]
): ExtractedTextItem[] {
  if (items.length === 0) return []

  // Phase 1: merge same-line items (letter-spacing / tracked text fix).
  //
  // We intentionally stop here for editing. Vertical paragraph grouping was
  // causing design-heavy PDFs (CV templates, multi-column layouts, Canva
  // exports) to merge unrelated lines into one giant editable block.
  // Keeping edits line-based is far more predictable and avoids accidental
  // blank/oversized selection boxes like the regression the user reported.
  const inlineMerged = mergeInlineItems(items)
  const grouped = groupContainerLines(inlineMerged)
  return grouped
}

// ─── Hit testing ───────────────────────────────────────────────────────────

export function findTextItemAtPoint(
  items: ExtractedTextItem[],
  clickX: number,
  clickY: number,
  tolerance = 5
): ExtractedTextItem | null {
  const plausibleItems = items.filter(item => {
    // Ignore suspiciously large hitboxes. These usually come from decorative
    // template layers or malformed text boxes and are the main source of the
    // “giant empty editor” regression seen in some Canva/CV PDFs.
    if (!item.str?.trim()) return false
    if (item.vpWidth > 420) return false
    if (item.vpHeight > 80) return false
    return true
  })

  // 1. Exact hit (with tolerance)
  const exactHits = plausibleItems.filter(item =>
    clickX >= item.vpX - tolerance &&
    clickX <= item.vpX + item.vpWidth + tolerance &&
    clickY >= item.vpY - tolerance &&
    clickY <= item.vpY + item.vpHeight + tolerance
  )

  if (exactHits.length > 0) {
    return [...exactHits].sort((a, b) => {
      const areaA = a.vpWidth * a.vpHeight
      const areaB = b.vpWidth * b.vpHeight
      if (Math.abs(areaA - areaB) > 1) return areaA - areaB

      const centerDistA = Math.hypot(
        clickX - (a.vpX + a.vpWidth / 2),
        clickY - (a.vpY + a.vpHeight / 2)
      )
      const centerDistB = Math.hypot(
        clickX - (b.vpX + b.vpWidth / 2),
        clickY - (b.vpY + b.vpHeight / 2)
      )
      return centerDistA - centerDistB
    })[0]
  }

  // 2. Nearest plausible item within a tight radius.
  // Keeping this conservative avoids jumping to unrelated decorative text
  // boxes when the user clicks near dense layouts.
  let closest: ExtractedTextItem | null = null
  let minDist = 28

  for (const item of plausibleItems) {
    const cx = item.vpX + item.vpWidth / 2
    const cy = item.vpY + item.vpHeight / 2
    const dist = Math.hypot(clickX - cx, clickY - cy)
    if (dist < minDist) {
      minDist = dist
      closest = item
    }
  }

  return closest
}

// ─── Font mapping ──────────────────────────────────────────────────────────

/**
 * Maps an internal PDF font name to the closest pdf-lib Standard Font name.
 * Used as a fallback when no embedded bytes are available.
 */
export function mapToStandardFont(fontName: string): string {
  const lower = fontName.toLowerCase()

  if (
    (lower.includes('bold') || lower.includes('heavy') || lower.includes('black')) &&
    (lower.includes('italic') || lower.includes('oblique'))
  ) return 'Helvetica-BoldOblique'

  if (lower.includes('bold') || lower.includes('heavy') || lower.includes('black')) {
    if (lower.includes('times') || lower.includes('roman')) return 'Times-Bold'
    if (lower.includes('courier'))                          return 'Courier-Bold'
    return 'Helvetica-Bold'
  }

  if (lower.includes('italic') || lower.includes('oblique')) {
    if (lower.includes('times') || lower.includes('roman')) return 'Times-Italic'
    if (lower.includes('courier'))                          return 'Courier-Oblique'
    return 'Helvetica-Oblique'
  }

  if (lower.includes('courier') || lower.includes('mono') || lower.includes('typewriter')) {
    return 'Courier'
  }

  if (lower.includes('times') || lower.includes('roman') ||
      lower.includes('palatin') || lower.includes('garamond')) {
    return 'Times-Roman'
  }

  return 'Helvetica'
}

// ─── Internal helpers ──────────────────────────────────────────────────────

/** Given a clean PostScript base name, pick a CSS generic family stack */
function genericFallback(baseName: string): string {
  const l = baseName.toLowerCase()
  if (l.includes('courier') || l.includes('mono') || l.includes('code')) return 'monospace'
  if (l.includes('times') || l.includes('roman') || l.includes('garamond') ||
      l.includes('palatin') || l.includes('georgia') || l.includes('serif')) return 'serif'
  return 'sans-serif'
}

/** Heuristic generic fallback from an opaque PDF font resource name */
function genericFallbackFromPdfName(pdfName: string): string {
  const l = pdfName.toLowerCase()
  if (l.includes('courier') || l.includes('cour') || l.includes('mono')) return 'monospace'
  if (l.includes('times') || l.includes('roman') || l.includes('serif')) return 'serif'
  return 'sans-serif'
}

function roundRect(v: number): string {
  return Math.round(v * 100) / 100 + ''
}

function isNearWhite(hex: string | null | undefined): boolean {
  const clean = String(hex || '').replace('#', '').trim()
  if (!/^[\da-fA-F]{6}$/.test(clean)) return false
  const r = parseInt(clean.slice(0, 2), 16)
  const g = parseInt(clean.slice(2, 4), 16)
  const b = parseInt(clean.slice(4, 6), 16)
  return r > 236 && g > 236 && b > 236
}

function inferContainerLayout(
  bgRect: BackgroundRect | null,
  pdfX: number,
  pdfY: number,
  pdfWidth: number,
  pdfFontSize: number,
  color: string
) {
  if (!bgRect) return null
  if (isNearWhite(bgRect.color)) return null
  if (bgRect.width < pdfWidth * 1.08) return null
  if (bgRect.height > pdfFontSize * 4.5) return null
  if (bgRect.height < pdfFontSize * 0.9) return null

  const rectCenter = bgRect.x + bgRect.width / 2
  const itemCenter = pdfX + pdfWidth / 2
  const centered = Math.abs(rectCenter - itemCenter) <= Math.max(pdfFontSize * 0.8, bgRect.width * 0.08)

  return {
    layoutMode: 'container' as const,
    textAlign: centered ? ('center' as const) : ('left' as const),
    containerPdfX: bgRect.x,
    containerPdfY: bgRect.y,
    containerPdfWidth: bgRect.width,
    containerPdfHeight: bgRect.height,
    contentInsetPdfX: Math.max(0, pdfX - bgRect.x),
    firstBaselineOffsetPdf: (bgRect.y + bgRect.height) - pdfY,
  }
}

function groupContainerLines(items: ExtractedTextItem[]): ExtractedTextItem[] {
  if (items.length === 0) return items

  const sorted = [...items].sort((a, b) => {
    if (Math.abs(a.vpY - b.vpY) < 1) return a.vpX - b.vpX
    return a.vpY - b.vpY
  })

  const result: ExtractedTextItem[] = []

  for (const item of sorted) {
    const prev = result[result.length - 1]
    if (
      prev &&
      prev.layoutMode === 'container' &&
      item.layoutMode === 'container' &&
      prev.bgRectKey &&
      prev.bgRectKey === item.bgRectKey &&
      prev.fontName === item.fontName &&
      prev.color === item.color &&
      prev.textAlign === item.textAlign
    ) {
      const gap = prev.vpY + prev.vpHeight <= item.vpY
        ? item.vpY - (prev.vpY + prev.vpHeight)
        : Math.abs(item.vpBaselineY - prev.vpBaselineY) - prev.vpFontSize
      const lineGapLimit = Math.max(prev.vpFontSize, item.vpFontSize) * 1.4
      if (gap <= lineGapLimit) {
        const prevRight = Math.max(prev.vpX + prev.vpWidth, item.vpX + item.vpWidth)
        const prevBottom = Math.max(prev.vpY + prev.vpHeight, item.vpY + item.vpHeight)
        const existingLines = (prev.str.match(/\n/g)?.length ?? 0) + 1
        const gapCount = Math.max(0, existingLines - 1)
        const vpGap = Math.abs(item.vpBaselineY - prev.vpBaselineY)
        const pdfGap = Math.abs(prev.pdfY - item.pdfY)

        prev.str = `${prev.str}\n${item.str}`
        prev.vpX = Math.min(prev.vpX, item.vpX)
        prev.vpY = Math.min(prev.vpY, item.vpY)
        prev.vpWidth = Math.max(4, prevRight - prev.vpX)
        prev.vpHeight = Math.max(4, prevBottom - prev.vpY)
        prev.pdfX = Math.min(prev.pdfX, item.pdfX)
        prev.pdfWidth = Math.max(prev.pdfWidth, item.pdfWidth)
        prev.vpFontSize = Math.max(prev.vpFontSize, item.vpFontSize)
        prev.vpBaselineY = Math.min(prev.vpBaselineY, item.vpBaselineY)
        prev.pdfY = Math.max(prev.pdfY, item.pdfY)
        prev.lineHeightVp = gapCount === 0
          ? vpGap
          : (((prev.lineHeightVp ?? vpGap) * gapCount) + vpGap) / (gapCount + 1)
        prev.pdfLineHeight = gapCount === 0
          ? pdfGap
          : (((prev.pdfLineHeight ?? pdfGap) * gapCount) + pdfGap) / (gapCount + 1)
        prev.firstBaselineOffsetPdf = prev.containerPdfY !== undefined && prev.containerPdfHeight !== undefined
          ? (prev.containerPdfY + prev.containerPdfHeight) - prev.pdfY
          : prev.firstBaselineOffsetPdf
        continue
      }
    }

    result.push({ ...item })
  }

  return result
}
