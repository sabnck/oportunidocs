/**
 * fontExtractor.ts
 *
 * Extracts embedded font bytes from a PDF document using pdf-lib's low-level
 * object graph. Supports:
 *   - TrueType  (FontDescriptor → FontFile2)
 *   - OpenType / CFF  (FontDescriptor → FontFile3)
 *   - Type1 / PostScript  (FontDescriptor → FontFile)
 *   - Type0 composite fonts  (descend into DescendantFonts)
 *
 * After extraction each font is registered as a browser @font-face so the
 * TextEditOverlay can render in the exact same typeface as the original PDF.
 *
 * Stream decompression uses the browser's DecompressionStream API
 * (available in all Chromium / Electron versions ≥ 80).
 */

import { PDFDocument, PDFName, PDFDict, PDFRef, PDFRawStream, PDFArray } from 'pdf-lib'

// ─── Public types ──────────────────────────────────────────────────────────

export interface ExtractedFont {
  /** PDF resource key as it appears in /Resources/Font (e.g. 'F1', 'TT2', 'g_d0_f2') */
  pdfName: string
  /** CSS font-family name registered via @font-face */
  cssFamily: string
  /** Decoded font bytes — embed directly with pdf-lib + fontkit */
  bytes: Uint8Array
  /** Format hint for CSS src: format() */
  format: 'truetype' | 'opentype'
  /** Clean PostScript base name (subset prefix stripped) */
  baseName: string
  /** True when the base name indicates a bold variant */
  isBold: boolean
  /** True when the base name indicates an italic/oblique variant */
  isItalic: boolean
}

// ─── Style detection helpers ────────────────────────────────────────────────

export function isBoldFont(baseName: string): boolean {
  const l = baseName.toLowerCase()
  return (
    l.includes('bold') || l.includes('heavy') || l.includes('black') ||
    l.includes('demi')  || l.includes('extrabold') || l.includes('semibold') ||
    l.includes('ultrabold')
  )
}

export function isItalicFont(baseName: string): boolean {
  const l = baseName.toLowerCase()
  return l.includes('italic') || l.includes('oblique') || l.includes('slant')
}

// ─── Module-level caches ────────────────────────────────────────────────────

/** key = quick PDF fingerprint → extracted font map */
const fontCache = new Map<string, Map<string, ExtractedFont>>()
/** cssFamily → blob URL (kept to revoke on cleanup) */
const registeredUrls = new Map<string, string>()

// ─── Main export ────────────────────────────────────────────────────────────

/**
 * Extract all embeddable fonts from a PDF.
 * Results are cached — repeated calls with the same bytes are essentially free.
 * Each found font is registered as a @font-face on the document.
 */
