const LOCAL_APP = 'http://localhost:47411'

const statusDot = document.getElementById('statusDot')
const statusText = document.getElementById('statusText')
const actionsEl = document.getElementById('actions')

// Check if app is running
chrome.runtime.sendMessage({ type: 'CHECK_APP' }, (resp) => {
  const running = resp?.running ?? false

  if (running) {
    statusDot.className = 'dot running'
    statusText.textContent = `Running - v${resp.version || '1.0.0'}`
    renderActions(true)
  } else {
    statusDot.className = 'dot stopped'
    statusText.textContent = 'Not running'
    renderActions(false)
  }
})

function renderActions(running) {
  if (!running) {
    actionsEl.innerHTML = `
      <div class="not-running-msg">
        <strong>App not running</strong>
        Open OportuniDocs on your computer to use this extension.
      </div>
    `
    return
  }

  actionsEl.innerHTML = `
    <button class="btn primary" id="btnOpenApp">
      <span class="btn-icon">⚡</span>
      <span class="btn-content">
        <span class="btn-title">Open Editor</span>
        <span class="btn-desc">Launch the editor in your browser</span>
      </span>
    </button>

    <button class="btn" id="btnOpenCurrentPDF">
      <span class="btn-icon">📄</span>
      <span class="btn-content">
        <span class="btn-title">Open Current Page</span>
        <span class="btn-desc">If this tab is a PDF, open it in the editor</span>
      </span>
    </button>

    <div class="divider"></div>

    <button class="btn" id="btnOpenFile">
      <span class="btn-icon">📁</span>
      <span class="btn-content">
        <span class="btn-title">Open Local PDF</span>
        <span class="btn-desc">Browse and open a file from your computer</span>
      </span>
    </button>
  `

  document.getElementById('btnOpenApp')?.addEventListener('click', () => {
    chrome.tabs.create({ url: LOCAL_APP })
    window.close()
  })

  document.getElementById('btnOpenCurrentPDF')?.addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!tab?.url) return

    const url = tab.url
    if (url.toLowerCase().includes('.pdf') || tab.url.startsWith('file://')) {
      chrome.runtime.sendMessage({ type: 'OPEN_PDF_URL', url })
    } else {
      chrome.tabs.create({ url: LOCAL_APP })
    }
    window.close()
  })

  document.getElementById('btnOpenFile')?.addEventListener('click', () => {
    chrome.tabs.create({ url: LOCAL_APP })
    window.close()
  })
}
