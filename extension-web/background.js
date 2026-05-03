/**
 * OportuniDocs Extension Background Service Worker
 * Handles context menus and communication with the local app.
 */

const LOCAL_APP_URL = 'http://localhost:47411'

// Context menu

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'oportunidocs-open-link',
    title: 'Open PDF in OportuniDocs',
    contexts: ['link'],
    targetUrlPatterns: ['*://*/*.pdf*']
  })

  chrome.contextMenus.create({
    id: 'oportunidocs-open-page',
    title: 'Open this PDF in OportuniDocs',
    contexts: ['page'],
    documentUrlPatterns: ['*://*/*.pdf*']
  })
})

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const pdfUrl = info.linkUrl || info.pageUrl
  if (!pdfUrl) return

  try {
    // Check if app is running
    const resp = await fetch(`${LOCAL_APP_URL}/api/status`, { signal: AbortSignal.timeout(2000) })
    if (!resp.ok) throw new Error('App not running')

    // Open the app with the PDF URL
    await chrome.tabs.create({ url: `${LOCAL_APP_URL}?pdf=${encodeURIComponent(pdfUrl)}` })
  } catch {
    // App not running. Inform user.
    chrome.notifications?.create({
      type: 'basic',
      iconUrl: 'icons/icon48.png',
      title: 'OportuniDocs',
      message: 'The app is not running. Please open OportuniDocs first.'
    })
  }
})

// Message handling

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.type === 'CHECK_APP') {
    fetch(`${LOCAL_APP_URL}/api/status`, { signal: AbortSignal.timeout(2000) })
      .then(r => r.json())
      .then(data => reply({ running: true, version: data.version }))
      .catch(() => reply({ running: false }))
    return true // keep channel open
  }

  if (msg.type === 'OPEN_PDF_URL') {
    chrome.tabs.create({ url: `${LOCAL_APP_URL}?pdf=${encodeURIComponent(msg.url)}` })
    reply({ ok: true })
  }
})

// Detect PDF pages

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url?.toLowerCase().endsWith('.pdf')) {
    // Inject the open-in-editor button
    chrome.scripting.executeScript({
      target: { tabId },
      func: injectPDFButton
    }).catch(() => {})
  }
})

function injectPDFButton() {
  if (document.getElementById('oportunidocs-btn')) return

  const btn = document.createElement('button')
  btn.id = 'oportunidocs-btn'
  btn.textContent = 'Open in OportuniDocs'
  btn.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    z-index: 99999;
    background: #6366f1;
    color: white;
    border: none;
    padding: 10px 18px;
    border-radius: 8px;
    font-size: 14px;
    font-family: system-ui, sans-serif;
    cursor: pointer;
    box-shadow: 0 4px 20px rgba(99,102,241,0.4);
    transition: all 0.2s;
  `
  btn.onmouseenter = () => { btn.style.transform = 'scale(1.04)' }
  btn.onmouseleave = () => { btn.style.transform = 'scale(1)' }
  btn.onclick = () => {
    const url = window.location.href
    chrome.runtime.sendMessage({ type: 'OPEN_PDF_URL', url })
  }

  document.body.appendChild(btn)
}
