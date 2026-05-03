import { PDFDocument } from 'pdf-lib'
import * as PDFJS from 'pdfjs-dist'

export type SourceKind = 'pdf' | 'image'
export type ExportFormat = 'pdf' | 'png' | 'jpeg'

export const SUPPORTED_OPEN_ACCEPT = '.pdf,application/pdf,image/png,image/jpeg,image/jpg,image/webp'

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp'])
const EXPORT_EXTENSIONS: Record<ExportFormat, string> = {
  pdf: 'pdf',
  png: 'png',
  jpeg: 'jpg'
}

if (!PDFJS.GlobalWorkerOptions.workerSrc) {
  PDFJS.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url
  ).toString()
}

export function getExtension(name = '') {
  const clean = name.split(/[?#]/)[0]
  const match = /\.([a-z0-9]+)$/i.exec(clean)
  return match ? match[1].toLowerCase() : ''
}

export function getBaseName(name = 'document') {
  const fileName = name.split(/[\\/]/).pop() || 'document'
  return fileName.replace(/\.[^.]+$/, '') || 'document'
}

export function isSupportedInput(name: string, mimeType = '') {
  if (mimeType === 'application/pdf') return true
  const ext = getExtension(name)
  return ext === 'pdf' || IMAGE_EXTENSIONS.has(ext)
}

function detectSourceKind(name: string, mimeType = ''): SourceKind {
  if (mimeType === 'image/png' || mimeType === 'image/jpeg' || mimeType === 'image/jpg' || mimeType === 'image/webp') return 'image'
  const ext = getExtension(name)
  return IMAGE_EXTENSIONS.has(ext) ? 'image' : 'pdf'
}

function mimeFromName(name: string, fallback = '') {
  if (fallback) return fallback
  switch (getExtension(name)) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'png':
      return 'image/png'
    case 'webp':
      return 'image/webp'
    case 'pdf':
      return 'application/pdf'
    default:
      return 'application/octet-stream'
  }
}

function bytesToDataUrl(bytes: Uint8Array, mimeType: string) {
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize)
    binary += String.fromCharCode(...chunk)
  }
  return `data:${mimeType};base64,${btoa(binary)}`
}

async function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new window.Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('Unable to load image file.'))
    image.src = dataUrl
  })
}

async function canvasToBytes(canvas: HTMLCanvasElement, mimeType: string, quality?: number) {
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(result => {
      if (result) resolve(result)
      else reject(new Error('Unable to export canvas.'))
    }, mimeType, quality)
  })
  return new Uint8Array(await blob.arrayBuffer())
}

async function imageToPngBytes(dataUrl: string, width: number, height: number) {
  const image = await loadImage(dataUrl)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas is not available.')
  ctx.drawImage(image, 0, 0, width, height)
  return canvasToBytes(canvas, 'image/png')
}

export async function createEditableDocumentFromBytes(input: {
  name: string
  data: Uint8Array
  mimeType?: string
}) {
  const mimeType = mimeFromName(input.name, input.mimeType)
  const sourceKind = detectSourceKind(input.name, mimeType)

  if (sourceKind === 'pdf') {
    return {
      name: input.name,
      data: input.data,
      sourceKind
    }
  }

  const dataUrl = bytesToDataUrl(input.data, mimeType)
  const image = await loadImage(dataUrl)
  const width = Math.max(1, image.naturalWidth || image.width)
  const height = Math.max(1, image.naturalHeight || image.height)
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([width, height])
  const embedded = mimeType === 'image/jpeg' || mimeType === 'image/jpg'
    ? await pdf.embedJpg(input.data)
    : mimeType === 'image/png'
      ? await pdf.embedPng(input.data)
      : await pdf.embedPng(await imageToPngBytes(dataUrl, width, height))

  page.drawImage(embedded, { x: 0, y: 0, width, height })
  pdf.setTitle(getBaseName(input.name))
  pdf.setCreator('OportuniDocs')
  pdf.setProducer('OportuniDocs')

  return {
    name: input.name,
    data: await pdf.save(),
    sourceKind
  }
}


export function chooseExportFormat(defaultFormat: ExportFormat): ExportFormat | null {
  const picked = window.prompt('Save as: pdf, png, or jpeg', defaultFormat)
  if (picked === null) return null
  const normalized = String(picked || defaultFormat).trim().toLowerCase()
  if (normalized === 'png') return 'png'
  if (normalized === 'jpg' || normalized === 'jpeg') return 'jpeg'
  return 'pdf'
}
export function defaultExportName(name: string, format: ExportFormat) {
  return `${getBaseName(name)}.${EXPORT_EXTENSIONS[format]}`
}

export function inferExportFormatFromPath(path: string): ExportFormat {
  const ext = getExtension(path)
  if (ext === 'png') return 'png'
  if (ext === 'jpg' || ext === 'jpeg') return 'jpeg'
  return 'pdf'
}

export function withExportExtension(path: string, format: ExportFormat) {
  const ext = getExtension(path)
  if (ext === 'pdf' || ext === 'png' || ext === 'jpg' || ext === 'jpeg') return path
  return `${path}.${EXPORT_EXTENSIONS[format]}`
}

export async function exportPdfPagesAsImages(
  pdfBytes: Uint8Array,
  format: Exclude<ExportFormat, 'pdf'>,
  baseName: string,
  scale = 3
) {
  const pdf = await PDFJS.getDocument({
    data: pdfBytes.slice(),
    disableAutoFetch: true,
    disableStream: false,
    isEvalSupported: false,
    useSystemFonts: true
  }).promise

  const mimeType = format === 'png' ? 'image/png' : 'image/jpeg'
  const extension = EXPORT_EXTENSIONS[format]
  const pages: Array<{ bytes: Uint8Array; name: string; mimeType: string; pageIndex: number }> = []

  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber)
      const viewport = page.getViewport({ scale })
      const canvas = document.createElement('canvas')
      canvas.width = Math.ceil(viewport.width)
      canvas.height = Math.ceil(viewport.height)
      const ctx = canvas.getContext('2d', { alpha: format === 'png' })
      if (!ctx) throw new Error('Canvas is not available.')

      if (format === 'jpeg') {
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, canvas.width, canvas.height)
      }

      await page.render({ canvasContext: ctx, viewport }).promise
      pages.push({
        bytes: await canvasToBytes(canvas, mimeType, format === 'jpeg' ? 0.92 : undefined),
        name: pdf.numPages > 1
          ? `${getBaseName(baseName)}-page-${String(pageNumber).padStart(2, '0')}.${extension}`
          : `${getBaseName(baseName)}.${extension}`,
        mimeType,
        pageIndex: pageNumber - 1
      })
    }
  } finally {
    await pdf.destroy()
  }

  return pages
}
