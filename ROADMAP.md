# Roadmap

This document tracks what's planned for OportuniDocs.

---

## Version 1.0 - Current

The initial release covers the full editing workflow for individual users.

- PDF viewer with zoom and page navigation
- Annotations: text, highlight, underline, strikethrough, draw, shapes, stamps, comments
- Signature creation (draw or type) with saved slots
- Page management: reorder, rotate, duplicate, delete
- Merge multiple PDFs
- Split PDF by page range
- Document metadata editing
- Watermark support
- Visual text editing for detected PDF text
- Local OCR for scanned and image-based documents
- Scan enhancement for readability
- Local REST API at localhost:47411
- Chrome/Edge extension
- Browser mode (open editor in browser tab from the app)
- Windows installer and portable build

---

## Version 1.1 - Short term

- **Form filling**: detect and fill PDF form fields (text, checkbox, radio, dropdown)
- **Text search**: find text across all pages in the current document
- **Zoom to fit**: fit page width, fit page height
- **Export to image**: export pages as PNG or JPG
- **Bookmarks panel**: view and navigate document outline
- **MacOS and Linux builds**

---

## Version 1.2 - Medium term

- **Page numbering**: add configurable page number headers/footers
- **Multiple windows**: open more than one document in separate windows
- **Keyboard shortcut reference**: built-in shortcut guide
- **Auto-save**: configurable autosave interval
- **Recent files**: persistent recent documents list across sessions
- **Print**: print document directly from the app

---

## Version 2.0 - Long term

- **Digital signatures**: cryptographically valid PDF signatures with certificate support
- **Redaction**: permanently remove sensitive text and images
- **Comparison**: side-by-side diff of two PDF versions
- **Template system**: create reusable document templates
- **Plugin API**: allow third-party plugins to extend the editor
- **Optional cloud sync**: encrypted document sync between devices (opt-in, self-hosted or paid)
- **Collaboration**: shared annotations with real-time sync (opt-in)
- **API SDK**: official SDKs for Python, Node.js, and TypeScript

---

## Possible future exploration

These areas are not part of the active roadmap, but may be explored much later depending on product direction and demand:

- Converting Word/Excel documents to PDF (use LibreOffice or similar)
- PDF/A compliance validation
- Print-production features (color profiles, bleeds, etc.)
- Mobile apps

---

*If you want to propose something, open an issue on GitHub.*
