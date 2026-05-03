import { spawn } from 'node:child_process'
import { PDFDocument } from 'pdf-lib'

const PORT = String(48000 + Math.floor(Math.random() * 1000))
const BASE_URL = `http://127.0.0.1:${PORT}`

const server = spawn(process.execPath, ['src/server.js'], {
  cwd: new URL('..', import.meta.url),
  env: { ...process.env, PORT },
  stdio: 'ignore',
  windowsHide: true
})

async function waitForServer() {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`Server exited early with code ${server.exitCode}`)
    }

    try {
      const response = await fetch(`${BASE_URL}/api/status`)
      if (response.ok) return
    } catch {
      await new Promise(resolve => setTimeout(resolve, 250))
    }
  }
  throw new Error('Timed out waiting for test server')
}

async function expectStatus(name, request, expectedStatus) {
  const response = await request()
  if (response.status !== expectedStatus) {
    const body = await response.text().catch(() => '')
    throw new Error(`${name}: expected HTTP ${expectedStatus}, got HTTP ${response.status}. ${body}`)
  }
  console.log(`PASS ${name} -> HTTP ${response.status}`)
}

async function createPdfBlob() {
  const pdf = await PDFDocument.create()
  pdf.addPage([200, 200])
  return new Blob([await pdf.save()], { type: 'application/pdf' })
}

function formWithFile(fileBlob, fields = {}) {
  const form = new FormData()
  form.append('file', fileBlob, 'document.pdf')
  for (const [key, value] of Object.entries(fields)) {
    form.append(key, String(value))
  }
  return form
}

function mergeForm(fileBlobs) {
  const form = new FormData()
  fileBlobs.forEach((fileBlob, index) => {
    form.append('files', fileBlob, `document-${index + 1}.pdf`)
  })
  return form
}

try {
  await waitForServer()

  const validPdf = await createPdfBlob()
  const fakePdf = new Blob(['not a pdf'], { type: 'application/pdf' })

  await expectStatus('status endpoint', () => fetch(`${BASE_URL}/api/status`), 200)
  await expectStatus('info without file', () => fetch(`${BASE_URL}/api/pdf/info`, { method: 'POST' }), 400)
  await expectStatus('merge without files', () => fetch(`${BASE_URL}/api/pdf/merge`, { method: 'POST' }), 400)
  await expectStatus('merge with one file', () => fetch(`${BASE_URL}/api/pdf/merge`, {
    method: 'POST',
    body: mergeForm([validPdf])
  }), 400)
  await expectStatus('info non-pdf bytes', () => fetch(`${BASE_URL}/api/pdf/info`, {
    method: 'POST',
    body: formWithFile(fakePdf)
  }), 400)
  await expectStatus('extract without pages', () => fetch(`${BASE_URL}/api/pdf/extract-pages`, {
    method: 'POST',
    body: formWithFile(validPdf)
  }), 400)
  await expectStatus('extract malformed pages', () => fetch(`${BASE_URL}/api/pdf/extract-pages`, {
    method: 'POST',
    body: formWithFile(validPdf, { pages: 'not-json' })
  }), 400)
  await expectStatus('split from greater than to', () => fetch(`${BASE_URL}/api/pdf/split`, {
    method: 'POST',
    body: formWithFile(validPdf, { from: 2, to: 1 })
  }), 400)
  await expectStatus('split out of range', () => fetch(`${BASE_URL}/api/pdf/split`, {
    method: 'POST',
    body: formWithFile(validPdf, { from: 1, to: 99 })
  }), 400)
  await expectStatus('delete every page', () => fetch(`${BASE_URL}/api/pdf/delete-pages`, {
    method: 'POST',
    body: formWithFile(validPdf, { pages: '[1]' })
  }), 400)
  await expectStatus('watermark invalid opacity', () => fetch(`${BASE_URL}/api/pdf/watermark`, {
    method: 'POST',
    body: formWithFile(validPdf, { opacity: 2 })
  }), 400)
} finally {
  server.kill()
}
