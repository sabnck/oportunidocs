import * as PDFJS from 'pdfjs-dist'
import { createWorker, PSM } from 'tesseract.js'
import type { Annotation } from '../store/pdfStore'
import type { EditableTextBlock } from './documentModel'

if (!PDFJS.GlobalWorkerOptions.workerSrc) {
  PDFJS.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url
  ).toString()
}

type ProgressCallback = (message: string) => void

type OcrLine = {
  text: string
  confidence: number
  bbox: { x0: number; y0: number; x1: number; y1: number }
}

type OcrPageResult = {
  canvas: HTMLCanvasElement
  lines: OcrLine[]
  ocrScale: number
  pageWidthPdf: number
  pageHeightPdf: number
}

function cleanOcrText(text: string) {
  return String(text || '').replace(/\s+/g, ' ').trim()
}

function bboxOf(raw: any): OcrLine['bbox'] | null {
  const bbox = raw?.bbox ?? raw
  const x0 = Number(bbox?.x0 ?? bbox?.left ?? bbox?.x)
  const y0 = Number(bbox?.y0 ?? bbox?.top ?? bbox?.y)
  const x1 = Number(bbox?.x1 ?? (Number.isFinite(x0) ? x0 + Number(bbox?.width ?? 0) : NaN))
  const y1 = Number(bbox?.y1 ?? (Number.isFinite(y0) ? y0 + Number(bbox?.height ?? 0) : NaN))
  if (![x0, y0, x1, y1].every(Number.isFinite)) return null
  if (x1 <= x0 || y1 <= y0) return null
  return { x0, y0, x1, y1 }
}

function collectLines(data: any): OcrLine[] {
  const directLines = Array.isArray(data?.lines) ? data.lines : []
  const fromBlocks = Array.isArray(data?.blocks)
    ? data.blocks.flatMap((block: any) =>
        (block.paragraphs ?? []).flatMap((paragraph: any) => paragraph.lines ?? [])
      )
    : []

  const candidates = directLines.length ? directLines : fromBlocks
  const lines = candidates
    .map((line: any) => {
      const text = cleanOcrText(line?.text)
      const bbox = bboxOf(line)
      const confidence = Number(line?.confidence ?? 0)
      if (!text || !bbox) return null
      return { text, bbox, confidence }
    })
    .filter(Boolean) as OcrLine[]

  if (lines.length) return lines

  const words = Array.isArray(data?.words) ? data.words : []
  return words
    .map((word: any) => {
      const text = cleanOcrText(word?.text)
      const bbox = bboxOf(word)
      const confidence = Number(word?.confidence ?? 0)
      if (!text || !bbox) return null
      return { text, bbox, confidence }
    })
    .filter(Boolean) as OcrLine[]
}

function sampleBackground(canvas: HTMLCanvasElement, bbox: OcrLine['bbox']) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return '#ffffff'

  const x0 = Math.max(0, Math.floor(bbox.x0))
  const y0 = Math.max(0, Math.floor(bbox.y0))
  const x1 = Math.min(canvas.width - 1, Math.ceil(bbox.x1))
  const y1 = Math.min(canvas.height - 1, Math.ceil(bbox.y1))
  const probes = [
    [x0 - 3, y0 - 3],
    [x1 + 3, y0 - 3],
    [x0 - 3, y1 + 3],
    [x1 + 3, y1 + 3],
    [x0 - 6, Math.round((y0 + y1) / 2)],
    [x1 + 6, Math.round((y0 + y1) / 2)]
  ]

  const samples: Array<{ r: number; g: number; b: number }> = []
  for (const [rawX, rawY] of probes) {
    const x = Math.max(0, Math.min(canvas.width - 1, rawX))
    const y = Math.max(0, Math.min(canvas.height - 1, rawY))
    const [r, g, b] = ctx.getImageData(x, y, 1, 1).data
    samples.push({ r, g, b })
  }

  samples.sort((a, b) => (b.r + b.g + b.b) - (a.r + a.g + a.b))
  const top = samples.slice(0, 3)
  const avg = top.reduce((acc, px) => ({ r: acc.r + px.r, g: acc.g + px.g, b: acc.b + px.b }), { r: 0, g: 0, b: 0 })
  const toHex = (value: number) => Math.max(0, Math.min(255, Math.round(value / top.length))).toString(16).padStart(2, '0')
  return `#${toHex(avg.r)}${toHex(avg.g)}${toHex(avg.b)}`
}

async function createOcrWorker(onProgress?: ProgressCallback) {
  const options = {
    logger: (m: any) => {
      if (!onProgress) return
      if (m?.status) {
        const percent = Number.isFinite(m.progress) ? ` ${Math.round(m.progress * 100)}%` : ''
        onProgress(`${m.status}${percent}`)
      }
    }
  }

  try {
    return await createWorker('por+eng', 1, options)
  } catch (error) {
    console.warn('[OCR] Portuguese+English worker failed, falling back to English:', error)
    return createWorker('eng', 1, options)
  }
}

