import type { EditableTextBlock } from './documentModel'

export function findEditableBlockAtPoint(
  blocks: EditableTextBlock[],
  clickX: number,
  clickY: number,
  tolerance = 5
): EditableTextBlock | null {
  const scoreHit = (block: EditableTextBlock) => {
    const area = block.vpWidth * block.vpHeight
    const cx = block.vpX + block.vpWidth / 2
    const cy = block.vpY + block.vpHeight / 2
    const centerDist = Math.hypot(clickX - cx, clickY - cy)
    const horizontalSlack = Math.max(0, Math.abs(clickX - cx) - block.vpWidth / 2)
    const verticalSlack = Math.max(0, Math.abs(clickY - cy) - block.vpHeight / 2)
    const edgePenalty = horizontalSlack + verticalSlack * 1.5
    const kindBias =
      block.kind === 'labelInCard' ? -18 :
      block.kind === 'singleLineTitle' ? -10 :
      block.kind === 'paragraphLine' ? 4 :
      0

    return {
      area,
      centerDist,
      edgePenalty,
      confidence: block.confidence,
      kindBias,
    }
  }

  const candidates = blocks.filter(block =>
    block.vpWidth > 3 &&
    block.vpHeight > 3 &&
    clickX >= block.vpX - tolerance &&
    clickX <= block.vpX + block.vpWidth + tolerance &&
    clickY >= block.vpY - tolerance &&
    clickY <= block.vpY + block.vpHeight + tolerance
  )

  if (candidates.length > 0) {
    return [...candidates].sort((a, b) => {
      const sa = scoreHit(a)
      const sb = scoreHit(b)
      if (Math.abs(sa.kindBias - sb.kindBias) > 0.1) return sa.kindBias - sb.kindBias
      if (Math.abs(sa.edgePenalty - sb.edgePenalty) > 0.5) return sa.edgePenalty - sb.edgePenalty
      if (Math.abs(sa.area - sb.area) > 1) return sa.area - sb.area
      if (Math.abs(sa.confidence - sb.confidence) > 0.01) return sb.confidence - sa.confidence
      return sa.centerDist - sb.centerDist
    })[0]
  }

  let closest: EditableTextBlock | null = null
  let minDist = 28

  for (const block of blocks) {
    const cx = block.vpX + block.vpWidth / 2
    const cy = block.vpY + block.vpHeight / 2
    const dist = Math.hypot(clickX - cx, (clickY - cy) * 1.2)
    if (dist < minDist) {
      minDist = dist
      closest = block
    }
  }

  return closest
}
