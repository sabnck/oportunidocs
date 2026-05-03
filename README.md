<p align="center">
  <a href="./README.md">English</a> |
  <a href="./README.pt-BR.md">Português do Brasil</a>
</p>

# OportuniDocs

OportuniDocs is a local-first document editor for PDFs, scanned documents and everyday paperwork. It is designed for people who need to edit, sign, organize and save documents without uploading private files to random online services.

The project includes a desktop version, a browser-accessible local interface, a local REST API and a browser extension.

Certified by Henrique Fernandes | StudioElevatio.com

## Why this exists

Many document tools are either expensive, limited, cloud-only or confusing for people who just need to fix a document and move on. OportuniDocs keeps the work on the user's machine and focuses on practical document workflows.

It is useful for resumes, contracts, declarations, forms, certificates, scanned pages, screenshots converted to PDF and other files that people handle every day.

## Main Features

**Edit PDF text visually**

Select detected text areas, edit the content, adjust font size, style, color and spacing, then save the corrected document.

**Work with scanned documents and images**

OCR support detects text in scanned pages and image-based documents with Tesseract.js. OCR runs locally after the required language data is available; the first use may need to download Tesseract language files.

**Annotate and sign**

Add text, highlights, underlines, strikethroughs, drawings, shapes, comments, stamps and signatures.

**Manage pages**

Reorder pages, rotate pages, duplicate pages, delete pages, merge PDFs and split documents by page range.

**Improve scanned pages**

The app includes a local scan enhancement utility for contrast, grayscale cleanup and page readability.

**Local API**

When the desktop app is running, a REST API is available at `http://localhost:47411/api` for automation and integrations.

**Browser extension**

The Chrome and Edge extension can send PDF links or the active PDF tab to the local editor through a context menu and popup.

## Privacy

OportuniDocs is built around local processing.

- Documents are not uploaded by the editor.
- OCR runs locally in the browser or desktop app after language data is available.
- The local API is bound to `127.0.0.1` and uses a browser-origin allowlist.
- The browser extension only requests access to the local app endpoint.
- No telemetry is collected by this project.
- The user stays responsible for files they export, share or upload elsewhere.

## Project Structure

```text
oportunidocs/
|- app-desktop/       Electron, React and TypeScript desktop app
|- core-api/          Standalone REST API for document automation
`- extension-web/     Chrome and Edge extension
```

## Requirements

- Node.js 20 or newer
- npm
- Windows for the packaged desktop build
- Chrome or Edge for the optional browser extension

## Run Locally

```bash
git clone https://github.com/sabnck/oportunidocs.git
cd oportunidocs/app-desktop
npm install
npm run dev
```

The desktop app opens in development mode.

## Build The Local Version

From `app-desktop/`:

```bash
npm run build
```

To create a Windows installer and a portable build:

```bash
npm run build:win
```

The generated files are created in the Electron build output folder. Installers and binaries are intentionally ignored by Git.

## Use The Browser Interface

Start the desktop app, then open the local browser interface provided by the app. The browser UI talks to the local app and keeps document processing on your machine.

## Local API

When the desktop app is running, the API is available at:

```text
http://localhost:47411/api
```

Common endpoints:

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/api/status` | Check if the app is running |
| POST | `/api/pdf/merge` | Merge multiple PDF files |
| POST | `/api/pdf/split` | Split a PDF by page range |
| POST | `/api/pdf/metadata` | Read document metadata |
| POST | `/api/pdf/set-metadata` | Update document metadata |
| POST | `/api/pdf/extract-pages` | Extract selected pages |

Example:

```bash
curl -X POST http://localhost:47411/api/pdf/merge \
  -F "files=@document1.pdf" \
  -F "files=@document2.pdf" \
  --output merged.pdf
```

## Install The Browser Extension

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable developer mode.
3. Choose "Load unpacked".
4. Select the `extension-web/` folder.

After installation, right-click a PDF link or use the extension popup to open documents in OportuniDocs. The extension does not inject a content script into every page.

## Development Notes

The app uses:

- Electron for the desktop shell.
- React and TypeScript for the interface.
- PDF.js for rendering.
- pdf-lib for PDF manipulation.
- Tesseract.js for local OCR.
- Zustand for state management.
- Tailwind CSS for styling.
- Express for the local API.

## Security

Please do not report vulnerabilities in public issues. Use GitHub private security advisories when possible. See [SECURITY.md](./SECURITY.md).

## Contributing

Issues and pull requests are welcome. Please read [CONTRIBUTING.md](./CONTRIBUTING.md) first so the discussion stays practical and easy to review.

## License

This repository is source-available for portfolio, review and learning purposes. Use, distribution and commercial rights are defined in [LICENSE](./LICENSE).

## Credits

OportuniDocs is built and maintained by Henrique Fernandes.

StudioElevatio.com
