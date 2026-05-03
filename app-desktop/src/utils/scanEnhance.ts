import * as PDFJS from 'pdfjs-dist'
import { PDFDocument } from 'pdf-lib'

if (!PDFJS.GlobalWorkerOptions.workerSrc) {
  PDFJS.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url
  ).toString()
}

type ProgressCallback = (message: string) => void

function clampByte(value: number) {
  return Math.max(0, Math.min(255, Math.round(value)))
}

function enhanceCanvasForScan(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return

  const image = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const data = image.data
  for (let i = 0; i < data.length; i += 4) {
    const gray = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114
    let value = (gray - 128) * 1.38 + 138
    if (value > 232) value = 255
    if (value < 88) value *= 0.72
    const out = clampByte(value)
    data[i] = out
    data[i + 1] = out
    data[i + 2] = out
    data[i + 3] = 255
  }
  ctx.putImageData(image, 0, 0)
}

export async function enhancePdfScan(input: {
  pdfData: Uint8Array
  renderScale?: number
  onProgress?: ProgressCallback
}): Promise<Uint8Array> {
  const source = await PDFJS.getDocument({
    data: input.pdfData.slice(),
    disableAutoFetch: true,
    disableStream: false,
    isEvalSupported: false,
    useSystemFonts: true
  }).promise

  const out = await PDFDocument.create()
  const renderScale = Math.max(1.5, Math.min(3, input.renderScale ?? 2.5))

  try {
    for (let pageIndex = 0; pageIndex < source.numPages; pageIndex++) {
      input.onProgress?.(`Enhancing page ${pageIndex + 1}/${source.numPages}`)
      const page = await source.getPage(pageIndex + 1)
      const baseViewport = page.getViewport({ scale: 1 })
      const viewport = page.getViewport({ scale: renderScale })
      const canvas = document.createElement('canvas')
      canvas.width = Math.ceil(viewport.width)
      canvas.height = Math.ceil(viewport.height)
      const ctx = canvas.getContext('2d', { alpha: false })
      if (!ctx) throw new Error('Canvas is not available for scan enhancement.')
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      await page.render({ canvasContext: ctx, viewport }).promise
      enhanceCanvasForScan(canvas)

      const image = await out.embedPng(canvas.toDataURL('image/png'))
      const outPage = out.addPage([baseViewport.width, baseViewport.height])
      outPage.drawImage(image, {
        x: 0,
        y: 0,
        width: baseViewport.width,
        height: baseViewport.height
      })
    }
  } finally {
    await source.destroy()
  }

  return out.save()
}
