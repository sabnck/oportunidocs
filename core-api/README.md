# OportuniDocs Core API

Standalone REST API for PDF automation. Runs as a lightweight Node.js server.

Use it in CI/CD pipelines, backend automations, assistant integrations or any environment where you need PDF processing without a GUI.

## Start

```bash
npm install
npm start
# http://localhost:4000
```

Change port:

```bash
PORT=8080 npm start
```

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/status` | Health check |
| POST | `/api/pdf/info` | Page count, dimensions, metadata |
| POST | `/api/pdf/merge` | Merge multiple PDFs |
| POST | `/api/pdf/split` | Split by page range |
| POST | `/api/pdf/rotate` | Rotate pages |
| POST | `/api/pdf/delete-pages` | Remove specific pages |
| POST | `/api/pdf/extract-pages` | Extract specific pages |
| POST | `/api/pdf/metadata` | Read metadata |
| POST | `/api/pdf/set-metadata` | Update metadata |
| POST | `/api/pdf/watermark` | Add text watermark |
| POST | `/api/pdf/add-text` | Add text to a page |

All file endpoints use `multipart/form-data`. The response is either a PDF file or JSON.

## Examples

```bash
# Merge two PDFs
curl -X POST http://localhost:4000/api/pdf/merge \
  -F "files=@a.pdf" \
  -F "files=@b.pdf" \
  --output merged.pdf

# Rotate all pages 90 degrees
curl -X POST http://localhost:4000/api/pdf/rotate \
  -F "file=@doc.pdf" \
  -F "angle=90" \
  --output rotated.pdf

# Add watermark
curl -X POST http://localhost:4000/api/pdf/watermark \
  -F "file=@doc.pdf" \
  -F "text=DRAFT" \
  -F "opacity=0.25" \
  --output watermarked.pdf

# Get document info
curl -X POST http://localhost:4000/api/pdf/info \
  -F "file=@doc.pdf"
```
