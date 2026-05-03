import * as PDFJS from 'pdfjs-dist'
import type { ExtractedFont } from './fontExtractor'
import { extractPageTextItems, groupTextItemsIntoParagraphs } from './textExtractor'
import { deriveEditableTextBlocks } from './textBlocks'
import type { PageDocumentModel } from './documentModel'

export async function buildPageDocumentModel(
  pdfDoc: PDFJS.PDFDocumentProxy,
  pageIndex: number,
  zoom: number,
  fontMap?: Map<string, ExtractedFont>
): Promise<PageDocumentModel> {
  const page = await pdfDoc.getPage(pageIndex + 1)
  const viewport = page.getViewport({ scale: zoom })
  const extractedItems = await extractPageTextItems(pdfDoc, pageIndex, zoom, fontMap)
  const rawTextItems = groupTextItemsIntoParagraphs(extractedItems)
  const blocks = deriveEditableTextBlocks(rawTextItems, pageIndex, viewport.width)

  return {
    pageIndex,
    rawTextItems,
    blocks,
  }
}
