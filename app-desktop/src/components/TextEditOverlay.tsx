/**
 * TextEditOverlay.tsx
 *
 * Overlay that sits above each PDF page when the "textEdit" tool is active.
 *
 * Pipeline:
 *   1.  extractFontsFromPDF()        — extract embedded TTF/OTF bytes, register @font-face
 *   2.  extractPageTextItems()       — get text items with real font + color metadata
 *   3.  groupTextItemsIntoParagraphs() — merge consecutive same-font/color lines into blocks
 *   4.  Hover highlights with indigo outline
 *   5.  Click opens FloatingEditor styled with EXACT same font + color
 *   6.  Enter → commitEdit()  creates a textEdit annotation
 *   7.  Escape → cancelEdit()
 *
 * FloatingEditor features:
 *   - textarea (supports Shift+Enter for multi-line)
 *   - Renders in the real original font via @font-face
 *   - Renders in the real original color
 *   - AA toggle button (uppercase ↔ lowercase)
 *   - Drag handle on right border to resize width
 *   - Text expands freely; does NOT clip to original width
 *
 * Input is UNCONTROLLED (defaultValue, no onChange) to avoid the 1-char re-render bug.
 */

import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import * as PDFJS from 'pdfjs-dist'
import { usePDFStore } from '../store/pdfStore'
import { extractFontsFromPDF, ExtractedFont } from '../utils/fontExtractor'
import { buildPageDocumentModel } from '../utils/sceneGraph'
import { findEditableBlockAtPoint } from '../utils/hitTesting'
import type { EditableTextBlock } from '../utils/documentModel'
import { resolveViewportTextEditFrame } from '../utils/textLayoutEngine'
import { fitTextToBox } from '../utils/textBoxFit'
import { ocrPageToEditableBlocks } from '../utils/ocr'

const EDITOR_ZOOM_STEP = 0.08

interface Props {
  pageIndex: number
  pageWidth: number
  pageHeight: number
  zoom: number
  pdfDoc: PDFJS.PDFDocumentProxy | null
  pdfData: Uint8Array | null
}

type OcrEditableBlockCacheEntry = {
  zoom: number
  blocks: EditableTextBlock[]
}

const ocrEditableBlockCache = new Map<string, OcrEditableBlockCacheEntry>()

function ocrCacheKey(fileId: string | null, pageIndex: number) {
  return `${fileId || 'unknown'}:${pageIndex}`
}

function scaleCachedOcrBlocks(entry: OcrEditableBlockCacheEntry, zoom: number): EditableTextBlock[] {
  const ratio = zoom / entry.zoom
  return entry.blocks.map(block => ({
    ...block,
    vpX: block.vpX * ratio,
    vpY: block.vpY * ratio,
    vpWidth: block.vpWidth * ratio,
    vpHeight: block.vpHeight * ratio,
    vpBaselineY: block.vpBaselineY * ratio,
    vpFontSize: block.vpFontSize * ratio,
    lineHeightVp: block.lineHeightVp !== undefined ? block.lineHeightVp * ratio : undefined,
  }))
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const clean = String(hex || '').trim().replace('#', '')
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return null
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16),
  }
}

function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

function dominantBucketHex(samples: { r: number; g: number; b: number }[]): string | null {
  if (samples.length === 0) return null
  const buckets = new Map<string, { count: number; r: number; g: number; b: number }>()
  for (const pixel of samples) {
    const key = `${Math.round(pixel.r / 16) * 16}-${Math.round(pixel.g / 16) * 16}-${Math.round(pixel.b / 16) * 16}`
    const existing = buckets.get(key)
    if (existing) {
      existing.count += 1
      existing.r += pixel.r
      existing.g += pixel.g
      existing.b += pixel.b
    } else {
      buckets.set(key, { count: 1, r: pixel.r, g: pixel.g, b: pixel.b })
    }
  }
  const best = Array.from(buckets.values()).sort((a, b) => b.count - a.count)[0]
  if (!best) return null
  return rgbToHex(best.r / best.count, best.g / best.count, best.b / best.count)
}

function colorDistance(
  a: { r: number; g: number; b: number },
  b: { r: number; g: number; b: number }
): number {
  return Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b)
}

function normalizeSpacedEditorText(
  text: string | null | undefined,
  trackingMode?: 'normal' | 'spaced'
): string {
  const normalizedText = typeof text === 'string' ? text : text == null ? '' : String(text)
  if (trackingMode !== 'spaced') return normalizedText
  const lines = normalizedText.split('\n')
  return lines.map(line => {
    const tokens = line.trim().split(/\s+/).filter(Boolean)
    if (tokens.length > 1 && tokens.every(token => token.length === 1)) {
      return tokens.join('')
    }
    return line
  }).join('\n')
}

function refineAppearanceFromCanvas(
  canvas: HTMLCanvasElement | null,
  item: EditableTextBlock
): { textColor?: string; sampledBgColor?: string; sampledBgSpread?: number } {
  if (!canvas) return {}

  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return {}

  try {
    const dpr = window.devicePixelRatio || 1
    const sx = Math.max(0, Math.floor(item.vpX * dpr))
    const sy = Math.max(0, Math.floor(item.vpY * dpr))
    const sw = Math.max(1, Math.min(canvas.width - sx, Math.ceil(item.vpWidth * dpr)))
    const sh = Math.max(1, Math.min(canvas.height - sy, Math.ceil(item.vpHeight * dpr)))

    if (sw <= 0 || sh <= 0) return {}

    const data = ctx.getImageData(sx, sy, sw, sh).data
    const ringMargin = Math.max(2, Math.round(Math.min(sw, sh) * 0.16))
    const bgSamples: { r: number; g: number; b: number }[] = []
    const sampleBg = (px: number, py: number) => {
      if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) return
      const p = ctx.getImageData(px, py, 1, 1).data
      bgSamples.push({ r: p[0], g: p[1], b: p[2] })
    }

    const midX = sx + Math.floor(sw / 2)
    const midY = sy + Math.floor(sh / 2)
    const x1 = sx + Math.floor(sw * 0.2)
    const x2 = sx + Math.floor(sw * 0.5)
    const x3 = sx + Math.floor(sw * 0.8)
    const y1 = sy + Math.floor(sh * 0.2)
    const y2 = sy + Math.floor(sh * 0.5)
    const y3 = sy + Math.floor(sh * 0.8)

    ;[
      [x1, sy - ringMargin], [x2, sy - ringMargin], [x3, sy - ringMargin],
      [x1, sy + sh + ringMargin], [x2, sy + sh + ringMargin], [x3, sy + sh + ringMargin],
      [sx - ringMargin, y1], [sx - ringMargin, y2], [sx - ringMargin, y3],
      [sx + sw + ringMargin, y1], [sx + sw + ringMargin, y2], [sx + sw + ringMargin, y3],
      [sx - ringMargin, sy - ringMargin], [sx + sw + ringMargin, sy - ringMargin],
      [sx - ringMargin, sy + sh + ringMargin], [sx + sw + ringMargin, sy + sh + ringMargin],
      [midX, sy - ringMargin], [midX, sy + sh + ringMargin],
      [sx - ringMargin, midY], [sx + sw + ringMargin, midY],
    ].forEach(([px, py]) => sampleBg(px, py))

    if (bgSamples.length === 0) return {}

    const bgHex = dominantBucketHex(bgSamples) || rgbToHex(
      bgSamples.reduce((s, c) => s + c.r, 0) / bgSamples.length,
      bgSamples.reduce((s, c) => s + c.g, 0) / bgSamples.length,
      bgSamples.reduce((s, c) => s + c.b, 0) / bgSamples.length,
    )
    const bg = hexToRgb(bgHex)!
    const bgSpread = bgSamples.length > 0
      ? bgSamples.reduce((sum, sample) => sum + colorDistance(sample, bg), 0) / bgSamples.length
      : 999

    const buckets = new Map<string, { count: number; r: number; g: number; b: number }>()
    const step = Math.max(1, Math.floor(Math.min(sw, sh) / 24))

    for (let y = 0; y < sh; y += step) {
      for (let x = 0; x < sw; x += step) {
        const idx = (y * sw + x) * 4
        const alpha = data[idx + 3]
        if (alpha < 32) continue

        const pixel = { r: data[idx], g: data[idx + 1], b: data[idx + 2] }
        if (colorDistance(pixel, bg) < 46) continue

        const key = `${Math.round(pixel.r / 16) * 16}-${Math.round(pixel.g / 16) * 16}-${Math.round(pixel.b / 16) * 16}`
        const existing = buckets.get(key)
        if (existing) {
          existing.count += 1
          existing.r += pixel.r
          existing.g += pixel.g
          existing.b += pixel.b
        } else {
          buckets.set(key, { count: 1, r: pixel.r, g: pixel.g, b: pixel.b })
        }
      }
    }

    const best = Array.from(buckets.values()).sort((a, b) => b.count - a.count)[0]
    if (!best || best.count < 2) {
      return { sampledBgColor: bgHex, sampledBgSpread: bgSpread }
    }

    return {
      sampledBgColor: bgHex,
      sampledBgSpread: bgSpread,
      textColor: rgbToHex(best.r / best.count, best.g / best.count, best.b / best.count)
    }
  } catch {
    return {}
  }
}

