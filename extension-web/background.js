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
