/**
 * Local API server. Runs inside the Electron process.
 * Exposes the editor via http://localhost:47411
 * Also serves the REST API at /api/*
 */

import express from 'express'
import cors from 'cors'
import multer from 'multer'
import { join } from 'path'
import { existsSync } from 'fs'
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib'
import { Server } from 'http'

const PORT = 47411
let server: Server | null = null
const ALLOWED_ORIGINS = new Set([
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  ...String(process.env.OPORTUNIDOCS_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean)
])

const storage = multer.memoryStorage()
const upload = multer({ storage, limits: { fileSize: 200 * 1024 * 1024 } })

class ApiValidationError extends Error {
  status = 400
}

function corsOrigin(origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) {
  if (!origin || ALLOWED_ORIGINS.has(origin) || /^chrome-extension:\/\/[a-z]{32}$/.test(origin)) {
    callback(null, true)
    return
  }
  callback(null, false)
}

function looksLikePdf(buffer: Buffer) {
  return buffer.subarray(0, 1024).toString('utf8').includes('%PDF-')
}

function requirePdfFile(file: Express.Multer.File | undefined) {
  if (!file) throw new ApiValidationError('No file provided')
  if (!looksLikePdf(file.buffer)) {
    throw new ApiValidationError('File must be a PDF')
  }
  return file
}

function parsePositiveInteger(value: unknown, field: string) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new ApiValidationError(`${field} must be a positive integer`)
  }
  return parsed
}

function parsePageRange(from: unknown, to: unknown, totalPages: number) {
  const pageFrom = parsePositiveInteger(from ?? 1, 'from')
  const pageTo = parsePositiveInteger(to ?? totalPages, 'to')
  if (pageFrom > pageTo) throw new ApiValidationError('"from" must be less than or equal to "to"')
  if (pageTo > totalPages) throw new ApiValidationError(`Page range exceeds document page count (${totalPages})`)
  return Array.from({ length: pageTo - pageFrom + 1 }, (_, i) => pageFrom - 1 + i)
}

function parsePageList(value: unknown, totalPages: number) {
  if (value === undefined || value === null || value === '') {
    throw new ApiValidationError('pages is required')
  }

  let parsed: unknown
  try {
    parsed = typeof value === 'string' ? JSON.parse(value) : value
  } catch {
    throw new ApiValidationError('pages must be a JSON array of page numbers')
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new ApiValidationError('pages must contain at least one page number')
  }

  const unique = new Set<number>()
  for (const item of parsed) {
    const page = parsePositiveInteger(item, 'pages')
    if (page > totalPages) throw new ApiValidationError(`Page ${page} exceeds document page count (${totalPages})`)
    unique.add(page - 1)
  }
  return Array.from(unique)
}

function sendError(res: express.Response, error: unknown) {
  if (error instanceof ApiValidationError) {
    res.status(error.status).json({ error: error.message })
    return
  }
  const message = error instanceof Error ? error.message : 'Unexpected error'
  res.status(500).json({ error: message })
}

