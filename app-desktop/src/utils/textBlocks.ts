import type { EditableBlockKind, EditableTextBlock } from './documentModel'
import type { ExtractedTextItem } from './textExtractor'
import { inferVisualContext } from './visualContext'

function classifyKind(item: ExtractedTextItem): EditableBlockKind {
  const rawText = typeof item.str === 'string' ? item.str : item.str == null ? '' : String(item.str)
  const upper = rawText.trim()
  const spacedCaps = /^[A-ZÀ-Ý0-9](?:\s+[A-ZÀ-Ý0-9])+$/u.test(upper)

  if (item.layoutMode === 'container') return 'labelInCard'
  if (item.bgColor === null) return 'textOverImage'
  if (item.vpFontSize >= 24 || item.isBold) return 'singleLineTitle'
  if (/^\s*[-•·]/.test(rawText)) return 'listLine'
  if (spacedCaps) return 'singleLineTitle'
  return 'paragraphLine'
}

function scoreConfidence(item: ExtractedTextItem): number {
  let score = 0.55
  if (item.cssFontFamily) score += 0.1
  if (item.bgRect) score += 0.1
  if (item.layoutMode === 'container') score += 0.1
  if (item.vpWidth > 8 && item.vpHeight > 8) score += 0.05
  if (item.color) score += 0.05
  return Math.max(0, Math.min(1, score))
}

function inferTextAlign(
  item: ExtractedTextItem,
  kind: EditableBlockKind,
  pageWidth: number
): ExtractedTextItem['textAlign'] {
  if (item.layoutMode === 'container') return item.textAlign
  if (kind !== 'singleLineTitle') return item.textAlign

  const blockCenter = item.vpX + item.vpWidth / 2
  const pageCenter = pageWidth / 2
  const closeToCenter = Math.abs(blockCenter - pageCenter) <= Math.max(pageWidth * 0.09, item.vpFontSize * 3)
  const wideEnough = item.vpWidth >= pageWidth * 0.22

  return closeToCenter && wideEnough ? 'center' : item.textAlign
}

function createBlockFromItem(item: ExtractedTextItem, pageIndex: number, pageWidth: number): EditableTextBlock {
  const rawText = typeof item.str === 'string' ? item.str : item.str == null ? '' : String(item.str)
  const visualContext = inferVisualContext(item)
  const kind = classifyKind(item)
  const textAlign = inferTextAlign(item, kind, pageWidth)
  const spacedCaps = /^[A-ZÀ-Ý0-9](?:\s+[A-ZÀ-Ý0-9])+$/u.test(rawText.trim())
  const safeVpX = Number.isFinite(item.vpX) ? item.vpX : 0
  const safeVpY = Number.isFinite(item.vpY) ? item.vpY : 0
  const safeVpWidth = Number.isFinite(item.vpWidth) ? item.vpWidth : 0
  const safeVpHeight = Number.isFinite(item.vpHeight) ? item.vpHeight : 0
  const safeVpBaselineY = Number.isFinite(item.vpBaselineY) ? item.vpBaselineY : safeVpY + safeVpHeight
  const safeVpFontSize = Number.isFinite(item.vpFontSize) ? item.vpFontSize : 14
  const safePdfX = Number.isFinite(item.pdfX) ? item.pdfX : 0
  const safePdfY = Number.isFinite(item.pdfY) ? item.pdfY : 0
  const safePdfWidth = Number.isFinite(item.pdfWidth) ? item.pdfWidth : 0
  const safePdfFontSize = Number.isFinite(item.pdfFontSize) ? item.pdfFontSize : 12
  return {
    id: crypto.randomUUID(),
    pageIndex,
    kind,
    text: rawText,
    lineCount: (rawText.match(/\n/g)?.length ?? 0) + 1,
    confidence: scoreConfidence(item),
    visualContext,
    rawItems: [item],
    vpX: safeVpX,
    vpY: safeVpY,
    vpWidth: safeVpWidth,
    vpHeight: safeVpHeight,
    vpBaselineY: safeVpBaselineY,
    vpFontSize: safeVpFontSize,
    pdfX: safePdfX,
    pdfY: safePdfY,
    pdfWidth: safePdfWidth,
    pdfFontSize: safePdfFontSize,
    fontName: item.fontName,
    fontDisplayName: item.fontDisplayName,
    pdfBaseFontName: item.pdfBaseFontName,
    cssFontFamily: item.cssFontFamily,
    color: item.color,
    bgColor: item.bgColor,
    bgRect: item.bgRect,
    bgRectKey: item.bgRectKey,
    layoutMode: item.layoutMode,
    textAlign,
    trackingMode: spacedCaps ? 'spaced' : 'normal',
    letterSpacingEm: spacedCaps ? 0.28 : 0,
    containerPdfX: item.containerPdfX,
    containerPdfY: item.containerPdfY,
    containerPdfWidth: item.containerPdfWidth,
    containerPdfHeight: item.containerPdfHeight,
    contentInsetPdfX: item.contentInsetPdfX,
    firstBaselineOffsetPdf: item.firstBaselineOffsetPdf,
    isBold: item.isBold,
    isItalic: item.isItalic,
    pdfLineHeight: item.pdfLineHeight,
    lineHeightVp: item.lineHeightVp,
    layoutLocked: true,
    fontSizeScale: 1,
    positionOffsetXPdf: 0,
    positionOffsetYPdf: 0,
    boxWidthScale: 1,
    boxHeightScale: 1,
    fitScale: 1,
  }
}

export function deriveEditableTextBlocks(
  items: ExtractedTextItem[],
  pageIndex: number,
  pageWidth: number
): EditableTextBlock[] {
  return items
    .filter(
      item =>
        item &&
        Number.isFinite(item.vpX) &&
        Number.isFinite(item.vpY) &&
        Number.isFinite(item.vpWidth) &&
        Number.isFinite(item.vpHeight) &&
        item.vpWidth > 0.5 &&
        item.vpHeight > 0.5
    )
    .map(item => createBlockFromItem(item, pageIndex, pageWidth))
}
