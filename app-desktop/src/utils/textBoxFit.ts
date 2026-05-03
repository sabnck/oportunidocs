export interface TextBoxFitOptions {
  lines: string[]
  baseFontSize: number
  baseLineHeight: number
  maxWidth: number
  maxHeight: number
  minScale?: number
  measureLine: (fontSize: number, lineHeight: number, line: string) => number
}

export interface TextBoxFitResult {
  fontSize: number
  lineHeight: number
  scale: number
  fits: boolean
  widestLine: number
  totalHeight: number
}

export function fitTextToBox({
  lines,
  baseFontSize,
  baseLineHeight,
  maxWidth,
  maxHeight,
  minScale = 0.55,
  measureLine,
}: TextBoxFitOptions): TextBoxFitResult {
  const safeLines = lines.length > 0 ? lines : ['']
  let scale = 1

  const getMetrics = (fontSize: number, lineHeight: number) => {
    const widest = Math.max(...safeLines.map(line => measureLine(fontSize, lineHeight, line)))
    const totalHeight = lineHeight * Math.max(safeLines.length - 1, 0) + fontSize * 1.3
    return {
      widest,
      totalHeight,
      fits: widest <= maxWidth + 0.5 && totalHeight <= maxHeight + 0.5,
    }
  }

  const baseMetrics = getMetrics(baseFontSize, baseLineHeight)
  if (baseMetrics.fits) {
    return {
      fontSize: baseFontSize,
      lineHeight: baseLineHeight,
      scale,
      fits: true,
      widestLine: baseMetrics.widest,
      totalHeight: baseMetrics.totalHeight,
    }
  }

  while (scale > minScale) {
    scale *= 0.965
    const fontSize = baseFontSize * scale
    const lineHeight = baseLineHeight * scale
    const metrics = getMetrics(fontSize, lineHeight)
    if (metrics.fits) {
      return {
        fontSize,
        lineHeight,
        scale,
        fits: true,
        widestLine: metrics.widest,
        totalHeight: metrics.totalHeight,
      }
    }
  }

  const minFontSize = baseFontSize * minScale
  const minLineHeight = baseLineHeight * minScale
  const minMetrics = getMetrics(minFontSize, minLineHeight)

  return {
    fontSize: minFontSize,
    lineHeight: minLineHeight,
    scale: minScale,
    fits: minMetrics.fits,
    widestLine: minMetrics.widest,
    totalHeight: minMetrics.totalHeight,
  }
}
