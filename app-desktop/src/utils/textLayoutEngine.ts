import type { Annotation } from '../store/pdfStore'

export interface ViewportTextEditFrame {
  fontSize: number
  lineHeight: number
  anchorX: number
  baselineY: number
  boxWidth: number
  boxHeight: number
  container: {
    x: number
    y: number
    width: number
    height: number
    baselineY: number
    insetX: number
  } | null
}

export interface PdfTextEditFrame {
  fontSize: number
  lineHeight: number
  anchorX: number
  baselineY: number
  boxWidth: number
  boxHeight: number
  container: {
    x: number
    y: number
    width: number
    height: number
    baselineY: number
    insetX: number
  } | null
}

export function resolveViewportTextEditFrame(
  ann: Annotation,
  pageHeight: number,
  zoom: number
): ViewportTextEditFrame {
  const fontSizeScale = ann.fontSizeScale ?? 1
  const boxWidthScale = ann.boxWidthScale ?? 1
  const boxHeightScale = ann.boxHeightScale ?? 1
  const offsetX = (ann.positionOffsetXPdf ?? 0) * zoom
  const offsetY = (ann.positionOffsetYPdf ?? 0) * zoom
  const hasRawLayout = ann.pdfRawX !== undefined && ann.pdfRawY !== undefined && ann.pdfRawFontSize !== undefined
  const baseFontSize = hasRawLayout
    ? ann.pdfRawFontSize! * zoom
    : (ann.vpFontSize ?? Math.max((ann.height ?? 14) * 0.8, 7))
  const baseLineHeight = ann.pdfLineHeight !== undefined
    ? ann.pdfLineHeight * zoom
    : (ann.lineHeightVp ?? baseFontSize * 1.2)
  const fontSize = Math.max(1, baseFontSize * fontSizeScale)
  const lineHeight = Math.max(fontSize, baseLineHeight * fontSizeScale)
  const anchorX = (hasRawLayout ? ann.pdfRawX! * zoom : ann.x) + offsetX
  const baselineY = (hasRawLayout
    ? pageHeight - ann.pdfRawY! * zoom
    : (ann.vpBaselineY ?? (ann.y + baseFontSize * 0.85))) + offsetY
  const boxWidth = ann.pdfRawWidth !== undefined
    ? Math.max(1, ann.pdfRawWidth * zoom * boxWidthScale)
    : Math.max(1, (ann.width ?? 80) * boxWidthScale)
  const lineCount = Math.max(1, (ann.text ?? '').split('\n').length)
  const rawBoxHeight = hasRawLayout
    ? Math.max(baseLineHeight * lineCount, baseFontSize)
    : (ann.height ?? 14)
  const boxHeight = Math.max(1, rawBoxHeight * boxHeightScale)

  const container = ann.layoutMode === 'container' &&
    ann.containerPdfX !== undefined &&
    ann.containerPdfY !== undefined &&
    ann.containerPdfWidth !== undefined &&
    ann.containerPdfHeight !== undefined
    ? {
        x: ann.containerPdfX * zoom - ((ann.containerPdfWidth * zoom) * boxWidthScale - ann.containerPdfWidth * zoom) / 2 + offsetX,
        y: pageHeight - (ann.containerPdfY + ann.containerPdfHeight) * zoom - ((ann.containerPdfHeight * zoom) * boxHeightScale - ann.containerPdfHeight * zoom) / 2 + offsetY,
        width: ann.containerPdfWidth * zoom * boxWidthScale,
        height: ann.containerPdfHeight * zoom * boxHeightScale,
        baselineY: ann.firstBaselineOffsetPdf !== undefined
          ? pageHeight - (ann.containerPdfY + ann.containerPdfHeight) * zoom + ann.firstBaselineOffsetPdf * zoom + offsetY
          : baselineY,
        insetX: (ann.contentInsetPdfX ?? 0) * zoom,
      }
    : null

  return {
    fontSize,
    lineHeight,
    anchorX,
    baselineY,
    boxWidth: container?.width ?? boxWidth,
    boxHeight: container?.height ?? boxHeight,
    container,
  }
}

export function resolvePdfTextEditFrame(
  ann: Annotation,
  pageHeightPt: number,
  renderScale: number
): PdfTextEditFrame {
  const fontSizeScale = ann.fontSizeScale ?? 1
  const boxWidthScale = ann.boxWidthScale ?? 1
  const boxHeightScale = ann.boxHeightScale ?? 1
  const offsetX = ann.positionOffsetXPdf ?? 0
  const offsetY = ann.positionOffsetYPdf ?? 0
  let anchorX: number
  let baselineY: number
  let fontSize: number
  let lineHeight: number

  if (ann.pdfRawX !== undefined && ann.pdfRawFontSize !== undefined) {
    anchorX = ann.pdfRawX
    baselineY = ann.pdfRawY!
    fontSize = ann.pdfRawFontSize
    lineHeight = ann.pdfLineHeight ?? fontSize * 1.2
  } else {
    fontSize = (ann.fontSize ?? 12) / renderScale
    lineHeight = fontSize * 1.2
    anchorX = ann.x / renderScale
    baselineY = pageHeightPt - (ann.y / renderScale) - fontSize
  }

  anchorX += offsetX
  baselineY -= offsetY
  fontSize = Math.max(4, fontSize * fontSizeScale)
  lineHeight = Math.max(fontSize, lineHeight * fontSizeScale)
  // Prefer stored PDF-space dimensions (zoom-independent) over viewport pixels ÷ renderScale.
  // ann.pdfRawWidth is set by commitEdit() from editItem.pdfWidth (PDF points, never scaled).
  const boxWidth = ann.pdfRawWidth !== undefined
    ? Math.max(4, ann.pdfRawWidth * boxWidthScale)
    : Math.max(4, ((ann.width ?? 80) / renderScale) * boxWidthScale)
  // boxHeight: derive from line metrics when pdfRawFontSize is available so it stays
  // zoom-independent. Fall back to viewport height ÷ renderScale for non-textEdit annotations.
  const lineCount = (ann.text ?? '').split('\n').length
  const pdfBoxHeight = ann.pdfRawFontSize !== undefined
    ? Math.max(fontSize, (ann.pdfLineHeight ?? fontSize * 1.2) * Math.max(lineCount, 1))
    : (ann.height ?? 14) / renderScale
  const boxHeight = Math.max(4, pdfBoxHeight * boxHeightScale)

  const container = ann.layoutMode === 'container' &&
    ann.containerPdfX !== undefined &&
    ann.containerPdfY !== undefined &&
    ann.containerPdfWidth !== undefined &&
    ann.containerPdfHeight !== undefined
    ? {
        x: ann.containerPdfX - (ann.containerPdfWidth * boxWidthScale - ann.containerPdfWidth) / 2 + offsetX,
        y: ann.containerPdfY - (ann.containerPdfHeight * boxHeightScale - ann.containerPdfHeight) / 2 - offsetY,
        width: ann.containerPdfWidth * boxWidthScale,
        height: ann.containerPdfHeight * boxHeightScale,
        baselineY: ann.firstBaselineOffsetPdf !== undefined
          ? ann.containerPdfY + ann.containerPdfHeight - ann.firstBaselineOffsetPdf - offsetY
          : baselineY,
        insetX: ann.contentInsetPdfX ?? 0,
      }
    : null

  return {
    fontSize,
    lineHeight,
    anchorX,
    baselineY,
    boxWidth: container?.width ?? boxWidth,
    boxHeight: container?.height ?? boxHeight,
    container,
  }
}
