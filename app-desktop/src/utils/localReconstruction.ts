function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t
}

function mixColors(a: number[], b: number[], t: number) {
  return [
    lerp(a[0], b[0], t),
    lerp(a[1], b[1], t),
    lerp(a[2], b[2], t),
    lerp(a[3], b[3], t),
  ]
}

function getPixel(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number
) {
  const px = clamp(Math.round(x), 0, width - 1)
  const py = clamp(Math.round(y), 0, height - 1)
  const idx = (py * width + px) * 4
  return [data[idx], data[idx + 1], data[idx + 2], data[idx + 3]]
}

export function reconstructBackgroundPatchCanvas(
  sourceCanvas: HTMLCanvasElement,
  viewX: number,
  viewY: number,
  viewWidth: number,
  viewHeight: number,
  sourceScale = window.devicePixelRatio || 1
): HTMLCanvasElement | null {
  const patchW = Math.max(1, Math.round(viewWidth * sourceScale))
  const patchH = Math.max(1, Math.round(viewHeight * sourceScale))
  if (patchW < 1 || patchH < 1) return null

  const sx = Math.round(viewX * sourceScale)
  const sy = Math.round(viewY * sourceScale)
  const margin = Math.max(2, Math.round(Math.min(patchW, patchH) * 0.08))
  const rx = clamp(sx - margin, 0, sourceCanvas.width - 1)
  const ry = clamp(sy - margin, 0, sourceCanvas.height - 1)
  const rw = clamp(patchW + margin * 2, 1, sourceCanvas.width - rx)
  const rh = clamp(patchH + margin * 2, 1, sourceCanvas.height - ry)

  const sourceCtx = sourceCanvas.getContext('2d', { willReadFrequently: true })
  if (!sourceCtx) return null

  const sourceData = sourceCtx.getImageData(rx, ry, rw, rh)
  const out = document.createElement('canvas')
  out.width = patchW
  out.height = patchH
  const outCtx = out.getContext('2d')
  if (!outCtx) return null
  const outImage = outCtx.createImageData(patchW, patchH)

  const innerX = sx - rx
  const innerY = sy - ry

  for (let y = 0; y < patchH; y++) {
    const ty = patchH <= 1 ? 0 : y / (patchH - 1)
    for (let x = 0; x < patchW; x++) {
      const tx = patchW <= 1 ? 0 : x / (patchW - 1)

      const left = getPixel(sourceData.data, rw, rh, innerX - 1, innerY + y)
      const right = getPixel(sourceData.data, rw, rh, innerX + patchW, innerY + y)
      const top = getPixel(sourceData.data, rw, rh, innerX + x, innerY - 1)
      const bottom = getPixel(sourceData.data, rw, rh, innerX + x, innerY + patchH)

      const horiz = mixColors(left, right, tx)
      const vert = mixColors(top, bottom, ty)
      const final = [
        Math.round((horiz[0] + vert[0]) / 2),
        Math.round((horiz[1] + vert[1]) / 2),
        Math.round((horiz[2] + vert[2]) / 2),
        255,
      ]

      const idx = (y * patchW + x) * 4
      outImage.data[idx] = final[0]
      outImage.data[idx + 1] = final[1]
      outImage.data[idx + 2] = final[2]
      outImage.data[idx + 3] = final[3]
    }
  }

  outCtx.putImageData(outImage, 0, 0)
  return out
}

export function canvasToPngBytes(canvas: HTMLCanvasElement): Uint8Array {
  const dataUrl = canvas.toDataURL('image/png')
  const base64 = dataUrl.split(',')[1]
  const binary = atob(base64)
  const pngBytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) pngBytes[i] = binary.charCodeAt(i)
  return pngBytes
}
