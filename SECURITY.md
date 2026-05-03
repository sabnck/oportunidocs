# Security

## Reporting a vulnerability

If you discover a security issue, please do not open a public GitHub issue.

Use GitHub private security advisories when possible. Please include enough detail for the issue to be reproduced and reviewed safely.

Include:
- Description of the vulnerability
- Steps to reproduce it
- Potential impact
- Any suggested fix, if you have one

You can expect a response within 72 hours. If the issue is confirmed, a fix will be released as soon as possible and you will be credited in the release notes (unless you prefer anonymity).

---

## Security model

OportuniDocs is local-first. Your documents never leave your machine unless you explicitly export and share them.

- No telemetry is collected
- No documents are uploaded anywhere
- The local API at `localhost:47411` only accepts connections from `127.0.0.1`
- The browser extension communicates only with the local app, not with external servers
- All PDF processing happens on your hardware using local libraries

---

## Known scope

The following are not considered security issues for this project:

- The local API being accessible to other software on the same machine. It is designed as a local API for automation.
- PDF files that crash or hang the renderer (these are bugs, not security issues)
- Malicious PDFs that trigger JavaScript inside a PDF viewer (we don't execute PDF JavaScript)
