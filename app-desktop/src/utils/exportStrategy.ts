import type { Annotation } from '../store/pdfStore'

export type TextEditStrategy =
  | 'nativePatch'
  | 'solidCoverRedraw'
  | 'containerRebuild'
  | 'localReconstruction'

export function chooseTextEditStrategy(ann: Pick<
  Annotation,
  'layoutMode' |
  'backgroundType' |
  'backgroundComplexity' |
  'requiresReconstruction' |
  'containerPdfWidth' |
  'containerPdfHeight' |
  'bgColor' |
  'sampledBgColor' |
  'sampledBgSpread'
>): TextEditStrategy {
  if (
    ann.sampledBgColor &&
    ann.sampledBgSpread !== undefined &&
    ann.sampledBgSpread <= 18
  ) {
    return ann.layoutMode === 'container' && ann.containerPdfWidth && ann.containerPdfHeight
      ? 'containerRebuild'
      : 'solidCoverRedraw'
  }

  if (ann.requiresReconstruction) {
    if (ann.layoutMode === 'container' && ann.containerPdfWidth && ann.containerPdfHeight) {
      return 'containerRebuild'
    }
    return 'localReconstruction'
  }

  if (ann.layoutMode === 'container' && ann.containerPdfWidth && ann.containerPdfHeight) {
    return 'containerRebuild'
  }

  if (
    ann.backgroundType === 'image' ||
    ann.backgroundType === 'mixed' ||
    ann.backgroundComplexity === 'high'
  ) {
    return 'localReconstruction'
  }

  if (
    ann.bgColor &&
    (ann.backgroundType === 'solid' || ann.backgroundType === 'vector') &&
    ann.backgroundComplexity === 'low'
  ) {
    return 'solidCoverRedraw'
  }

  return 'nativePatch'
}