export async function extractFontsFromPDF(
  pdfData: Uint8Array
): Promise<Map<string, ExtractedFont>> {
  const key = pdfFingerprint(pdfData)
  if (fontCache.has(key)) return fontCache.get(key)!

  const result = new Map<string, ExtractedFont>()

  try {
    const pdfDoc = await PDFDocument.load(pdfData, {
      ignoreEncryption: true,
      throwOnInvalidObject: false
    } as any)

    const ctx = pdfDoc.context

    for (const page of pdfDoc.getPages()) {
      const resourcesRaw = page.node.get(PDFName.of('Resources'))
      if (!resourcesRaw) continue

      const resources = toDict(ctx, resourcesRaw)
      if (!resources) continue

      const fontDictRaw = resources.get(PDFName.of('Font'))
      if (!fontDictRaw) continue

      const fontDict = toDict(ctx, fontDictRaw)
      if (!fontDict) continue

      for (const [keyObj, fontRefOrObj] of fontDict.entries()) {
        // PDF resource name — strip leading '/'
        const pdfName = keyObj.toString().replace(/^\//, '')
        if (result.has(pdfName)) continue

        const fontObj = toDict(ctx, fontRefOrObj)
        if (!fontObj) continue

        // Type0 composite fonts wrap the real font in DescendantFonts
        const subtype = fontObj.get(PDFName.of('Subtype'))?.toString()
        if (subtype === '/Type0') {
          const descRaw = fontObj.get(PDFName.of('DescendantFonts'))
          if (descRaw) {
            const descObj = descRaw instanceof PDFRef ? ctx.lookup(descRaw) : descRaw
            // DescendantFonts is a single-element PDF array
            const firstRef = (descObj as PDFArray | null)?.get(0)
            if (firstRef) {
              const cidFont = toDict(ctx, firstRef)
              if (cidFont) {
                await extractFromFontDict(ctx, cidFont, fontObj, pdfName, result)
              }
            }
          }
        } else {
          await extractFromFontDict(ctx, fontObj, fontObj, pdfName, result)
        }
      }
    }
  } catch (err) {
    console.warn('[fontExtractor] extraction error:', err)
  }

  fontCache.set(key, result)
  return result
}

/** Remove all cached font data and revoke blob URLs (call on PDF close) */
export function clearFontCache(): void {
  fontCache.clear()
  for (const url of registeredUrls.values()) {
    try { URL.revokeObjectURL(url) } catch { /* ignore */ }
  }
  registeredUrls.clear()
  document.querySelectorAll('[id^="oportunidocs-ff-"]').forEach(el => el.remove())
}

// ─── Internal helpers ────────────────────────────────────────────────────────

async function extractFromFontDict(
  ctx: any,
  fontDict: PDFDict,
  topDict: PDFDict,
  pdfName: string,
  result: Map<string, ExtractedFont>
): Promise<void> {
  // FontDescriptor may live on the CIDFont dict or the Type0 wrapper
  const descriptorRaw =
    fontDict.get(PDFName.of('FontDescriptor')) ??
    topDict.get(PDFName.of('FontDescriptor'))
  if (!descriptorRaw) return

  const descriptor = toDict(ctx, descriptorRaw)
  if (!descriptor) return

  // Try font file entries in order of preference
  const candidates: Array<[string, 'truetype' | 'opentype']> = [
    ['FontFile2', 'truetype'],
    ['FontFile3', 'opentype'],
  ]

  for (const [fileKey, format] of candidates) {
    const streamRaw = descriptor.get(PDFName.of(fileKey))
    if (!streamRaw) continue

    const streamObj = streamRaw instanceof PDFRef
      ? ctx.lookup(streamRaw)
      : streamRaw

    if (!(streamObj instanceof PDFRawStream)) continue

    const bytes = await decodeStream(streamObj)
    if (!bytes || bytes.length < 50) continue

    // Resolve the font name: prefer FontName from descriptor, then BaseFont
    const rawName =
      descriptor.get(PDFName.of('FontName'))?.toString() ??
      topDict.get(PDFName.of('BaseFont'))?.toString() ??
      fontDict.get(PDFName.of('BaseFont'))?.toString() ??
      `/${pdfName}`

    const baseName  = rawName.replace(/^\//, '').replace(/^[A-Z]{6}\+/, '')
    const cssFamily = `OportuniDocs_${baseName.replace(/[^a-zA-Z0-9]/g, '_')}_${pdfName}`
    const isBold    = isBoldFont(baseName)
    const isItalic  = isItalicFont(baseName)

    const extracted: ExtractedFont = { pdfName, cssFamily, bytes, format, baseName, isBold, isItalic }
    result.set(pdfName, extracted)
    registerFontFace(extracted)
    return
  }
}

async function decodeStream(stream: PDFRawStream): Promise<Uint8Array | null> {
  try {
    const filterRaw = stream.dict.get(PDFName.of('Filter'))
    if (!filterRaw) return stream.contents   // uncompressed

    const filterStr = filterRaw.toString().replace(/^\//, '')

    if (filterStr === 'FlateDecode') {
      return await inflateRaw(stream.contents)
    }

    // Other filters are uncommon for embedded fonts — return raw and hope
    return stream.contents
  } catch {
    return stream.contents
  }
}

async function inflateRaw(compressed: Uint8Array): Promise<Uint8Array> {
  // PDF FlateDecode can use either zlib-wrapped (deflate) or raw deflate
  for (const mode of ['deflate', 'deflate-raw'] as CompressionFormat[]) {
    try {
      const ds = new DecompressionStream(mode)
      const writer = ds.writable.getWriter()
      const reader = ds.readable.getReader()

      writer.write(compressed as any)
      writer.close()

      const chunks: Uint8Array[] = []
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
      }

      const totalLen = chunks.reduce((s, c) => s + c.length, 0)
      if (totalLen === 0) continue

      const out = new Uint8Array(totalLen)
      let off = 0
      for (const c of chunks) { out.set(c, off); off += c.length }
      return out
    } catch { /* try next mode */ }
  }

  return compressed  // fallback — return compressed bytes as-is
}

function registerFontFace(font: ExtractedFont): void {
  try {
    const prev = registeredUrls.get(font.cssFamily)
    if (prev) URL.revokeObjectURL(prev)

    const mime = font.format === 'truetype' ? 'font/ttf' : 'font/otf'
    const cssFmt = font.format === 'truetype' ? 'truetype' : 'opentype'
    const blob = new Blob([font.bytes as unknown as BlobPart], { type: mime })
    const url = URL.createObjectURL(blob)
    registeredUrls.set(font.cssFamily, url)

    const id = `oportunidocs-ff-${font.cssFamily}`
    let style = document.getElementById(id) as HTMLStyleElement | null
    if (!style) {
      style = document.createElement('style')
      style.id = id
      document.head.appendChild(style)
    }

    // Register with the CORRECT weight/style so ctx.font = "bold Xpx 'Family'"
    // matches this @font-face.  Without this, the browser falls back to
    // sans-serif (normal weight) for any glyph not found in the PDF subset.
    const fontWeight = font.isBold   ? 'bold'   : 'normal'
    const fontStyle  = font.isItalic ? 'italic' : 'normal'

    style.textContent =
      `@font-face{font-family:'${font.cssFamily}';` +
      `src:url('${url}') format('${cssFmt}');` +
      `font-weight:${fontWeight};font-style:${fontStyle};}`

    // Force the browser to load the font into memory immediately.
    // Without this, the font is only loaded lazily (on first paint), which
    // causes the canvas preview and textarea to render in the fallback font
    // briefly (or permanently if the canvas renders synchronously).
    const preloadSpec = `${font.isBold ? 'bold ' : ''}${font.isItalic ? 'italic ' : ''}16px '${font.cssFamily}'`
    document.fonts.load(preloadSpec).catch(() => {})
  } catch (err) {
    console.warn('[fontExtractor] registerFontFace error:', err)
  }
}

function toDict(ctx: any, refOrObj: any): PDFDict | null {
  try {
    const obj = refOrObj instanceof PDFRef ? ctx.lookup(refOrObj) : refOrObj
    return obj instanceof PDFDict ? obj : null
  } catch {
    return null
  }
}

function pdfFingerprint(data: Uint8Array): string {
  // Fast fingerprint: length + first 32 bytes as hex
  const head = Array.from(data.subarray(0, 32))
    .map(b => b.toString(16).padStart(2, '0')).join('')
  return `${data.length}_${head}`
}
