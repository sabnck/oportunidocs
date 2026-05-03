/**
 * Local API server. Runs inside the Electron process.
 * Exposes the editor via http://localhost:47411
 * Also serves the REST API at /api/*
 */

import express from 'express'
import cors from 'cors'
import multer from 'multer'
import { join } from 'path'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib'
import { Server } from 'http'

const PORT = 47411
let server: Server | null = null

const storage = multer.memoryStorage()
const upload = multer({ storage, limits: { fileSize: 200 * 1024 * 1024 } })

export function startLocalServer() {
  const appExpress = express()

  appExpress.use(cors())
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
  router.post('/pdf/merge', upload.array('files'), async (req, res) => {
    try {
      const files = req.files as Express.Multer.File[]
      if (!files || files.length < 2) {
        return res.status(400).json({ error: 'Send at least 2 PDF files' })
      }

      const merged = await PDFDocument.create()
      for (const file of files) {
        const pdf = await PDFDocument.load(file.buffer)
        const pages = await merged.copyPages(pdf, pdf.getPageIndices())
        pages.forEach(p => merged.addPage(p))
      }

      const bytes = await merged.save()
      res.set('Content-Type', 'application/pdf')
      res.set('Content-Disposition', 'attachment; filename="merged.pdf"')
      res.send(Buffer.from(bytes))
    } catch (e: any) {
      res.status(500).json({ error: e.message })
    }
  })

  /** POST /api/pdf/split. Split PDF by page range. */
  router.post('/pdf/split', upload.single('file'), async (req, res) => {
    try {
      const file = req.file
      if (!file) return res.status(400).json({ error: 'No file provided' })

      const { from = 1, to } = req.body
      const source = await PDFDocument.load(file.buffer)
      const total = source.getPageCount()
      const pageFrom = Math.max(0, Number(from) - 1)
      const pageTo = Math.min(total - 1, Number(to ?? total) - 1)

      const newDoc = await PDFDocument.create()
      const indices = Array.from({ length: pageTo - pageFrom + 1 }, (_, i) => pageFrom + i)
      const pages = await newDoc.copyPages(source, indices)
      pages.forEach(p => newDoc.addPage(p))

      const bytes = await newDoc.save()
      res.set('Content-Type', 'application/pdf')
      res.set('Content-Disposition', 'attachment; filename="split.pdf"')
      res.send(Buffer.from(bytes))
    } catch (e: any) {
      res.status(500).json({ error: e.message })
    }
  })

  /** POST /api/pdf/metadata. Get metadata. */
  router.post('/pdf/metadata', upload.single('file'), async (req, res) => {
    try {
      const file = req.file
      if (!file) return res.status(400).json({ error: 'No file provided' })

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
      res.status(500).json({ error: e.message })
    }
  })

  /** POST /api/pdf/set-metadata. Update metadata and return PDF. */
  router.post('/pdf/set-metadata', upload.single('file'), async (req, res) => {
    try {
      const file = req.file
      if (!file) return res.status(400).json({ error: 'No file provided' })

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
      res.status(500).json({ error: e.message })
    }
  })

  /** POST /api/pdf/extract-pages. Extract specific pages. */
  router.post('/pdf/extract-pages', upload.single('file'), async (req, res) => {
    try {
      const file = req.file
      if (!file) return res.status(400).json({ error: 'No file provided' })

      const { pages } = req.body
      const pageIndices: number[] = JSON.parse(pages || '[]').map((n: number) => n - 1)

      const source = await PDFDocument.load(file.buffer)
      const newDoc = await PDFDocument.create()
      const copied = await newDoc.copyPages(source, pageIndices)
      copied.forEach(p => newDoc.addPage(p))

      const bytes = await newDoc.save()
      res.set('Content-Type', 'application/pdf')
      res.set('Content-Disposition', 'attachment; filename="extracted.pdf"')
      res.send(Buffer.from(bytes))
    } catch (e: any) {
      res.status(500).json({ error: e.message })
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