function refinedBackgroundType(
  item: EditableTextBlock,
  sampledBgColor?: string,
  sampledBgSpread?: number
): EditableTextBlock['visualContext']['backgroundType'] {
  if (sampledBgColor && sampledBgSpread !== undefined && sampledBgSpread <= 18) {
    return item.layoutMode === 'container' ? 'vector' : 'solid'
  }
  return item.visualContext.backgroundType
}

function refinedBackgroundComplexity(
  item: EditableTextBlock,
  sampledBgSpread?: number
): EditableTextBlock['visualContext']['backgroundComplexity'] {
  if (sampledBgSpread !== undefined && sampledBgSpread <= 10) return 'low'
  if (sampledBgSpread !== undefined && sampledBgSpread <= 18) return 'medium'
  return item.visualContext.backgroundComplexity
}

function refinedRequiresReconstruction(
  item: EditableTextBlock,
  sampledBgSpread?: number
): boolean {
  if (sampledBgSpread !== undefined && sampledBgSpread <= 18) return false
  return item.visualContext.requiresReconstruction
}

interface EditorFontOption {
  key: string
  label: string
  cssFamily: string
}

const STYLE_WORDS_RE = /\b(regular|roman|book|medium|semibold|semi bold|bold|black|heavy|light|thin|italic|oblique)\b/gi