async function recognizePage(input: {
  pdfData: Uint8Array
  pageIndex: number
  onProgress?: ProgressCallback
}): Promise<OcrPageResult> {
  input.onProgress?.('rendering page')
  const pdf = await PDFJS.getDocument({
    data: input.pdfData.slice(),
    disableAutoFetch: true,
    disableStream: false,
    isEvalSupported: false,
    useSystemFonts: true
  }).promise

  const ocrScale = 3
  const page = await pdf.getPage(input.pageIndex + 1)
  const viewport = page.getViewport({ scale: ocrScale })
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(viewport.width)
  canvas.height = Math.ceil(viewport.height)
  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) throw new Error('Canvas is not available for OCR.')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  await page.render({ canvasContext: ctx, viewport }).promise
  await pdf.destroy()

  input.onProgress?.('recognizing text')
  const worker = await createOcrWorker(input.onProgress)
  try {
    await (worker as any).setParameters?.({ tessedit_pageseg_mode: PSM.AUTO })
    const result = await (worker as any).recognize(canvas, {}, { blocks: true, text: true })
    const lines = collectLines(result?.data)
      .filter(line => line.confidence >= 35 || line.text.length >= 3)

    return {
      canvas,
      lines,
      ocrScale,
      pageWidthPdf: viewport.width / ocrScale,
      pageHeightPdf: viewport.height / ocrScale
    }
  } finally {
    await worker.terminate()
  }
}

export async function ocrPageToTextAnnotations(input: {
  pdfData: Uint8Array
  pageIndex: number
  displayZoom: number
  onProgress?: ProgressCallback
}): Promise<Annotation[]> {
  const { canvas, lines, ocrScale } = await recognizePage(input)
  const factor = input.displayZoom / ocrScale

  return lines.map(line => {
    const width = Math.max(12, (line.bbox.x1 - line.bbox.x0) * factor)
    const height = Math.max(10, (line.bbox.y1 - line.bbox.y0) * factor)
    const fontSize = Math.max(7, Math.min(36, height * 0.78))
    const padX = Math.max(1, fontSize * 0.12)
    const padY = Math.max(1, fontSize * 0.16)
    return {
      id: crypto.randomUUID(),
      type: 'text' as const,
      pageIndex: input.pageIndex,
      x: Math.max(0, line.bbox.x0 * factor - padX),
      y: Math.max(0, line.bbox.y0 * factor - padY),
      width: width + padX * 2,
      height: height + padY * 2,
      text: line.text,
      color: '#111111',
      backgroundColor: sampleBackground(canvas, line.bbox),
      fontSize,
      fontFamily: 'Arial',
      opacity: 1,
      isOcrText: true
    }
  })
}

export async function ocrPageToEditableBlocks(input: {
  pdfData: Uint8Array
  pageIndex: number
  displayZoom: number
  onProgress?: ProgressCallback
}): Promise<EditableTextBlock[]> {
  const { canvas, lines, ocrScale, pageHeightPdf } = await recognizePage(input)
  const factor = input.displayZoom / ocrScale

  return lines.map(line => {
    const rawWidthVp = Math.max(12, (line.bbox.x1 - line.bbox.x0) * factor)
    const rawHeightVp = Math.max(10, (line.bbox.y1 - line.bbox.y0) * factor)
    const fontSizeVp = Math.max(7, Math.min(44, rawHeightVp * 0.78))
    const padX = Math.max(1, fontSizeVp * 0.12)
    const padY = Math.max(1, fontSizeVp * 0.16)
    const vpX = Math.max(0, line.bbox.x0 * factor - padX)
    const vpY = Math.max(0, line.bbox.y0 * factor - padY)
    const vpWidth = rawWidthVp + padX * 2
    const vpHeight = rawHeightVp + padY * 2
    const baselineVp = Math.max(vpY + fontSizeVp, line.bbox.y1 * factor - fontSizeVp * 0.18)
    const pdfFontSize = fontSizeVp / input.displayZoom
    const pdfLineHeight = Math.max(pdfFontSize, (vpHeight / input.displayZoom) * 1.05)
    const bgColor = sampleBackground(canvas, line.bbox)

    return {
      id: crypto.randomUUID(),
      pageIndex: input.pageIndex,
      kind: 'textOverImage',
      text: line.text,
      lineCount: 1,
      confidence: Math.max(0, Math.min(1, line.confidence / 100)),
      visualContext: {
        backgroundType: 'image',
        backgroundComplexity: 'medium',
        requiresReconstruction: true,
        source: 'sampled'
      },
      rawItems: [],
      vpX,
      vpY,
      vpWidth,
      vpHeight,
      vpBaselineY: baselineVp,
      vpFontSize: fontSizeVp,
      pdfX: vpX / input.displayZoom,
      pdfY: pageHeightPdf - (baselineVp / input.displayZoom),
      pdfWidth: vpWidth / input.displayZoom,
      pdfFontSize,
      fontName: 'OCR',
      fontDisplayName: 'OCR',
      pdfBaseFontName: 'Helvetica',
      cssFontFamily: 'Arial, Helvetica, sans-serif',
      color: '#111111',
      bgColor,
      sampledBgColor: bgColor,
      bgRect: null,
      bgRectKey: null,
      layoutMode: 'free',
      textAlign: 'left',
      trackingMode: 'normal',
      letterSpacingEm: 0,
      isBold: false,
      isItalic: false,
      pdfLineHeight,
      lineHeightVp: pdfLineHeight * input.displayZoom,
      layoutLocked: true,
      fontSizeScale: 1,
      positionOffsetXPdf: 0,
      positionOffsetYPdf: 0,
      boxWidthScale: 1,
      boxHeightScale: 1,
      fitScale: 1
    }
  })
}
