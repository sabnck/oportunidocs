/**
 * OportuniDocs Standalone Core API
 *
 * Run independently without the desktop app.
 * Useful for server automation, CI/CD pipelines, or headless environments.
 *
 * Usage:
 *   npm start
 *   PORT=8080 npm start
 *
 * API reference: http://localhost:4000/api-docs (when running)
 */

import express from 'express'
import cors from 'cors'
import multer from 'multer'
import { PDFDocument, rgb, StandardFonts, degrees } from 'pdf-lib'

const PORT = process.env.PORT || 4000
const HOST = process.env.HOST || '127.0.0.1'
const ALLOWED_ORIGINS = new Set([
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
  'http://localhost:47411',
  'http://127.0.0.1:47411',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  ...String(process.env.OPORTUNIDOCS_ALLOWED_ORIGINS || '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean)
])
const app = express()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } })

app.use(cors({
  origin(origin, callback) {
    if (!origin || ALLOWED_ORIGINS.has(origin) || /^chrome-extension:\/\/[a-z]{32}$/.test(origin)) {
      callback(null, true)
      return
    }
    callback(null, false)
  }
}))
app.use(express.json({ limit: '200mb' }))

// ── Root ──────────────────────────────────────────────────────────────────

app.get('/', (_, res) => {
  res.json({
    name: 'OportuniDocs API',
    version: '1.0.0',
    author: 'Henrique Fernandes',
    description: 'Local REST API for PDF manipulation',
    endpoints: [
      'GET  /api/status',
      'POST /api/pdf/info',
      'POST /api/pdf/merge',
      'POST /api/pdf/split',
      'POST /api/pdf/rotate',
      'POST /api/pdf/delete-pages',
      'POST /api/pdf/extract-pages',
      'POST /api/pdf/metadata',
      'POST /api/pdf/set-metadata',
      'POST /api/pdf/watermark',
      'POST /api/pdf/add-text',
    ]
  })
})

// ── Status ────────────────────────────────────────────────────────────────

app.get('/api/status', (_, res) => {
  res.json({ status: 'running', version: '1.0.0', name: 'OportuniDocs API' })
})

class ApiValidationError extends Error {
  constructor(message) {
    super(message)
    this.status = 400
  }
}

function requirePdfFile(req) {
  if (!req.file) throw new ApiValidationError('No file provided')
  if (!looksLikePdf(req.file.buffer)) {
    throw new ApiValidationError('File must be a PDF')
  }
  return req.file
}

function requirePdfUpload(file) {
  if (!file || !looksLikePdf(file.buffer)) {
    throw new ApiValidationError('All files must be PDFs')
  }
  return file
}

function looksLikePdf(buffer) {
  return buffer.subarray(0, 1024).toString('utf8').includes('%PDF-')
}

function parsePositiveInteger(value, field) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new ApiValidationError(`${field} must be a positive integer`)
  }
  return parsed
}

function parseNumber(value, field, { min = -Infinity, max = Infinity } = {}) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new ApiValidationError(`${field} must be a number between ${min} and ${max}`)
  }
  return parsed
}

function parsePageRange(from, to, totalPages) {
  const pageFrom = parsePositiveInteger(from ?? 1, 'from')
  const pageTo = parsePositiveInteger(to ?? totalPages, 'to')
  if (pageFrom > pageTo) throw new ApiValidationError('"from" must be less than or equal to "to"')
  if (pageTo > totalPages) throw new ApiValidationError(`Page range exceeds document page count (${totalPages})`)
  return Array.from({ length: pageTo - pageFrom + 1 }, (_, i) => pageFrom - 1 + i)
}

function parsePageList(value, totalPages, { defaultAll = false } = {}) {
  if ((value === undefined || value === null || value === '') && defaultAll) {
    return Array.from({ length: totalPages }, (_, i) => i)
  }
  if (value === undefined || value === null || value === '') {
    throw new ApiValidationError('pages is required')
  }

  let parsed
  try {
    parsed = typeof value === 'string' ? JSON.parse(value) : value
  } catch {
    throw new ApiValidationError('pages must be a JSON array of page numbers')
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new ApiValidationError('pages must contain at least one page number')
  }

  const unique = new Set()
  for (const item of parsed) {
    const page = parsePositiveInteger(item, 'pages')
    if (page > totalPages) throw new ApiValidationError(`Page ${page} exceeds document page count (${totalPages})`)
    unique.add(page - 1)
  }
  return Array.from(unique)
}

function parseRotationAngle(value) {
  const angle = Number(value ?? 90)
  if (!Number.isInteger(angle)) throw new ApiValidationError('angle must be an integer')
  return ((angle % 360) + 360) % 360
}

function sendError(res, error) {
  if (error instanceof ApiValidationError) {
    res.status(error.status).json({ error: error.message })
    return
  }
  res.status(500).json({ error: error instanceof Error ? error.message : 'Unexpected error' })
}

