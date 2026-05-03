import type { ExtractedTextItem } from './textExtractor'

export type EditableBlockKind =
  | 'singleLineTitle'
  | 'labelInCard'
  | 'paragraphLine'
  | 'listLine'
  | 'textLine'
  | 'textOverImage'

export type BackgroundType =
  | 'solid'
  | 'vector'
  | 'image'
  | 'mixed'
  | 'unknown'

export type BackgroundComplexity = 'low' | 'medium' | 'high'

export interface VisualContext {
  backgroundType: BackgroundType
  backgroundComplexity: BackgroundComplexity
  requiresReconstruction: boolean
  source: 'rect' | 'sampled' | 'unknown'
}

export interface EditableTextBlock {
  id: string
  pageIndex: number
  kind: EditableBlockKind
  text: string
  lineCount: number
  confidence: number
  visualContext: VisualContext
  rawItems: ExtractedTextItem[]

  vpX: number
  vpY: number
  vpWidth: number
  vpHeight: number
  vpBaselineY: number
  vpFontSize: number

  pdfX: number
  pdfY: number
  pdfWidth: number
  pdfFontSize: number

  fontName: string
  fontDisplayName: string
  pdfBaseFontName?: string
  cssFontFamily: string
  color: string
  /** Set in TextEditOverlay when re-opening a previously edited block.
   *  Preserves the real original PDF text so commitEdit records it correctly. */
  originalText?: string
  bgColor: string | null
  sampledBgColor?: string
  sampledBgSpread?: number
  bgRect: ExtractedTextItem['bgRect']
  bgRectKey: string | null
  layoutMode: ExtractedTextItem['layoutMode']
  textAlign: ExtractedTextItem['textAlign']
  trackingMode?: 'normal' | 'spaced'
  letterSpacingEm?: number
  containerPdfX?: number
  containerPdfY?: number
  containerPdfWidth?: number
  containerPdfHeight?: number
  contentInsetPdfX?: number
  firstBaselineOffsetPdf?: number
  isBold: boolean
  isItalic: boolean
  pdfLineHeight?: number
  lineHeightVp?: number
  layoutLocked?: boolean
  fontSizeScale?: number
  positionOffsetXPdf?: number
  positionOffsetYPdf?: number
  boxWidthScale?: number
  boxHeightScale?: number
  fitScale?: number
}

export interface PageDocumentModel {
  pageIndex: number
  blocks: EditableTextBlock[]
  rawTextItems: ExtractedTextItem[]
}