export function startLocalServer() {
  const appExpress = express()

  appExpress.use(cors({ origin: corsOrigin }))
  appExpress.use(express.json({ limit: '200mb' }))

  // Serve the renderer (for browser mode)
  const distPath = join(__dirname, '../renderer')
  if (existsSync(distPath)) {
    appExpress.use(express.static(distPath))
    appExpress.get('/', (_, res) => res.sendFile(join(distPath, 'index.html')))
  }

  // API Routes

  const router = express.Router()

  /** GET /api/status */
  router.get('/status', (_, res) => {
    res.json({ status: 'running', version: '1.0.0', name: 'OportuniDocs API' })
  })

  /** POST /api/pdf/merge. Merge multiple PDFs. */
  router.post('/pdf/merge', upload.array('files', 20), async (req, res) => {
    try {
      const files = req.files as Express.Multer.File[]
      if (!files || files.length < 2) {
        return res.status(400).json({ error: 'Send at least 2 PDF files' })
      }

      const merged = await PDFDocument.create()
      for (const file of files) {
        requirePdfFile(file)
        const pdf = await PDFDocument.load(file.buffer)
        const pages = await merged.copyPages(pdf, pdf.getPageIndices())
        pages.forEach(p => merged.addPage(p))
      }

      const bytes = await merged.save()
      res.set('Content-Type', 'application/pdf')
      res.set('Content-Disposition', 'attachment; filename="merged.pdf"')
      res.send(Buffer.from(bytes))
    } catch (e: any) {
      sendError(res, e)
    }
  })

  /** POST /api/pdf/split. Split PDF by page range. */
  router.post('/pdf/split', upload.single('file'), async (req, res) => {
    try {
      const file = requirePdfFile(req.file)

      const { from = 1, to } = req.body
      const source = await PDFDocument.load(file.buffer)
      const total = source.getPageCount()

      const newDoc = await PDFDocument.create()
      const indices = parsePageRange(from, to, total)
      const pages = await newDoc.copyPages(source, indices)
      pages.forEach(p => newDoc.addPage(p))

      const bytes = await newDoc.save()
      res.set('Content-Type', 'application/pdf')
      res.set('Content-Disposition', 'attachment; filename="split.pdf"')
      res.send(Buffer.from(bytes))
    } catch (e: any) {
      sendError(res, e)
    }
  })

  /** POST /api/pdf/metadata. Get metadata. */
  router.post('/pdf/metadata', upload.single('file'), async (req, res) => {
    try {
      const file = requirePdfFile(req.file)

      const pdf = await PDFDocument.load(file.buffer)
      const meta = {
        title: pdf.getTitle(),
        author: pdf.getAuthor(),
        subject: pdf.getSubject(),
        keywords: pdf.getKeywords(),
        creator: pdf.getCreator(),
        producer: pdf.getProducer(),
        pageCount: pdf.getPageCount()
      }
      res.json(meta)
    } catch (e: any) {
      sendError(res, e)
    }
  })

  /** POST /api/pdf/set-metadata. Update metadata and return PDF. */
  router.post('/pdf/set-metadata', upload.single('file'), async (req, res) => {
    try {
      const file = requirePdfFile(req.file)

      const { title, author, subject, keywords } = req.body
      const pdf = await PDFDocument.load(file.buffer)

      if (title) pdf.setTitle(title)
      if (author) pdf.setAuthor(author)
      if (subject) pdf.setSubject(subject)
      if (keywords) pdf.setKeywords([keywords])
      pdf.setCreator('OportuniDocs')
      pdf.setProducer('OportuniDocs por Henrique Fernandes | StudioElevatio.com')

      const bytes = await pdf.save()
      res.set('Content-Type', 'application/pdf')
      res.send(Buffer.from(bytes))
    } catch (e: any) {
      sendError(res, e)
    }
  })

  /** POST /api/pdf/extract-pages. Extract specific pages. */
  router.post('/pdf/extract-pages', upload.single('file'), async (req, res) => {
    try {
      const file = requirePdfFile(req.file)

      const { pages } = req.body

      const source = await PDFDocument.load(file.buffer)
      const pageIndices = parsePageList(pages, source.getPageCount())
      const newDoc = await PDFDocument.create()
      const copied = await newDoc.copyPages(source, pageIndices)
      copied.forEach(p => newDoc.addPage(p))

      const bytes = await newDoc.save()
      res.set('Content-Type', 'application/pdf')
      res.set('Content-Disposition', 'attachment; filename="extracted.pdf"')
      res.send(Buffer.from(bytes))
    } catch (e: any) {
      sendError(res, e)
    }
  })

  appExpress.use('/api', router)

  server = appExpress.listen(PORT, '127.0.0.1', () => {
    console.log(`[OportuniDocs] Local server running on http://localhost:${PORT}`)
  })

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`[OportuniDocs] Port ${PORT} already in use. API server disabled for this instance`)
      server = null
      // App continues to work via Electron IPC. HTTP server is only for browser mode.
    } else {
      console.error('[OportuniDocs] Server error:', err)
    }
  })
}

export function stopLocalServer() {
  if (server) {
    server.close()
    server = null
  }
}