function splitCssFamilies(cssFontFamily: string): string[] {
  return cssFontFamily
    .split(',')
    .map(part => part.trim().replace(/['"]/g, ''))
    .filter(Boolean)
}

function guessGenericFamily(name?: string): 'serif' | 'sans-serif' | 'monospace' {
  const lower = String(name || '').toLowerCase()
  if (/mono|courier|code/.test(lower)) return 'monospace'
  if (/serif|times|georgia|garamond|baskerville|lora|playfair|merriweather|didot|bodoni/.test(lower)) {
    return 'serif'
  }
  return 'sans-serif'
}

function stripStyleWords(name?: string): string {
  return String(name || '')
    .replace(/^[A-Z]{6}\+/, '')
    .replace(/[_-]+/g, ' ')
    .replace(STYLE_WORDS_RE, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function buildCssStack(family: string, fallback: string): string {
  return `'${family}', ${fallback}`
}

function safeFontCheck(fontSpec: string): boolean {
  try {
    return typeof document !== 'undefined' && !!document.fonts?.check?.(fontSpec)
  } catch {
    return false
  }
}

function buildFontNameCandidates(
  cssFontFamily: string,
  fontName?: string,
  fontDisplayName?: string,
  pdfBaseFontName?: string
): string[] {
  const out: string[] = []
  const push = (value?: string) => {
    const clean = String(value || '').trim().replace(/['"]/g, '')
    if (!clean) return
    if (out.some(existing => existing.toLowerCase() === clean.toLowerCase())) return
    out.push(clean)
  }

  splitCssFamilies(cssFontFamily)
    .filter(name => !['sans-serif', 'serif', 'monospace', 'cursive', 'fantasy', 'system-ui'].includes(name.toLowerCase()))
    .forEach(push)

  ;[fontDisplayName, pdfBaseFontName].forEach(name => {
    const clean = String(name || '').replace(/^[A-Z]{6}\+/, '').replace(/[_-]+/g, ' ').trim()
    push(clean)
    push(stripStyleWords(clean))
    push(clean.split('-')[0])
  })

  if (fontName) {
    const stripped = fontName.replace(/^[A-Z]{6}\+/, '')
    push(stripped)
    push(stripped.replace(/[_-]+/g, ' '))
    push(stripStyleWords(stripped))
    push(stripped.split('-')[0])
  }

  return out.filter(Boolean)
}

function buildFontOptions(
  item: EditableTextBlock,
  fontMap: Map<string, ExtractedFont>
): EditorFontOption[] {
  const generic = guessGenericFamily(item.pdfBaseFontName || item.fontDisplayName || item.cssFontFamily)
  const seen = new Set<string>()
  const options: EditorFontOption[] = []

  const push = (label: string, cssFamily: string) => {
    const key = cssFamily.trim().toLowerCase()
    if (!key || seen.has(key)) return
    seen.add(key)
    options.push({ key, label, cssFamily })
  }

  push(`Auto · ${item.fontDisplayName || stripStyleWords(item.pdfBaseFontName) || 'Original'}`, resolveBestCSSFont(
    item.cssFontFamily,
    item.fontName,
    item.fontDisplayName,
    item.pdfBaseFontName
  ))

  for (const candidate of buildFontNameCandidates(item.cssFontFamily, item.fontName, item.fontDisplayName, item.pdfBaseFontName)) {
    if (!candidate) continue
    if (safeFontCheck(`16px '${candidate}'`)) {
      push(`Sistema · ${candidate}`, buildCssStack(candidate, generic))
    }
  }

  const extractedFonts = Array.from(fontMap.values())
    .sort((a, b) => a.baseName.localeCompare(b.baseName))

  extractedFonts.forEach(font => {
    push(`PDF · ${font.baseName}`, buildCssStack(font.cssFamily, guessGenericFamily(font.baseName)))
  })

  ;[
    'Arial',
    'Helvetica',
    'Times New Roman',
    'Georgia',
    'Garamond',
    'Baskerville',
    'Lora',
    'Rosario',
    'Playfair Display',
    'Merriweather',
    'Montserrat',
    'Open Sans',
    'Roboto',
    'Poppins',
  ].forEach(candidate => {
    if (safeFontCheck(`16px '${candidate}'`)) {
      push(`Biblioteca · ${candidate}`, buildCssStack(candidate, guessGenericFamily(candidate)))
    }
  })

  return options
}

// ─── Font resolution ──────────────────────────────────────────────────────────
//
// fontExtractor registers @font-face for all PDF-embedded fonts.
// For CFF (Type1C) fonts the browser may silently fail to parse the raw
// CFF bytes — document.fonts.check() lets us detect this and fall back to:
//   1. The PostScript base name (works when it's a system font like Calibri)
//   2. The original cssFontFamily (renders with sans-serif fallback — last resort)
//
function resolveBestCSSFont(
  cssFontFamily: string,
  fontName?: string,
  fontDisplayName?: string,
  pdfBaseFontName?: string
): string {
  if (!cssFontFamily) return 'sans-serif'

  const primaryFamily = cssFontFamily.split(',')[0].trim().replace(/['"]/g, '')
  const genericFamilies = new Set(['sans-serif', 'serif', 'monospace', 'cursive', 'fantasy', 'system-ui'])
  const fallbackGeneric = guessGenericFamily(pdfBaseFontName || fontDisplayName || cssFontFamily)

  // Fast path: the extracted font is already loaded by the browser.
  if (!genericFamilies.has(primaryFamily.toLowerCase()) && safeFontCheck(`16px '${primaryFamily}'`)) {
    return cssFontFamily
  }

  for (const candidate of buildFontNameCandidates(cssFontFamily, fontName, fontDisplayName, pdfBaseFontName)) {
    if (!genericFamilies.has(candidate.toLowerCase()) && safeFontCheck(`16px '${candidate}'`)) {
      return buildCssStack(candidate, fallbackGeneric)
    }
  }

  // Try to extract the PostScript base name from our CSS family name pattern:
  // UltraPDF_Calibri-Bold_F1  → "Calibri-Bold", "Calibri Bold", "Calibri", etc.
  const upMatch = primaryFamily.match(/^UltraPDF_(.+?)_[A-Za-z0-9]+$/)
  if (upMatch) {
    const rawBase = upMatch[1].replace(/_/g, '-')
    const variations: string[] = [
      rawBase,                               // "Calibri-Bold"
      rawBase.replace(/-/g, ' '),            // "Calibri Bold"
      rawBase.replace(/-(Bold|Italic|Regular|Light|Medium|Heavy|Black|Thin|Semibold|SemiBold|ExtraBold|ExtraLight|Oblique|BoldItalic|BoldOblique|LightItalic)$/i, ''),
      rawBase.split('-')[0],                 // "Calibri"
    ]
    for (const v of variations) {
      if (v && safeFontCheck(`16px '${v}'`)) return buildCssStack(v, fallbackGeneric)
    }
  }

  // Also try the raw PDF font resource name that PDF.js may have registered
  if (fontName) {
    const stripped = fontName.replace(/^[A-Z]{6}\+/, '')
    const candidates = [fontName, stripped, stripped.split('-')[0], stripped.replace(/-/g, ' ')]
    for (const name of candidates) {
      if (name && safeFontCheck(`16px '${name}'`)) return buildCssStack(name, fallbackGeneric)
    }
  }

  return cssFontFamily   // last resort — browser will use the declared stack fallback
}

export function TextEditOverlay({
  pageIndex, pageWidth, pageHeight, zoom, pdfDoc, pdfData
}: Props) {
  const { activeTool, activeFileId, addAnnotation, updateAnnotation, setZoom, files } = usePDFStore()
  const activeFile = useMemo(() => files.find(file => file.id === activeFileId), [files, activeFileId])

  const [textBlocks, setTextBlocks] = useState<EditableTextBlock[]>([])
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null)
  const [editItem,   setEditItem  ] = useState<EditableTextBlock | null>(null)
  const [fontsReady, setFontsReady] = useState(false)
  const [ocrStatus, setOcrStatus] = useState<string | null>(null)

  // Uncontrolled textarea — value is only read on commit via ref
  const inputRef = useRef<HTMLTextAreaElement>(null)
  // Font map from fontExtractor (stable across re-renders)
  const fontMapRef = useRef<Map<string, ExtractedFont>>(new Map())
  // Track the previous active file id to detect switches
  const prevFileIdRef = useRef<string | null>(null)

  // When the active file changes, immediately discard any in-progress edit
  // and invalidate the cached text blocks / font map for the old file.
  useEffect(() => {
    if (prevFileIdRef.current !== null && prevFileIdRef.current !== activeFileId) {
      setTextBlocks([])
      setHoveredIdx(null)
      setEditItem(null)
      setFontsReady(false)
      setOcrStatus(null)
      fontMapRef.current = new Map()
    }
    prevFileIdRef.current = activeFileId
  }, [activeFileId])

  useEffect(() => {
    const clearCache = () => {
      ocrEditableBlockCache.clear()
      setTextBlocks([])
      setHoveredIdx(null)
      setEditItem(null)
    }
    window.addEventListener('oportunidocs:ocr-cache-clear', clearCache)
    return () => window.removeEventListener('oportunidocs:ocr-cache-clear', clearCache)
  }, [])

  const isActive = activeTool === 'textEdit'

  // ── 1. Load embedded fonts when tool becomes active ───────────────────────
  // We wait for fonts to actually load into browser memory (not just register
  // the @font-face) so the canvas preview and textarea render with the correct
  // weight/style on the FIRST paint, with no fallback-font flicker.
  useEffect(() => {
    if (!isActive || !pdfData) { setFontsReady(false); return }

    let cancelled = false
    extractFontsFromPDF(pdfData)
      .then(async map => {
        if (cancelled) return
        fontMapRef.current = map

        // Pre-load all extracted fonts into browser memory before marking ready.
        // document.fonts.load() resolves when the font is in memory.
        const loadPromises = Array.from(map.values()).map(font =>
          document.fonts.load(`16px '${font.cssFamily}'`).catch(() => {})
        )
        await Promise.allSettled(loadPromises)

        if (!cancelled) setFontsReady(true)
      })
      .catch(() => { if (!cancelled) setFontsReady(true) })

    return () => { cancelled = true }
  }, [isActive, pdfData, activeFileId])

  // ── 2. Load + group text items once fonts are ready ───────────────────────
  useEffect(() => {
    if (!isActive || !pdfDoc) {
      setTextBlocks([])
      setHoveredIdx(null)
      setEditItem(null)
      setOcrStatus(null)
      return
    }

    let cancelled = false
    setOcrStatus(null)

    if (activeFile?.sourceKind === 'image' && pdfData) {
      const key = ocrCacheKey(activeFileId, pageIndex)
      const cached = ocrEditableBlockCache.get(key)
      if (cached) {
        setTextBlocks(scaleCachedOcrBlocks(cached, zoom))
        return () => {
          cancelled = true
        }
      }

      setOcrStatus('Detectando texto...')
      ocrPageToEditableBlocks({
        pdfData,
        pageIndex,
        displayZoom: zoom,
        onProgress: message => {
          if (!cancelled) setOcrStatus(message)
        }
      })
        .then(blocks => {
          if (cancelled) return
          ocrEditableBlockCache.set(key, { zoom, blocks })
          setTextBlocks(blocks)
        })
        .catch(error => {
          console.warn('[TextEditOverlay] OCR text detection failed:', error)
          if (!cancelled) setTextBlocks([])
        })
        .finally(() => {
          if (!cancelled) setOcrStatus(null)
        })

      return () => {
        cancelled = true
      }
    }

    buildPageDocumentModel(pdfDoc, pageIndex, zoom, fontMapRef.current)
      .then(model => {
        if (cancelled) return
        setTextBlocks(model.blocks)
      })
      .catch(() => {
        if (!cancelled) {
          setTextBlocks([])
          setOcrStatus(null)
        }
      })

    return () => {
      cancelled = true
    }
  }, [isActive, pdfDoc, pageIndex, zoom, fontsReady, activeFile?.sourceKind, pdfData, activeFileId])

  // ── 3. Focus textarea when an item is selected ────────────────────────────
  useEffect(() => {
    if (!editItem) return
    const t = setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 20)
    return () => clearTimeout(t)
  }, [editItem])

  // Keep the active edit box anchored to the refreshed extraction when zoom
  // changes. This prevents the edit target from drifting away from the PDF.
  useEffect(() => {
    if (!editItem) return

    const synced = textBlocks.find(item =>
      item.fontName === editItem.fontName &&
      Math.abs(item.pdfX - editItem.pdfX) < 0.75 &&
      Math.abs(item.pdfY - editItem.pdfY) < 0.75 &&
      Math.abs(item.pdfWidth - editItem.pdfWidth) < 2
    )

    if (!synced) return

    setEditItem(current => {
      if (!current) return current
      const unchanged =
        Math.abs(current.vpX - synced.vpX) < 0.01 &&
        Math.abs(current.vpY - synced.vpY) < 0.01 &&
        Math.abs(current.vpWidth - synced.vpWidth) < 0.01 &&
        Math.abs(current.vpHeight - synced.vpHeight) < 0.01 &&
        Math.abs(current.vpBaselineY - synced.vpBaselineY) < 0.01 &&
        Math.abs(current.vpFontSize - synced.vpFontSize) < 0.01 &&
        current.pdfLineHeight === synced.pdfLineHeight &&
        current.lineHeightVp === synced.lineHeightVp &&
        current.layoutMode === synced.layoutMode &&
        current.textAlign === synced.textAlign &&
        current.containerPdfX === synced.containerPdfX &&
        current.containerPdfY === synced.containerPdfY &&
        current.containerPdfWidth === synced.containerPdfWidth &&
        current.containerPdfHeight === synced.containerPdfHeight &&
        current.contentInsetPdfX === synced.contentInsetPdfX &&
        current.firstBaselineOffsetPdf === synced.firstBaselineOffsetPdf

      if (unchanged) return current

      return {
        ...current,
        vpX: synced.vpX,
        vpY: synced.vpY,
        vpWidth: synced.vpWidth,
        vpHeight: synced.vpHeight,
        vpBaselineY: synced.vpBaselineY,
        vpFontSize: synced.vpFontSize,
        pdfLineHeight: synced.pdfLineHeight,
        lineHeightVp: synced.lineHeightVp,
        bgRect: synced.bgRect,
        bgRectKey: synced.bgRectKey,
        layoutMode: synced.layoutMode,
        textAlign: synced.textAlign,
        containerPdfX: synced.containerPdfX,
        containerPdfY: synced.containerPdfY,
        containerPdfWidth: synced.containerPdfWidth,
        containerPdfHeight: synced.containerPdfHeight,
        contentInsetPdfX: synced.contentInsetPdfX,
        firstBaselineOffsetPdf: synced.firstBaselineOffsetPdf,
      }
    })
  }, [textBlocks, zoom, editItem])

  // Refs to let commitEdit read the latest toggle states without stale closure
  const isBoldRef    = useRef(false)
  const isItalicRef  = useRef(false)
  const isUpperRef   = useRef(false)
  const textColorRef = useRef<string>('#000000')
  const trackingModeRef = useRef<'normal' | 'spaced'>('normal')
  const letterSpacingRef = useRef<number>(0)
  const fontFamilyRef = useRef<string>('')
  const fontDisplayNameRef = useRef<string>('')
  const layoutLockedRef = useRef(true)
  const fontSizeScaleRef = useRef(1)
  const positionOffsetXPdfRef = useRef(0)
  const positionOffsetYPdfRef = useRef(0)
  const boxWidthScaleRef = useRef(1)
  const boxHeightScaleRef = useRef(1)
  const fitScaleRef = useRef(1)
  const fitAllowedRef = useRef(true)

  // ── 4. Commit: read textarea value, create/update annotation ──────────────
  const commitEdit = useCallback(() => {
    if (!editItem || !activeFileId) { setEditItem(null); return }
    if (layoutLockedRef.current && !fitAllowedRef.current) return

    const rawValue = inputRef.current?.value ?? editItem.text
    const normalizedTrackingMode = trackingModeRef.current ?? editItem.trackingMode
    const newValue = normalizeSpacedEditorText(rawValue, normalizedTrackingMode)
    const originalComparable = normalizeSpacedEditorText(editItem.text, normalizedTrackingMode)
    const styleChanged =
      (textColorRef.current || editItem.color) !== editItem.color ||
      isBoldRef.current !== editItem.isBold ||
      isItalicRef.current !== editItem.isItalic ||
      trackingModeRef.current !== (editItem.trackingMode ?? 'normal') ||
      letterSpacingRef.current !== (editItem.letterSpacingEm ?? 0) ||
      (fontFamilyRef.current || editItem.cssFontFamily) !== editItem.cssFontFamily ||
      layoutLockedRef.current !== (editItem.layoutLocked ?? true) ||
      fontSizeScaleRef.current !== (editItem.fontSizeScale ?? 1) ||
      positionOffsetXPdfRef.current !== (editItem.positionOffsetXPdf ?? 0) ||
      positionOffsetYPdfRef.current !== (editItem.positionOffsetYPdf ?? 0) ||
      boxWidthScaleRef.current !== (editItem.boxWidthScale ?? 1) ||
      boxHeightScaleRef.current !== (editItem.boxHeightScale ?? 1)

    if (newValue !== originalComparable || styleChanged) {
      const baseFontName = editItem.pdfBaseFontName || editItem.fontDisplayName || fontMapRef.current.get(editItem.fontName)?.baseName
      const pdfLineHeight = editItem.pdfLineHeight ?? (editItem.lineCount > 1
        ? editItem.pdfFontSize * 1.28
        : editItem.pdfFontSize * 1.2)

      // Build the annotation payload (shared between add and update)
      const annotationPayload = {
        type:            'textEdit' as const,
        pageIndex,
        x:               editItem.vpX,
        y:               editItem.vpY,
        width:           editItem.vpWidth,
        height:          editItem.vpHeight,
        text:            newValue,
        originalText:    editItem.originalText ?? editItem.text,
        pdfRawX:         editItem.pdfX,
        pdfRawY:         editItem.pdfY,
        pdfRawWidth:     editItem.pdfWidth,
        pdfRawFontSize:  editItem.pdfFontSize,
        fontSize:        editItem.vpHeight,
        fontFamily:      fontFamilyRef.current || editItem.cssFontFamily,
        pdfFontRef:      editItem.fontName,
        fontDisplayName: fontDisplayNameRef.current || editItem.fontDisplayName,
        pdfBaseFontName: baseFontName,
        textColor:       textColorRef.current || editItem.color,
        color:           textColorRef.current || editItem.color,
        opacity:         1,
        vpFontSize:      editItem.vpFontSize,
        vpBaselineY:     editItem.vpBaselineY,
        pdfLineHeight,
        lineHeightVp:    editItem.lineHeightVp ?? (editItem.lineCount > 1 ? editItem.vpFontSize * 1.28 : editItem.vpFontSize * 1.2),
        isBold:          isBoldRef.current,
        isItalic:        isItalicRef.current,
        bgColor:         editItem.bgColor ?? undefined,
        sampledBgColor:  (editItem as any).sampledBgColor,
        sampledBgSpread: (editItem as any).sampledBgSpread,
        layoutMode:      editItem.layoutMode,
        textAlign:       editItem.textAlign,
        trackingMode:    trackingModeRef.current,
        letterSpacingEm: letterSpacingRef.current,
        containerPdfX:   editItem.containerPdfX,
        containerPdfY:   editItem.containerPdfY,
        containerPdfWidth: editItem.containerPdfWidth,
        containerPdfHeight: editItem.containerPdfHeight,
        contentInsetPdfX: editItem.contentInsetPdfX,
        firstBaselineOffsetPdf: editItem.firstBaselineOffsetPdf,
        blockKind:       editItem.kind,
        confidence:      editItem.confidence,
        backgroundType:  refinedBackgroundType(editItem, (editItem as any).sampledBgColor, (editItem as any).sampledBgSpread),
        backgroundComplexity: refinedBackgroundComplexity(editItem, (editItem as any).sampledBgSpread),
        requiresReconstruction: refinedRequiresReconstruction(editItem, (editItem as any).sampledBgSpread),
        layoutLocked:    layoutLockedRef.current,
        fontSizeScale:   fontSizeScaleRef.current,
        positionOffsetXPdf: positionOffsetXPdfRef.current,
        positionOffsetYPdf: positionOffsetYPdfRef.current,
        boxWidthScale:   boxWidthScaleRef.current,
        boxHeightScale:  boxHeightScaleRef.current,
        fitScale:        fitScaleRef.current,
      }

      // ── Check if an annotation already exists for this exact block.
      // If it does, UPDATE it (replace text) instead of accumulating a new one.
      const currentFile = usePDFStore.getState().files.find(f => f.id === activeFileId)
      const existingAnn = currentFile?.annotations.find(ann =>
        ann.type === 'textEdit' &&
        ann.pageIndex === pageIndex &&
        ann.pdfRawX !== undefined &&
        ann.pdfRawY !== undefined &&
        Math.abs(ann.pdfRawX - editItem.pdfX) < 2 &&
        Math.abs(ann.pdfRawY - editItem.pdfY) < 2
      )

      if (existingAnn) {
        updateAnnotation(activeFileId, existingAnn.id, annotationPayload)
      } else {
        addAnnotation(activeFileId, { id: crypto.randomUUID(), ...annotationPayload })
      }
    }
    setEditItem(null)
  }, [editItem, activeFileId, addAnnotation, updateAnnotation, pageIndex, zoom])

  const cancelEdit = useCallback(() => setEditItem(null), [])

  useEffect(() => {
    if (!isActive) return
    const forceCommit = () => {
      if (editItem) commitEdit()
    }
    window.addEventListener('oportunidocs:commit-text-edit', forceCommit)
    return () => window.removeEventListener('oportunidocs:commit-text-edit', forceCommit)
  }, [isActive, editItem, commitEdit])

  // ── 5. Click → select nearest text item ──────────────────────────────────
  const handleClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!isActive) return
    if (editItem) { commitEdit(); return }
    const rect = e.currentTarget.getBoundingClientRect()
    const item = findEditableBlockAtPoint(textBlocks, e.clientX - rect.left, e.clientY - rect.top)
    if (item) {
      if (
        !Number.isFinite(item.vpX) ||
        !Number.isFinite(item.vpY) ||
        !Number.isFinite(item.vpWidth) ||
        !Number.isFinite(item.vpHeight)
      ) {
        console.warn('[TextEditOverlay] Ignoring invalid editable block', item)
        return
      }

      // Check if there's already an annotation for this block.
      // If yes, use the annotation's current text (not the original PDF text).
      const currentFile = usePDFStore.getState().files.find(f => f.id === activeFileId)
      const existingAnn = currentFile?.annotations.find(ann =>
        ann.type === 'textEdit' &&
        ann.pageIndex === pageIndex &&
        ann.pdfRawX !== undefined &&
        ann.pdfRawY !== undefined &&
        Math.abs(ann.pdfRawX - item.pdfX) < 2 &&
        Math.abs(ann.pdfRawY - item.pdfY) < 2
      )

      const pageRoot = e.currentTarget.closest('[data-page-index]')
      const pdfCanvas = pageRoot?.querySelector('.pdf-page-canvas') as HTMLCanvasElement | null
      const refined = refineAppearanceFromCanvas(pdfCanvas, item)

      // Resolve best available CSS font family:
      // fontExtractor registers @font-face but CFF fonts may fail to load.
      // Scanning document.fonts finds the best loaded alternative.
      const resolvedFont = resolveBestCSSFont(item.cssFontFamily, item.fontName, item.fontDisplayName, item.pdfBaseFontName)
      const safeBlockText = typeof item.text === 'string' ? item.text : item.text == null ? '' : String(item.text)

      setEditItem({
        ...item,
        // Use the already-edited text when re-opening a previously edited block.
        // originalText is preserved so commitEdit records the real PDF original.
        text:            existingAnn?.text ?? safeBlockText,
        originalText:    safeBlockText,             // always the real original from the PDF
        cssFontFamily:   existingAnn?.fontFamily ?? resolvedFont,
        fontDisplayName: existingAnn?.fontDisplayName ?? item.fontDisplayName,
        // Restore style from the existing annotation so the editor toggles are correct.
        color:           existingAnn?.textColor ?? refined.textColor ?? item.color,
        isBold:          existingAnn?.isBold    ?? item.isBold,
        isItalic:        existingAnn?.isItalic  ?? item.isItalic,
        trackingMode:    existingAnn?.trackingMode    ?? item.trackingMode,
        letterSpacingEm: existingAnn?.letterSpacingEm ?? item.letterSpacingEm,
        bgColor:         item.bgColor,
        sampledBgColor:  refined.sampledBgColor,
        sampledBgSpread: refined.sampledBgSpread,
        layoutLocked:    existingAnn?.layoutLocked ?? true,
        fontSizeScale:   existingAnn?.fontSizeScale ?? 1,
        positionOffsetXPdf: existingAnn?.positionOffsetXPdf ?? 0,
        positionOffsetYPdf: existingAnn?.positionOffsetYPdf ?? 0,
        boxWidthScale:   existingAnn?.boxWidthScale ?? 1,
        boxHeightScale:  existingAnn?.boxHeightScale ?? 1,
        fitScale:        existingAnn?.fitScale ?? 1,
      })
    }
  }, [isActive, editItem, commitEdit, textBlocks, activeFileId, pageIndex])

  // ── 6. Hover highlight ────────────────────────────────────────────────────
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!isActive || editItem) return
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const hit = findEditableBlockAtPoint(textBlocks, x, y, 3)
    const idx = hit ? textBlocks.findIndex(t => t.id === hit.id) : -1
    setHoveredIdx(idx >= 0 ? idx : null)
  }, [isActive, editItem, textBlocks])

  if (!isActive) return null

  return (
    <div
      className="absolute inset-0 z-20 select-none"
      style={{ cursor: editItem ? 'default' : 'text' }}
      onClick={handleClick}
      onMouseMove={handleMouseMove}
      onMouseLeave={() => setHoveredIdx(null)}
    >
      {ocrStatus && !editItem && (
        <div
          className="absolute left-2 top-2 pointer-events-none rounded px-2 py-1 text-[10px] font-medium"
          style={{
            background: 'rgba(30, 30, 46, 0.88)',
            color: 'rgba(255,255,255,0.86)',
            border: '1px solid rgba(99,102,241,0.5)'
          }}
        >
          OCR: {ocrStatus}
        </div>
      )}

      {/* ── Hover highlights ──────────────────────────────────────────────── */}
      {!editItem && textBlocks.map((item, i) => (
        <div
          key={item.id}
          className="absolute pointer-events-none"
          style={{
            left:       item.vpX,
            top:        item.vpY,
            width:      item.vpWidth,
            height:     item.vpHeight,
            background: hoveredIdx === i ? 'rgba(99,102,241,0.18)' : 'transparent',
            outline:    hoveredIdx === i ? '1.5px solid rgba(99,102,241,0.6)' : 'none',
            borderRadius: 2
          }}
        />
      ))}

      {/* ── Floating editor ───────────────────────────────────────────────── */}
      {editItem && (
        <FloatingEditor
          editItem={editItem}
          pageWidth={pageWidth}
          pageHeight={pageHeight}
          zoom={zoom}
          inputRef={inputRef}
          boldRef={isBoldRef}
          italicRef={isItalicRef}
          upperRef={isUpperRef}
          textColorRef={textColorRef}
          trackingModeRef={trackingModeRef}
          letterSpacingRef={letterSpacingRef}
          fontFamilyRef={fontFamilyRef}
          fontDisplayNameRef={fontDisplayNameRef}
          layoutLockedRef={layoutLockedRef}
          fontSizeScaleRef={fontSizeScaleRef}
          positionOffsetXPdfRef={positionOffsetXPdfRef}
          positionOffsetYPdfRef={positionOffsetYPdfRef}
          boxWidthScaleRef={boxWidthScaleRef}
          boxHeightScaleRef={boxHeightScaleRef}
          fitScaleRef={fitScaleRef}
          fitAllowedRef={fitAllowedRef}
          availableFonts={buildFontOptions(editItem, fontMapRef.current)}
          setZoom={setZoom}
          onCommit={commitEdit}
          onCancel={cancelEdit}
        />
      )}
    </div>
  )
}

// ─── Floating editor panel ───────────────────────────────────────────────────

interface EditorProps {
  editItem: EditableTextBlock
  pageWidth: number
  pageHeight: number
  zoom: number
  inputRef: React.RefObject<HTMLTextAreaElement>
  boldRef: React.MutableRefObject<boolean>
  italicRef: React.MutableRefObject<boolean>
  upperRef: React.MutableRefObject<boolean>
  textColorRef: React.MutableRefObject<string>
  trackingModeRef: React.MutableRefObject<'normal' | 'spaced'>
  letterSpacingRef: React.MutableRefObject<number>
  fontFamilyRef: React.MutableRefObject<string>
  fontDisplayNameRef: React.MutableRefObject<string>
  layoutLockedRef: React.MutableRefObject<boolean>
  fontSizeScaleRef: React.MutableRefObject<number>
  positionOffsetXPdfRef: React.MutableRefObject<number>
  positionOffsetYPdfRef: React.MutableRefObject<number>
  boxWidthScaleRef: React.MutableRefObject<number>
  boxHeightScaleRef: React.MutableRefObject<number>
  fitScaleRef: React.MutableRefObject<number>
  fitAllowedRef: React.MutableRefObject<boolean>
  availableFonts: EditorFontOption[]
  setZoom: (zoom: number) => void
  onCommit: () => void
  onCancel: () => void
}

function FloatingEditor({
  editItem,
  pageWidth,
  pageHeight,
  zoom,
  inputRef,
  boldRef,
  italicRef,
  upperRef,
  textColorRef,
  trackingModeRef,
  letterSpacingRef,
  fontFamilyRef,
  fontDisplayNameRef,
  layoutLockedRef,
  fontSizeScaleRef,
  positionOffsetXPdfRef,
  positionOffsetYPdfRef,
  boxWidthScaleRef,
  boxHeightScaleRef,
  fitScaleRef,
  fitAllowedRef,
  availableFonts,
  setZoom,
  onCommit,
  onCancel,
}: EditorProps) {
  const baseEditText = typeof editItem.text === 'string' ? editItem.text : editItem.text == null ? '' : String(editItem.text)
  const lineCount = (baseEditText.match(/\n/g)?.length ?? 0) + 1
  const initialEditorText = normalizeSpacedEditorText(baseEditText, editItem.trackingMode)
  const safeAvailableFonts: EditorFontOption[] =
    Array.isArray(availableFonts) && availableFonts.length > 0
      ? availableFonts
      : [{ key: 'system-sans', label: 'Sistema · Sans-serif', cssFamily: 'sans-serif' }]
  const initialFont = safeAvailableFonts.find(option => option.cssFamily === editItem.cssFontFamily) ?? safeAvailableFonts[0]

  // Style toggles — initialised from the original text's detected style
  const [isBold, setIsBold] = useState(editItem.isBold)
  const [isItalic, setIsItalic] = useState(editItem.isItalic)
  const [selectedColor, setSelectedColor] = useState(editItem.color || '#000000')
  const [trackingMode, setTrackingMode] = useState<'normal' | 'spaced'>(editItem.trackingMode ?? 'normal')
  const [letterSpacingEm, setLetterSpacingEm] = useState(editItem.letterSpacingEm ?? 0)
  const [selectedFontFamily, setSelectedFontFamily] = useState(initialFont?.cssFamily ?? editItem.cssFontFamily ?? 'sans-serif')
  const [selectedFontLabel, setSelectedFontLabel] = useState(initialFont?.label ?? editItem.fontDisplayName ?? 'Original')
  const [layoutLocked, setLayoutLocked] = useState(editItem.layoutLocked ?? true)
  const [fontSizeScale, setFontSizeScale] = useState(editItem.fontSizeScale ?? 1)
  const [positionOffsetXPdf, setPositionOffsetXPdf] = useState(editItem.positionOffsetXPdf ?? 0)
  const [positionOffsetYPdf, setPositionOffsetYPdf] = useState(editItem.positionOffsetYPdf ?? 0)
  const [boxWidthScale, setBoxWidthScale] = useState(editItem.boxWidthScale ?? 1)
  const [boxHeightScale, setBoxHeightScale] = useState(editItem.boxHeightScale ?? 1)
  const [fitState, setFitState] = useState(() => ({
    fontSize: editItem.vpFontSize,
    lineHeight: editItem.lineHeightVp ?? editItem.vpFontSize * 1.2,
    scale: editItem.fitScale ?? 1,
    fits: true,
    widestLine: editItem.vpWidth,
    totalHeight: editItem.vpHeight,
  }))
  const lastAcceptedTextRef = useRef(initialEditorText)

  // Detect if original text is uppercase (to init AA toggle)
  const [isUpperCase, setIsUpperCase] = useState(() => {
    const s = baseEditText.trim().replace(/\n/g, '')
    return s.length > 1 && s === s.toUpperCase() && s !== s.toLowerCase()
  })

  // Keep refs in sync so commitEdit can read latest values
  useEffect(() => { boldRef.current   = isBold },   [isBold,   boldRef])
  useEffect(() => { italicRef.current = isItalic }, [isItalic, italicRef])
  useEffect(() => { upperRef.current  = isUpperCase }, [isUpperCase, upperRef])
  useEffect(() => { textColorRef.current = selectedColor }, [selectedColor, textColorRef])
  useEffect(() => { trackingModeRef.current = trackingMode }, [trackingMode, trackingModeRef])
  useEffect(() => { letterSpacingRef.current = letterSpacingEm }, [letterSpacingEm, letterSpacingRef])
  useEffect(() => { fontFamilyRef.current = String(selectedFontFamily || 'sans-serif') }, [selectedFontFamily, fontFamilyRef])
  useEffect(() => { fontDisplayNameRef.current = String(selectedFontLabel || 'Original').replace(/^[^·]+·\s*/, '') }, [selectedFontLabel, fontDisplayNameRef])
  useEffect(() => { layoutLockedRef.current = layoutLocked }, [layoutLocked, layoutLockedRef])
  useEffect(() => { fontSizeScaleRef.current = fontSizeScale }, [fontSizeScale, fontSizeScaleRef])
  useEffect(() => { positionOffsetXPdfRef.current = positionOffsetXPdf }, [positionOffsetXPdf, positionOffsetXPdfRef])
  useEffect(() => { positionOffsetYPdfRef.current = positionOffsetYPdf }, [positionOffsetYPdf, positionOffsetYPdfRef])
  useEffect(() => { boxWidthScaleRef.current = boxWidthScale }, [boxWidthScale, boxWidthScaleRef])
  useEffect(() => { boxHeightScaleRef.current = boxHeightScale }, [boxHeightScale, boxHeightScaleRef])
  useEffect(() => { fitScaleRef.current = fitState.scale }, [fitState.scale, fitScaleRef])
  useEffect(() => { fitAllowedRef.current = fitState.fits }, [fitState.fits, fitAllowedRef])

  const previewFrame = useMemo(() => resolveViewportTextEditFrame({
    type: 'textEdit',
    pageIndex: editItem.pageIndex,
    x: editItem.vpX,
    y: editItem.vpY,
    width: editItem.vpWidth,
    height: editItem.vpHeight,
    pdfRawX: editItem.pdfX,
    pdfRawY: editItem.pdfY,
    pdfRawWidth: editItem.pdfWidth,
    pdfRawFontSize: editItem.pdfFontSize,
    fontSize: editItem.vpFontSize,
    vpFontSize: editItem.vpFontSize,
    vpBaselineY: editItem.vpBaselineY,
    pdfLineHeight: editItem.pdfLineHeight,
    lineHeightVp: editItem.lineHeightVp,
    layoutMode: editItem.layoutMode,
    containerPdfX: editItem.containerPdfX,
    containerPdfY: editItem.containerPdfY,
    containerPdfWidth: editItem.containerPdfWidth,
    containerPdfHeight: editItem.containerPdfHeight,
    contentInsetPdfX: editItem.contentInsetPdfX,
    firstBaselineOffsetPdf: editItem.firstBaselineOffsetPdf,
    fontSizeScale,
    positionOffsetXPdf,
    positionOffsetYPdf,
    boxWidthScale,
    boxHeightScale,
  } as any, pageHeight, zoom), [
    editItem,
    pageHeight,
    zoom,
    fontSizeScale,
    positionOffsetXPdf,
    positionOffsetYPdf,
    boxWidthScale,
    boxHeightScale,
  ])

  const measureFit = useCallback((rawText: string) => {
    const normalized = normalizeSpacedEditorText(rawText, trackingMode)
    const lines = normalized.split('\n')
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      return {
        fontSize: previewFrame.fontSize,
        lineHeight: previewFrame.lineHeight,
        scale: 1,
        fits: true,
        widestLine: previewFrame.boxWidth,
        totalHeight: previewFrame.boxHeight,
      }
    }
    const primaryFamily = String(selectedFontFamily || 'sans-serif').split(',')[0].trim().replace(/['"]/g, '')
    const weightSpec = isBold ? 'bold ' : ''
    const styleSpec = isItalic ? 'italic ' : ''
    return fitTextToBox({
      lines,
      baseFontSize: previewFrame.fontSize,
      baseLineHeight: previewFrame.lineHeight,
      maxWidth: Math.max(4, previewFrame.boxWidth - ((previewFrame.container?.insetX ?? 0) * 2)),
      maxHeight: Math.max(4, previewFrame.boxHeight),
      measureLine: (fontSize, _lineHeight, line) => {
        ctx.font = `${styleSpec}${weightSpec}${fontSize}px '${primaryFamily}', sans-serif`
        if (trackingMode !== 'spaced') return ctx.measureText(line).width
        const glyphs = Array.from(line.replace(/\s+/g, ''))
        return glyphs.reduce((sum, glyph, index) => {
          const advance = ctx.measureText(glyph).width
          return sum + advance + (index < glyphs.length - 1 ? letterSpacingEm * fontSize : 0)
        }, 0)
      },
    })
  }, [trackingMode, selectedFontFamily, isBold, isItalic, previewFrame, letterSpacingEm])

  const syncFitState = useCallback((rawText: string, enforceLimit: boolean) => {
    const nextFit = measureFit(rawText)
    if (layoutLocked && enforceLimit && !nextFit.fits && inputRef.current) {
      inputRef.current.value = lastAcceptedTextRef.current
      setFitState(measureFit(lastAcceptedTextRef.current))
      return false
    }
    lastAcceptedTextRef.current = rawText
    setFitState(nextFit)
    return nextFit.fits
  }, [layoutLocked, inputRef, measureFit])

  useEffect(() => {
    syncFitState(inputRef.current?.value ?? initialEditorText, false)
  }, [syncFitState, inputRef, initialEditorText, selectedFontFamily, isBold, isItalic, trackingMode, letterSpacingEm, layoutLocked, fontSizeScale, boxWidthScale, boxHeightScale, positionOffsetXPdf, positionOffsetYPdf])

  const panelMaxWidth = Math.max(220, pageWidth - 8)
  const initialPanelWidth = Math.min(panelMaxWidth, Math.max(editItem.vpWidth + 40, 280))
  const [panelWidth, setPanelWidth] = useState(initialPanelWidth)
  const effectivePanelWidth = Math.min(panelWidth, panelMaxWidth)
  const dragState = useRef<{ startX: number; startW: number } | null>(null)

  useEffect(() => {
    setPanelWidth(width => Math.min(Math.max(width, 220), panelMaxWidth))
  }, [panelMaxWidth, zoom])

  const startWidthDrag = (e: React.MouseEvent) => {
    e.preventDefault()
    dragState.current = { startX: e.clientX, startW: effectivePanelWidth }
    const onMove = (ev: MouseEvent) => {
      if (!dragState.current) return
      const delta = ev.clientX - dragState.current.startX
      setPanelWidth(Math.min(panelMaxWidth, Math.max(220, dragState.current.startW + delta)))
    }
    const onUp = () => {
      dragState.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // Toggle AA: transform textarea value and flip state
  const toggleCase = () => {
    if (!inputRef.current) return
    const current = inputRef.current.value
    const next = isUpperCase
      ? current.toLowerCase()
      : current.toUpperCase()
    inputRef.current.value = next
    setIsUpperCase(v => !v)
    syncFitState(next, true)
    // Keep focus after toggle
    inputRef.current.focus()
  }

  // Panel position — above or below the text item
  const PANEL_HEADER = 30
  const PANEL_FOOTER = 24
  const PANEL_ADJUST = layoutLocked ? 0 : 28
  const textareaRows = Math.min(Math.max(lineCount, 1), 6)
  // Approximate textarea height: each row ~(displayFontSize * 1.5) capped at 160px
  const PANEL_H = PANEL_HEADER + PANEL_FOOTER + PANEL_ADJUST + Math.min(textareaRows * 28 + 16, 160)

  const ringLeft = (previewFrame.container?.x ?? editItem.vpX) - 2
  const ringTop = (previewFrame.container?.y ?? editItem.vpY) - 2
  const ringWidth = previewFrame.boxWidth + 4
  const ringHeight = previewFrame.boxHeight + 4
  const canShowBelow = ringTop + ringHeight + PANEL_H + 12 <= pageHeight
  const canShowAbove = ringTop > PANEL_H + 12
  const showAbove = !canShowBelow && canShowAbove
  const panelLeft = Math.max(4, Math.min(ringLeft, pageWidth - effectivePanelWidth - 12))
  const rawPanelTop = showAbove
    ? ringTop - PANEL_H - 6
    : ringTop + ringHeight + 6
  const panelTop = Math.max(4, Math.min(rawPanelTop, pageHeight - PANEL_H - 4))

  // Display font size: cap at 36px for UI usability (very large titles would overflow)
  const displayFontSize = Math.min(Math.max(Math.round(fitState.fontSize), 11), 36)

  // Color to show in textarea: use original color, but ensure it's visible on dark bg
  const textColor = selectedColor
  const editorBackground = '#f8fafc'
  const trackingButtonLabel = trackingMode === 'spaced' ? 'A V' : 'AV'
  const commitBlocked = layoutLocked && !fitState.fits
  const nudgeStep = Math.max(0.5, Number((1 / Math.max(zoom, 0.7)).toFixed(2)))

  return (
    <div
      className="absolute z-30"
      style={{ left: panelLeft, top: panelTop }}
      onClick={e => e.stopPropagation()}
    >
      {/* Connector line from panel to original text */}
      <div
        className="absolute pointer-events-none"
        style={{
          left:       ringLeft - panelLeft + ringWidth / 2 - 1,
          top:        showAbove ? PANEL_H + 4 : -6,
          width:      2,
          height:     6,
          background: '#6366f1',
          opacity:    0.5,
        }}
      />

      {/* Highlight ring around the text being edited */}
      <div
        className="absolute pointer-events-none"
        style={{
          left:         ringLeft - panelLeft,
          top:          showAbove ? PANEL_H + 10 : -ringHeight - 6,
          width:        ringWidth,
          height:       ringHeight,
          border:       '2px solid #6366f1',
          borderRadius: 3,
          boxShadow:    '0 0 0 3px rgba(99,102,241,0.15)',
          zIndex:       1,
        }}
      />

      {/* Main panel container with drag handle */}
      <div style={{ position: 'relative', width: effectivePanelWidth, zIndex: 2 }}>
        <div
          className="rounded-xl shadow-2xl overflow-hidden"
          style={{ background: '#1e1e2e', border: '1.5px solid #6366f1' }}
        >
          {/* ── Header ──────────────────────────────────────────────────── */}
          <div
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs flex-wrap"
            style={{ background: '#6366f1', color: 'white', minHeight: PANEL_HEADER }}
          >
            <span style={{ fontWeight: 600, flexShrink: 0 }}>Editar texto</span>

            <select
              value={selectedFontFamily}
              onChange={e => {
                const next = safeAvailableFonts.find(option => option.cssFamily === e.target.value)
                setSelectedFontFamily(e.target.value)
                setSelectedFontLabel(next?.label ?? e.target.value)
              }}
              className="rounded px-1.5 py-0.5 text-[10px] outline-none"
              style={{
                background: 'rgba(0,0,0,0.25)',
                color: 'white',
                border: '1px solid rgba(255,255,255,0.3)',
                maxWidth: 156,
              }}
              title={selectedFontLabel}
            >
              {safeAvailableFonts.map(option => (
                <option key={option.key} value={option.cssFamily}>
                  {option.label}
                </option>
              ))}
            </select>
            <span style={{ opacity: 0.7, fontSize: 10, flexShrink: 0 }}>
              {Math.round(editItem.pdfFontSize * fontSizeScale)}pt
            </span>
            <button
              onClick={() => setFontSizeScale(v => Math.max(0.45, Number((v - 0.05).toFixed(2))))}
              title="Diminuir tamanho"
              style={{
                background: 'rgba(0,0,0,0.2)',
                color: 'white',
                border: '1px solid rgba(255,255,255,0.3)',
                borderRadius: 4,
                padding: '1px 6px',
                fontSize: 11,
                fontWeight: 700,
                cursor: 'pointer',
                lineHeight: 1.6,
                flexShrink: 0
              }}
            >A-</button>
            <button
              onClick={() => setFontSizeScale(v => Math.min(2.6, Number((v + 0.05).toFixed(2))))}
              title="Aumentar tamanho"
              style={{
                background: 'rgba(0,0,0,0.2)',
                color: 'white',
                border: '1px solid rgba(255,255,255,0.3)',
                borderRadius: 4,
                padding: '1px 6px',
                fontSize: 11,
                fontWeight: 700,
                cursor: 'pointer',
                lineHeight: 1.6,
                flexShrink: 0
              }}
            >A+</button>

            {/* Manual color selector */}
            <label
              title={`Cor do texto: ${selectedColor}`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 16,
                height: 16,
                borderRadius: 4,
                overflow: 'hidden',
                border: '1px solid rgba(255,255,255,0.45)',
                background: selectedColor,
                flexShrink: 0,
                cursor: 'pointer'
              }}
            >
              <input
                type="color"
                value={selectedColor}
                onChange={e => setSelectedColor(e.target.value)}
                style={{
                  width: 22,
                  height: 22,
                  padding: 0,
                  border: 'none',
                  background: 'transparent',
                  cursor: 'pointer'
                }}
              />
            </label>

            {/* ── Style toggle buttons ─────────────────────────────────── */}
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 4, flexShrink: 0 }}>
              <button
                onClick={() => setLayoutLocked(v => !v)}
                title={layoutLocked ? 'Desbloquear caixa e posição' : 'Travar caixa e posição'}
                style={{
                  background: layoutLocked ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.2)',
                  color: 'white',
                  border: '1px solid rgba(255,255,255,0.3)',
                  borderRadius: 4,
                  padding: '1px 6px',
                  fontSize: 11,
                  fontWeight: 700,
                  cursor: 'pointer',
                  minWidth: 40,
                }}
              >{layoutLocked ? 'LOCK' : 'FREE'}</button>

              {/* B — Bold toggle */}
              <button
                onClick={() => setIsBold(v => !v)}
                title={isBold ? 'Remover negrito' : 'Aplicar negrito'}
                style={{
                  background: isBold ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.2)',
                  color: 'white',
                  border: '1px solid rgba(255,255,255,0.3)',
                  borderRadius: 4,
                  padding: '1px 7px',
                  fontSize: 12,
                  fontWeight: 900,
                  cursor: 'pointer',
                  lineHeight: 1.5,
                  minWidth: 24,
                }}
              >B</button>

              {/* I — Italic toggle */}
              <button
                onClick={() => setIsItalic(v => !v)}
                title={isItalic ? 'Remover itálico' : 'Aplicar itálico'}
                style={{
                  background: isItalic ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.2)',
                  color: 'white',
                  border: '1px solid rgba(255,255,255,0.3)',
                  borderRadius: 4,
                  padding: '1px 7px',
                  fontSize: 12,
                  fontWeight: 400,
                  fontStyle: 'italic',
                  cursor: 'pointer',
                  lineHeight: 1.5,
                  minWidth: 24,
                }}
              >I</button>

              {/* AA — Uppercase toggle */}
              <button
                onClick={toggleCase}
                title={isUpperCase ? 'Mudar para minúsculas' : 'Mudar para MAIÚSCULAS'}
                style={{
                  background: isUpperCase ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.2)',
                  color: 'white',
                  border: '1px solid rgba(255,255,255,0.3)',
                  borderRadius: 4,
                  padding: '1px 6px',
                  fontSize: 11,
                  fontWeight: 700,
                  cursor: 'pointer',
                  letterSpacing: '0.04em',
                  lineHeight: 1.6,
                  minWidth: 28,
                }}
              >{isUpperCase ? 'AA' : 'aa'}</button>

              <button
                onClick={() => setTrackingMode(mode => mode === 'spaced' ? 'normal' : 'spaced')}
                title={trackingMode === 'spaced' ? 'Desativar espaçamento entre letras' : 'Ativar espaçamento entre letras'}
                style={{
                  background: trackingMode === 'spaced' ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.2)',
                  color: 'white',
                  border: '1px solid rgba(255,255,255,0.3)',
                  borderRadius: 4,
                  padding: '1px 6px',
                  fontSize: 11,
                  fontWeight: 700,
                  cursor: 'pointer',
                  letterSpacing: trackingMode === 'spaced' ? '0.18em' : 'normal',
                  lineHeight: 1.6,
                  minWidth: 30,
                }}
              >{trackingButtonLabel}</button>
            </div>
          </div>

          {!layoutLocked && (
            <div
              className="flex items-center gap-1 px-3 py-1 text-[10px] flex-wrap"
              style={{ background: '#3d41a3', color: 'rgba(255,255,255,0.88)' }}
            >
              <span style={{ opacity: 0.85 }}>Ajustes</span>
              <button onClick={() => setFontSizeScale(v => Math.max(0.55, Number((v - 0.05).toFixed(2))))} className="rounded px-1.5 py-0.5" style={{ background: 'rgba(0,0,0,0.22)' }}>A-</button>
              <button onClick={() => setFontSizeScale(v => Math.min(2.2, Number((v + 0.05).toFixed(2))))} className="rounded px-1.5 py-0.5" style={{ background: 'rgba(0,0,0,0.22)' }}>A+</button>
              <button onClick={() => setPositionOffsetXPdf(v => Number((v - nudgeStep).toFixed(2)))} className="rounded px-1.5 py-0.5" style={{ background: 'rgba(0,0,0,0.22)' }}>X-</button>
              <button onClick={() => setPositionOffsetXPdf(v => Number((v + nudgeStep).toFixed(2)))} className="rounded px-1.5 py-0.5" style={{ background: 'rgba(0,0,0,0.22)' }}>X+</button>
              <button onClick={() => setPositionOffsetYPdf(v => Number((v - nudgeStep).toFixed(2)))} className="rounded px-1.5 py-0.5" style={{ background: 'rgba(0,0,0,0.22)' }}>Y-</button>
              <button onClick={() => setPositionOffsetYPdf(v => Number((v + nudgeStep).toFixed(2)))} className="rounded px-1.5 py-0.5" style={{ background: 'rgba(0,0,0,0.22)' }}>Y+</button>
              <button onClick={() => setBoxWidthScale(v => Math.max(0.55, Number((v - 0.04).toFixed(2))))} className="rounded px-1.5 py-0.5" style={{ background: 'rgba(0,0,0,0.22)' }}>W-</button>
              <button onClick={() => setBoxWidthScale(v => Math.min(2.4, Number((v + 0.04).toFixed(2))))} className="rounded px-1.5 py-0.5" style={{ background: 'rgba(0,0,0,0.22)' }}>W+</button>
              <button onClick={() => setBoxHeightScale(v => Math.max(0.55, Number((v - 0.04).toFixed(2))))} className="rounded px-1.5 py-0.5" style={{ background: 'rgba(0,0,0,0.22)' }}>H-</button>
              <button onClick={() => setBoxHeightScale(v => Math.min(2.4, Number((v + 0.04).toFixed(2))))} className="rounded px-1.5 py-0.5" style={{ background: 'rgba(0,0,0,0.22)' }}>H+</button>
              <button
                onClick={() => {
                  setFontSizeScale(1)
                  setPositionOffsetXPdf(0)
                  setPositionOffsetYPdf(0)
                  setBoxWidthScale(1)
                  setBoxHeightScale(1)
                }}
                className="rounded px-1.5 py-0.5"
                style={{ background: 'rgba(255,255,255,0.18)' }}
              >RESET</button>
            </div>
          )}

          {/* ── Textarea (uncontrolled) ──────────────────────────────────── */}
          <textarea
            ref={inputRef}
            defaultValue={initialEditorText}
            className="w-full outline-none px-3 py-2"
            style={{
              background:    editorBackground,
              color:         textColor,
              border:        'none',
              fontFamily:    selectedFontFamily,
              fontSize:      displayFontSize,
              fontWeight:    isBold   ? 'bold'   : 'normal',
              fontStyle:     isItalic ? 'italic' : 'normal',
              textAlign:     editItem.textAlign ?? 'left',
              letterSpacing: trackingMode === 'spaced' ? `${letterSpacingEm}em` : 'normal',
              lineHeight:    1.45,
              resize:        'none',
              minHeight:     displayFontSize * 2,
              maxHeight:     160,
              display:       'block',
              width:         '100%',
              boxSizing:     'border-box',
            }}
            rows={textareaRows}
            onKeyDown={e => {
              e.stopPropagation()
              const ctrl = e.ctrlKey || e.metaKey
              if (ctrl && (e.key === '=' || e.key === '+')) {
                e.preventDefault()
                setZoom(usePDFStore.getState().zoom + EDITOR_ZOOM_STEP)
                return
              }
              if (ctrl && e.key === '-') {
                e.preventDefault()
                setZoom(usePDFStore.getState().zoom - EDITOR_ZOOM_STEP)
                return
              }
              if (ctrl && e.key === '0') {
                e.preventDefault()
                setZoom(1)
                return
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                if (!commitBlocked) onCommit()
              }
              if (e.key === 'Escape')               { e.preventDefault(); onCancel() }
            }}
            onInput={e => { syncFitState(e.currentTarget.value, true) }}
            onWheel={e => {
              const ctrl = e.ctrlKey || e.metaKey
              if (!ctrl) return
              e.preventDefault()
              const currentZoom = usePDFStore.getState().zoom
              const delta = e.deltaY < 0 ? EDITOR_ZOOM_STEP : -EDITOR_ZOOM_STEP
              setZoom(currentZoom + delta)
            }}
          />

          {/* ── Footer ──────────────────────────────────────────────────── */}
          <div
            className="flex items-center justify-between px-3 py-1 text-[10px]"
            style={{ background: '#16162a', color: 'rgba(255,255,255,0.35)', minHeight: PANEL_FOOTER }}
          >
            <span>{layoutLocked ? `Travado · ${Math.round(fitState.scale * 100)}%` : 'Livre · ajustes manuais'}</span>
            <span>{commitBlocked ? 'Não cabe na caixa' : 'Enter confirmar · Esc cancelar'}</span>
          </div>
        </div>

        {/* ── Right drag handle ────────────────────────────────────────── */}
        <div
          className="absolute top-0 right-0 h-full flex items-center justify-center"
          style={{
            width: 10,
            cursor: 'ew-resize',
            transform: 'translateX(100%)',
            paddingLeft: 2,
          }}
          onMouseDown={startWidthDrag}
          title="Arrastar para redimensionar"
        >
          <div style={{
            width: 4,
            height: 32,
            background: 'rgba(99,102,241,0.55)',
            borderRadius: 2,
          }} />
        </div>
      </div>
    </div>
  )
}