// ── PDF info ──────────────────────────────────────────────────────────────

app.post('/api/pdf/info', upload.single('file'), async (req, res) => {
  try {
    const file = requirePdfFile(req)
    const pdf = await PDFDocument.load(file.buffer)
    res.json({
      pageCount: pdf.getPageCount(),
      title: pdf.getTitle() ?? null,
      author: pdf.getAuthor() ?? null,
      subject: pdf.getSubject() ?? null,
      keywords: pdf.getKeywords() ?? null,
      creator: pdf.getCreator() ?? null,
      producer: pdf.getProducer() ?? null,
      fileSize: file.size,
      pages: pdf.getPages().map((p, i) => {
        const { width, height } = p.getSize()
        return { index: i, width, height, rotation: p.getRotation().angle }
      })
    })
  } catch (e) {
    sendError(res, e)
  }
})

// ── Merge ─────────────────────────────────────────────────────────────────

app.post('/api/pdf/merge', upload.array('files', 20), async (req, res) => {
  try {
    const files = req.files
    if (!files || files.length < 2) {
      return res.status(400).json({ error: 'Provide at least 2 PDF files in the "files" field' })
    }

    const merged = await PDFDocument.create()
    for (const file of files) {
      requirePdfUpload(file)
      const pdf = await PDFDocument.load(file.buffer)
      const pages = await merged.copyPages(pdf, pdf.getPageIndices())
      pages.forEach(p => merged.addPage(p))
    }

    stamp(merged)
    const bytes = await merged.save()
    sendPDF(res, bytes, 'merged.pdf')
  } catch (e) {
    sendError(res, e)
  }
})

// ── Split ─────────────────────────────────────────────────────────────────

app.post('/api/pdf/split', upload.single('file'), async (req, res) => {
  try {
    const { from = '1', to } = req.body
    const file = requirePdfFile(req)
    const source = await PDFDocument.load(file.buffer)
    const total = source.getPageCount()

    const doc = await PDFDocument.create()
    const indices = parsePageRange(from, to, total)
    const pages = await doc.copyPages(source, indices)
    pages.forEach(p => doc.addPage(p))

    stamp(doc)
    const bytes = await doc.save()
    sendPDF(res, bytes, 'split.pdf')
  } catch (e) {
    sendError(res, e)
  }
})

// ── Rotate ────────────────────────────────────────────────────────────────

app.post('/api/pdf/rotate', upload.single('file'), async (req, res) => {
  try {
    const { angle = '90', pages: pagesParam } = req.body
    const file = requirePdfFile(req)
    const pdf = await PDFDocument.load(file.buffer)
    const allPages = pdf.getPages()
    const total = allPages.length
    const indices = parsePageList(pagesParam, total, { defaultAll: true })
    const rotation = parseRotationAngle(angle)

    indices.forEach(i => {
      if (allPages[i]) {
        const current = allPages[i].getRotation().angle
        allPages[i].setRotation(degrees((current + rotation) % 360))
      }
    })

    stamp(pdf)
    const bytes = await pdf.save()
    sendPDF(res, bytes, 'rotated.pdf')
  } catch (e) {
    sendError(res, e)
  }
})

// ── Delete pages ──────────────────────────────────────────────────────────

app.post('/api/pdf/delete-pages', upload.single('file'), async (req, res) => {
  try {
    const { pages: pagesParam } = req.body
    const file = requirePdfFile(req)
    const source = await PDFDocument.load(file.buffer)
    const total = source.getPageCount()
    const toDelete = new Set(parsePageList(pagesParam, total))
    const keep = Array.from({ length: total }, (_, i) => i).filter(i => !toDelete.has(i))
    if (keep.length === 0) throw new ApiValidationError('Cannot delete every page')

    const doc = await PDFDocument.create()
    const pages = await doc.copyPages(source, keep)
    pages.forEach(p => doc.addPage(p))

    stamp(doc)
    const bytes = await doc.save()
    sendPDF(res, bytes, 'modified.pdf')
  } catch (e) {
    sendError(res, e)
  }
})

// ── Extract pages ─────────────────────────────────────────────────────────

app.post('/api/pdf/extract-pages', upload.single('file'), async (req, res) => {
  try {
    const { pages: pagesParam } = req.body
    const file = requirePdfFile(req)
    const source = await PDFDocument.load(file.buffer)
    const indices = parsePageList(pagesParam, source.getPageCount())
    const doc = await PDFDocument.create()
    const pages = await doc.copyPages(source, indices)
    pages.forEach(p => doc.addPage(p))

    stamp(doc)
    const bytes = await doc.save()
    sendPDF(res, bytes, 'extracted.pdf')
  } catch (e) {
    sendError(res, e)
  }
})

// ── Metadata (read) ───────────────────────────────────────────────────────

