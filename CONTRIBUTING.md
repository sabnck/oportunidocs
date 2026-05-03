# Contributing

Thanks for your interest in contributing to OportuniDocs.

---

## How to contribute

**Bug reports**
Open an issue describing what happened, what you expected, your OS, and steps to reproduce. Screenshots or screen recordings help a lot.

**Feature requests**
Check the [Roadmap](./ROADMAP.md) first. If your idea is not there, open an issue and describe the use case, not just the feature itself.

**Pull requests**
For small fixes (typos, minor bugs), go ahead and submit. For larger changes, open an issue first to discuss the approach.

---

## Development setup

```bash
# Clone the repo
git clone https://github.com/sabnck/oportunidocs.git
cd oportunidocs/app-desktop

# Install dependencies
npm install

# Start the dev server
npm run dev
```

The app opens in a new Electron window. Hot reload is enabled for the renderer.

---

## Code style

- TypeScript everywhere
- Functional React components with hooks
- Zustand for global state, with no prop drilling for shared state
- CSS via Tailwind utility classes, with inline styles in JSX only when dynamic
- File names: PascalCase for components, camelCase for utilities
- No barrel `index.ts` re-exports (import directly from source files)

---

## Commit messages

Use simple imperative sentences:

```
Add signature reuse across sessions
Fix zoom reset not updating thumbnails
Improve merge modal drag indicator
```

---

## License

By contributing, you agree that your changes will remain under the same proprietary terms described in [LICENSE](./LICENSE).
