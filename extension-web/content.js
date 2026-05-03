/**
 * Content script. Detects PDF links on the current page.
 * and optionally adds hover badges.
 */

;(function () {
  if (window.__ultraPDFInjected) return
  window.__ultraPDFInjected = true

  function isPDFLink(href) {
    if (!href) return false
    return href.toLowerCase().includes('.pdf') || href.includes('application/pdf')
  }

  function injectBadges() {
    const links = document.querySelectorAll('a[href]')
    links.forEach(link => {
      if (!isPDFLink(link.href) || link.dataset.ultraPDF) return
      link.dataset.ultraPDF = 'true'

      const badge = document.createElement('span')
      badge.textContent = 'Open in editor'
      badge.style.cssText = `
        display: none;
        position: absolute;
        z-index: 99999;
        background: #6366f1;
        color: white;
        font-size: 11px;
        padding: 3px 8px;
        border-radius: 4px;
        white-space: nowrap;
        pointer-events: none;
        box-shadow: 0 2px 8px rgba(0,0,0,0.2);
        font-family: system-ui, sans-serif;
      `

      link.addEventListener('mouseenter', (e) => {
        badge.style.display = 'block'
        const rect = link.getBoundingClientRect()
        badge.style.top = `${rect.bottom + window.scrollY + 4}px`
        badge.style.left = `${rect.left + window.scrollX}px`
        document.body.appendChild(badge)
      })

      link.addEventListener('mouseleave', () => {
        badge.style.display = 'none'
        badge.remove()
      })

      link.addEventListener('contextmenu', () => {
        badge.style.display = 'none'
        badge.remove()
      })
    })
  }

  // Run on load and on DOM changes
  injectBadges()
  const observer = new MutationObserver(injectBadges)
  observer.observe(document.body, { childList: true, subtree: true })
})()