app.post('/api/pdf/metadata', upload.single('file'), async (req, res) => {
  try {
    const file = requirePdfFile(req)
    const pdf = await PDFDocument.load(file.buffer)
    res.json({
      title: pdf.getTitle() ?? '',
      author: pdf.getAuthor() ?? '',
      subject: pdf.getSubject() ?? '',
      keywords: pdf.getKeywords() ?? '',
      creator: pdf.getCreator() ?? '',
      producer: pdf.getProducer() ?? '',
      pageCount: pdf.getPageCount()
    })
  } catch (e) {
    sendError(res, e)
  }
})

// ── Metadata (set) ────────────────────────────────────────────────────────

app.post('/api/pdf/set-metadata', upload.single('file'), async (req, res) => {
  try {
    const { title, author, subject, keywords } = req.body
    const file = requirePdfFile(req)
    const pdf = await PDFDocument.load(file.buffer)

    if (title !== undefined) pdf.setTitle(String(title))
    if (author !== undefined) pdf.setAuthor(String(author))
    if (subject !== undefined) pdf.setSubject(String(subject))
    if (keywords !== undefined) pdf.setKeywords([String(keywords)])
    stamp(pdf)

    const bytes = await pdf.save()
    sendPDF(res, bytes, 'updated.pdf')
  } catch (e) {
    sendError(res, e)
  }
})

// ── Watermark ─────────────────────────────────────────────────────────────

app.post('/api/pdf/watermark', upload.single('file'), async (req, res) => {
  try {
    const { text = 'CONFIDENTIAL', opacity = '0.3', angle = '45', color = '#808080' } = req.body

    const file = requirePdfFile(req)
    const pdf = await PDFDocument.load(file.buffer)
    const font = await pdf.embedFont(StandardFonts.HelveticaBold)

    const [r, g, b] = hexToRgb(color)
    const parsedOpacity = parseNumber(opacity, 'opacity', { min: 0, max: 1 })
    const parsedAngle = parseNumber(angle, 'angle')
    const watermarkText = String(text).slice(0, 500)

    for (const page of pdf.getPages()) {
      const { width, height } = page.getSize()
      page.drawText(watermarkText, {
        x: width / 2 - watermarkText.length * 18,
        y: height / 2,
        size: 60,
        font,
        color: rgb(r, g, b),
        opacity: parsedOpacity,
        rotate: degrees(parsedAngle)
      })
    }

    stamp(pdf)
    const bytes = await pdf.save()
    sendPDF(res, bytes, 'watermarked.pdf')
  } catch (e) {
    sendError(res, e)
  }
})

// ── Add text ──────────────────────────────────────────────────────────────

app.post('/api/pdf/add-text', upload.single('file'), async (req, res) => {
  try {
    const {
      text = '',
      page: pageNum = '1',
      x = '50',
      y = '50',
      size = '12',
      color = '#000000'
    } = req.body

    const file = requirePdfFile(req)
    const pdf = await PDFDocument.load(file.buffer)
    const font = await pdf.embedFont(StandardFonts.Helvetica)
    const pages = pdf.getPages()
    const pageIndex = parsePositiveInteger(pageNum, 'page') - 1
    const page = pages[pageIndex]

    if (!page) throw new ApiValidationError(`Page ${pageNum} not found`)

    const [r, g, b] = hexToRgb(color)
    const { height } = page.getSize()
    const parsedX = parseNumber(x, 'x')
    const parsedY = parseNumber(y, 'y')
    const parsedSize = parseNumber(size, 'size', { min: 1, max: 300 })

    page.drawText(String(text).slice(0, 5000), {
      x: parsedX,
      y: height - parsedY,
      size: parsedSize,
      font,
      color: rgb(r, g, b)
    })

    stamp(pdf)
    const bytes = await pdf.save()
    sendPDF(res, bytes, 'modified.pdf')
  } catch (e) {
    sendError(res, e)
  }
})

// ── Helpers ───────────────────────────────────────────────────────────────

function stamp(pdf) {
  pdf.setCreator('OportuniDocs')
  pdf.setProducer('OportuniDocs API | github.com/sabnck/oportunidocs')
}

function sendPDF(res, bytes, filename = 'output.pdf') {
  res.set('Content-Type', 'application/pdf')
  res.set('Content-Disposition', `attachment; filename="${filename}"`)
  res.set('Content-Length', String(bytes.length))
  res.send(Buffer.from(bytes))
}

function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  return result
    ? [parseInt(result[1], 16) / 255, parseInt(result[2], 16) / 255, parseInt(result[3], 16) / 255]
    : [0, 0, 0]
}

// ── Start ─────────────────────────────────────────────────────────────────

app.listen(PORT, HOST, () => {
  console.log(`OportuniDocs API running at http://${HOST}:${PORT}`)
  console.log(`  docs -> http://${HOST}:${PORT}/`)
})
