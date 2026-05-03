import type { ExtractedTextItem } from './textExtractor'
import type { VisualContext } from './documentModel'

function isNearWhite(hex: string | null | undefined): boolean {
  const clean = String(hex || '').replace('#', '').trim()
  if (!/^[\da-fA-F]{6}$/.test(clean)) return false
  const r = parseInt(clean.slice(0, 2), 16)
  const g = parseInt(clean.slice(2, 4), 16)
  const b = parseInt(clean.slice(4, 6), 16)
  return r > 236 && g > 236 && b > 236
}

function isLightOrMidText(hex: string | null | undefined): boolean {
  const clean = String(hex || '').replace('#', '').trim()
  if (!/^[\da-fA-F]{6}$/.test(clean)) return false
  const r = parseInt(clean.slice(0, 2), 16)
  const g = parseInt(clean.slice(2, 4), 16)
  const b = parseInt(clean.slice(4, 6), 16)
  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b
  return luma >= 170
}

export function inferVisualContext(
  item: Pick<ExtractedTextItem, 'bgRect' | 'bgColor' | 'layoutMode' | 'color' | 'vpFontSize'>
): VisualContext {
  if (item.bgRect && !isNearWhite(item.bgRect.color)) {
    return {
      backgroundType: item.layoutMode === 'container' ? 'vector' : 'solid',
      backgroundComplexity: 'low',
      requiresReconstruction: false,
      source: 'rect',
    }
  }

  if (item.bgColor && !isNearWhite(item.bgColor)) {
    return {
      backgroundType: 'mixed',
      backgroundComplexity: 'medium',
      requiresReconstruction: true,
      source: 'sampled',
    }
  }

  if (!item.bgRect && !item.bgColor && item.vpFontSize <= 22 && !isLightOrMidText(item.color)) {
    return {
      backgroundType: 'solid',
      backgroundComplexity: 'low',
      requiresReconstruction: false,
      source: 'unknown',
    }
  }

  if (!item.bgRect && !item.bgColor) {
    return {
      backgroundType: 'image',
      backgroundComplexity: 'high',
      requiresReconstruction: true,
      source: 'unknown',
    }
  }

  return {
    backgroundType: 'unknown',
    backgroundComplexity: 'medium',
    requiresReconstruction: true,
    source: item.bgRect ? 'rect' : item.bgColor ? 'sampled' : 'unknown',
  }
}
