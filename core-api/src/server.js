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
import fontkit from '@pdf-lib/fontkit'
import { readFileSync } from 'fs'

const PORT = process.env.PORT || 4000
const app = express()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } })

app.use(cors())
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

// ── PDF info ──────────────────────────────────────────────────────────────

app.post('/api/pdf/info', upload.single('file'), async (req, res) => {
  try {
    const pdf = await PDFDocument.load(req.file.buffer)
    res.json({
      pageCount: pdf.getPageCount(),
      title: pdf.getTitle() ?? null,
      author: pdf.getAuthor() ?? null,
      subject: pdf.getSubject() ?? null,
      keywords: pdf.getKeywords() ?? null,
      creator: pdf.getCreator() ?? null,
      producer: pdf.getProducer() ?? null,
      fileSize: req.file.size,
      pages: pdf.getPages().map((p, i) => {
        const { width, height } = p.getSize()
        return { index: i, width, height, rotation: p.getRotation().angle }
      })
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── Merge ─────────────────────────────────────────────────────────────────

app.post('/api/pdf/merge', upload.array('files'), async (req, res) => {
  try {
    const files = req.files
    if (!files || files.length < 2) {
      return res.status(400).json({ error: 'Provide at least 2 PDF files in the "files" field' })
    }

    const merged = await PDFDocument.create()
    for (const file of files) {
      const pdf = await PDFDocument.load(file.buffer)
      const pages = await merged.copyPages(pdf, pdf.getPageIndices())
      pages.forEach(p => merged.addPage(p))
    }

    stamp(merged)
    const bytes = await merged.save()
    sendPDF(res, bytes, 'merged.pdf')
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── Split ─────────────────────────────────────────────────────────────────

app.post('/api/pdf/split', upload.single('file'), async (req, res) => {
  try {
    const { from = '1', to } = req.body
    const source = await PDFDocument.load(req.file.buffer)
    const total = source.getPageCount()

    const pageFrom = Math.max(0, parseInt(from) - 1)
    const pageTo = Math.min(total - 1, parseInt(to ?? String(total)) - 1)

    const doc = await PDFDocument.create()
    const indices = Array.from({ length: pageTo - pageFrom + 1 }, (_, i) => pageFrom + i)
    const pages = await doc.copyPages(source, indices)
    pages.forEach(p => doc.addPage(p))

    stamp(doc)
    const bytes = await doc.save()
    sendPDF(res, bytes, 'split.pdf')
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── Rotate ────────────────────────────────────────────────────────────────

app.post('/api/pdf/rotate', upload.single('file'), async (req, res) => {
  try {
    const { angle = '90', pages: pagesParam } = req.body
    const pdf = await PDFDocument.load(req.file.buffer)
    const allPages = pdf.getPages()
    const total = allPages.length

    let indices
    if (pagesParam) {
      indices = JSON.parse(pagesParam).map(n => n - 1)
    } else {
      indices = Array.from({ length: total }, (_, i) => i)
    }

    indices.forEach(i => {
      if (allPages[i]) {
        const current = allPages[i].getRotation().angle
        allPages[i].setRotation(degrees((current + parseInt(angle)) % 360))
      }
    })

    stamp(pdf)
    const bytes = await pdf.save()
    sendPDF(res, bytes, 'rotated.pdf')
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── Delete pages ──────────────────────────────────────────────────────────

app.post('/api/pdf/delete-pages', upload.single('file'), async (req, res) => {
  try {
    const { pages: pagesParam } = req.body
    const toDelete = new Set(JSON.parse(pagesParam).map(n => n - 1))

    const source = await PDFDocument.load(req.file.buffer)
    const total = source.getPageCount()
    const keep = Array.from({ length: total }, (_, i) => i).filter(i => !toDelete.has(i))

    const doc = await PDFDocument.create()
    const pages = await doc.copyPages(source, keep)
    pages.forEach(p => doc.addPage(p))

    stamp(doc)
    const bytes = await doc.save()
    sendPDF(res, bytes, 'modified.pdf')
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── Extract pages ─────────────────────────────────────────────────────────

app.post('/api/pdf/extract-pages', upload.single('file'), async (req, res) => {
  try {
    const { pages: pagesParam } = req.body
    const indices = JSON.parse(pagesParam).map(n => n - 1)

    const source = await PDFDocument.load(req.file.buffer)
    const doc = await PDFDocument.create()
    const pages = await doc.copyPages(source, indices)
    pages.forEach(p => doc.addPage(p))

    stamp(doc)
    const bytes = await doc.save()
    sendPDF(res, bytes, 'extracted.pdf')
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── Metadata (read) ───────────────────────────────────────────────────────

app.post('/api/pdf/metadata', upload.single('file'), async (req, res) => {
  try {
    const pdf = await PDFDocument.load(req.file.buffer)
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
    res.status(500).json({ error: e.message })
  }
})

// ── Metadata (set) ────────────────────────────────────────────────────────

app.post('/api/pdf/set-metadata', upload.single('file'), async (req, res) => {
  try {
    const { title, author, subject, keywords } = req.body
    const pdf = await PDFDocument.load(req.file.buffer)

    if (title !== undefined) pdf.setTitle(title)
    if (author !== undefined) pdf.setAuthor(author)
    if (subject !== undefined) pdf.setSubject(subject)
    if (keywords !== undefined) pdf.setKeywords([keywords])
    stamp(pdf)

    const bytes = await pdf.save()
    sendPDF(res, bytes, 'updated.pdf')
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── Watermark ─────────────────────────────────────────────────────────────

app.post('/api/pdf/watermark', upload.single('file'), async (req, res) => {
  try {
    const { text = 'CONFIDENTIAL', opacity = '0.3', angle = '45', color = '#808080' } = req.body

    const pdf = await PDFDocument.load(req.file.buffer)
    const font = await pdf.embedFont(StandardFonts.HelveticaBold)

    const [r, g, b] = hexToRgb(color)

    for (const page of pdf.getPages()) {
      const { width, height } = page.getSize()
      page.drawText(text, {
        x: width / 2 - text.length * 18,
        y: height / 2,
        size: 60,
        font,
        color: rgb(r, g, b),
        opacity: parseFloat(opacity),
        rotate: degrees(parseInt(angle))
      })
    }

    stamp(pdf)
    const bytes = await pdf.save()
    sendPDF(res, bytes, 'watermarked.pdf')
  } catch (e) {
    res.status(500).json({ error: e.message })
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

    const pdf = await PDFDocument.load(req.file.buffer)
    const font = await pdf.embedFont(StandardFonts.Helvetica)
    const pages = pdf.getPages()
    const page = pages[parseInt(pageNum) - 1]

    if (!page) return res.status(400).json({ error: `Page ${pageNum} not found` })

    const [r, g, b] = hexToRgb(color)
    const { height } = page.getSize()

    page.drawText(text, {
      x: parseFloat(x),
      y: height - parseFloat(y),
      size: parseFloat(size),
      font,
      color: rgb(r, g, b)
    })

    stamp(pdf)
    const bytes = await pdf.save()
    sendPDF(res, bytes, 'modified.pdf')
  } catch (e) {
    res.status(500).json({ error: e.message })
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

app.listen(PORT, () => {
  console.log(`OportuniDocs API running at http://localhost:${PORT}`)
  console.log(`  docs → http://localhost:${PORT}/`)
})
