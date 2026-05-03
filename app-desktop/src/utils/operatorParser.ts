/**
 * operatorParser.ts
 *
 * Extracts per-text-item fill color from a PDF page by walking the
 * PDF.js operator list.  This avoids parsing the raw content stream
 * and instead leverages the already-decoded op list that PDF.js builds
 * for rendering.
 *
 * Color operators tracked:
 *   rg / RG  →  RGB fill / stroke
 *   g  / G   →  Gray fill / stroke
 *   k  / K   →  CMYK fill / stroke
 *   sc / scn →  Generic fill color (CS-dependent, handled as RGB if 3 args)
 *   Tf       →  Set font + size (tracked for font name per text run)
 *   Tm / Td / TD →  Text positioning (tracked for position)
 *   BT / ET  →  Begin / End text block (reset text matrix)
 *   q  / Q   →  Save / restore graphics state (stack fill color + CTM)
 *   cm       →  Modify current transformation matrix
 *   Tj / TJ / ' / "  →  Text showing ops (emit a hint)
 *
 * IMPORTANT: coordinates emitted in hints are in USER SPACE (CTM applied),
 * matching what pdfjs getTextContent() returns in item.transform[4/5].
 */

import * as PDFJS from 'pdfjs-dist'

// ─── Public types ──────────────────────────────────────────────────────────

export interface TextColorHint {
  /** X in PDF user-space (CTM applied) — matches getTextContent item.transform[4] */
  x: number
  /** Y in PDF user-space (CTM applied) — matches getTextContent item.transform[5] */
  y: number
  /** Hex fill color in effect when this text was drawn */
  color: string
  /** Internal PDF font resource name in effect (e.g. 'F1') */
  fontRef: string
  /** Font size in PDF points */
  fontSize: number
}

// ─── Matrix helpers ─────────────────────────────────────────────────────────

/**
 * Post-multiply two PDF matrices (column-major [a,b,c,d,e,f]).
 * M = [a c e; b d f; 0 0 1]
 */
function matMul(m1: number[], m2: number[]): number[] {
  const [a1, b1, c1, d1, e1, f1] = m1
  const [a2, b2, c2, d2, e2, f2] = m2
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1
  ]
}

/**
 * Apply a PDF matrix to a point (x, y) → (x', y')
 * x' = m[0]*x + m[2]*y + m[4]
 * y' = m[1]*x + m[3]*y + m[5]
 */
function applyMatrix(m: number[], x: number, y: number): [number, number] {
  return [
    m[0] * x + m[2] * y + m[4],
    m[1] * x + m[3] * y + m[5]
  ]
}

// ─── Graphics state ──────────────────────────────────────────────────────────

interface GState {
  fillColor: string
  ctm: number[]
}

// ─── Main export ────────────────────────────────────────────────────────────

/**
 * Processes the PDF.js operator list for the given page and returns
 * one TextColorHint per text-showing operator, with coordinates in user space.
 *
 * Falls back to an empty array on any error so callers are always safe.
 */
export async function extractTextColors(
  page: PDFJS.PDFPageProxy
): Promise<TextColorHint[]> {
  try {
    const ops = await page.getOperatorList()
    const hints: TextColorHint[] = []

    // ── Graphics state ──────────────────────────────────────────────────────
    let fillColor = '#000000'
    let ctm = [1, 0, 0, 1, 0, 0]   // current transformation matrix (identity)
    const gStateStack: GState[] = []

    // ── Text state ──────────────────────────────────────────────────────────
    let currentFontRef  = ''
    let currentFontSize = 12

    // Text matrices (column-major [a,b,c,d,e,f])
    let tm  = [1, 0, 0, 1, 0, 0]   // text matrix
    let lm  = [1, 0, 0, 1, 0, 0]   // text line matrix

    const { OPS } = PDFJS as any   // cast: OPS may not be in the type defs

    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn   = ops.fnArray[i]
      const args = ops.argsArray[i] as any[]

      // ── Graphics state save / restore ────────────────────────────────────
      if (fn === OPS.save) {
        gStateStack.push({ fillColor, ctm: [...ctm] })
      } else if (fn === OPS.restore) {
        const prev = gStateStack.pop()
        if (prev) {
          fillColor = prev.fillColor
          ctm       = prev.ctm
        }
      }

      // ── Current transformation matrix (cm operator) ──────────────────────
      else if (fn === OPS.transform) {
        // Post-multiply: new CTM = old CTM × args
        ctm = matMul(ctm, args.slice(0, 6))
      }

      // ── Color fill operators ─────────────────────────────────────────────
      else if (fn === OPS.setFillRGBColor) {
        fillColor = rgbToHex(args[0], args[1], args[2])
      } else if (fn === OPS.setFillGray) {
        fillColor = rgbToHex(args[0], args[0], args[0])
      } else if (fn === OPS.setFillCMYKColor) {
        fillColor = cmykToHex(args[0], args[1], args[2], args[3])
      } else if (fn === OPS.setFillColor || fn === OPS.setFillColorN) {
        if (args.length >= 3)      fillColor = rgbToHex(args[0], args[1], args[2])
        else if (args.length === 1) fillColor = rgbToHex(args[0], args[0], args[0])
      }

      // ── Font selection ───────────────────────────────────────────────────
      else if (fn === OPS.setFont) {
        // args: [fontRefName, fontSize]
        currentFontRef  = args[0] ?? ''
        currentFontSize = args[1] ?? 12
      }

      // ── Begin / end text block ───────────────────────────────────────────
      else if (fn === OPS.beginText) {
        // BT resets both text matrix and text line matrix to identity
        tm = [1, 0, 0, 1, 0, 0]
        lm = [1, 0, 0, 1, 0, 0]
      }

      // ── Text matrix operators ────────────────────────────────────────────
      else if (fn === OPS.setTextMatrix) {
        // Tm: sets both text matrix and text line matrix
        tm = args.slice(0, 6)
        lm = [...tm]
      } else if (fn === OPS.moveText) {
        // Td: moves text line matrix by (tx, ty), copies to text matrix
        lm = [...lm]
        lm[4] += args[0]
        lm[5] += args[1]
        tm = [...lm]
      } else if (fn === OPS.setLeadingMoveText) {
        // TD: same as Td but also sets leading
        lm = [...lm]
        lm[4] += args[0]
        lm[5] += args[1]
        tm = [...lm]
      } else if (fn === OPS.nextLine) {
        // T*: move to start of next line (advance by leading)
        // Approximation: just copy line matrix to text matrix
        tm = [...lm]
      }

      // ── Text showing operators ───────────────────────────────────────────
      else if (
        fn === OPS.showText ||
        fn === OPS.showSpacedText ||
        fn === OPS.nextLineShowText ||
        fn === OPS.nextLineSetSpacingShowText
      ) {
        // Convert text matrix position to user space by applying CTM
        const [userX, userY] = applyMatrix(ctm, tm[4], tm[5])
        hints.push({
          x:        userX,
          y:        userY,
          color:    fillColor,
          fontRef:  currentFontRef,
          fontSize: currentFontSize
        })
      }
    }

    return hints
  } catch (err) {
    console.warn('[operatorParser] error:', err)
    return []
  }
}

/**
 * Find the best-matching color hint for a text item at (pdfX, pdfY).
 *
 * Strategy:
 *  1. Tight coordinate match (within tolerance)
 *  2. Same-Y-line match (same vertical position, any X) — most reliable for CVs
 *     where text on a line all shares one color
 *  3. Nearest hint within a generous threshold
 *  4. Default black
 */
export function matchColorToItem(
  hints: TextColorHint[],
  pdfX: number,
  pdfY: number,
  tolerance = 12
): string {
  if (hints.length === 0) return '#000000'

  // 1. Tight XY match
  for (const h of hints) {
    if (Math.abs(h.x - pdfX) <= tolerance && Math.abs(h.y - pdfY) <= tolerance) {
      return h.color
    }
  }

  // 2. Same-Y-line match — return the hint with the closest X position.
  //    Previously preferred "non-black" hints, which caused colored section
  //    headings (e.g. orange REALIZAÇÕES label) to bleed onto nearby body text.
  //    Closest-X is more reliable: it matches the hint that was drawn nearest
  //    to the item's own X position, regardless of color.
  const lineMatches = hints.filter(h => Math.abs(h.y - pdfY) <= tolerance * 2)
  if (lineMatches.length > 0) {
    return lineMatches.reduce((best, h) =>
      Math.abs(h.x - pdfX) < Math.abs(best.x - pdfX) ? h : best
    ).color
  }

  // 3. Nearest hint within a generous threshold
  let best    = hints[0]
  let minDist = Infinity
  for (const h of hints) {
    const d = Math.hypot(h.x - pdfX, h.y - pdfY)
    if (d < minDist) { minDist = d; best = h }
  }

  return minDist < 200 ? best.color : '#000000'
}

// ─── Background rectangle extraction ─────────────────────────────────────────

export interface BackgroundRect {
  /** left edge in PDF user-space (same coord system as text item pdfX) */
  x: number
  /** bottom edge in PDF user-space (Y-up) */
  y: number
  width: number
  height: number
  /** exact hex fill color drawn by the PDF content stream */
  color: string
}

/**
 * Walks the operator list and records every filled rectangle with its fill color.
 * Handles both standalone `re f` sequences AND PDF.js constructPath batches.
 * Returns rectangles in draw order (last = topmost in z-order).
 */
export async function extractBackgroundRects(
  page: PDFJS.PDFPageProxy
): Promise<BackgroundRect[]> {
  try {
    const ops = await page.getOperatorList()
    const rects: BackgroundRect[] = []

    let fillColor = '#ffffff'
    let ctm       = [1, 0, 0, 1, 0, 0]
    const gStateStack: GState[] = []
    const pending: { x: number; y: number; w: number; h: number }[] = []

    const { OPS } = PDFJS as any

    const emitPending = () => {
      for (const r of pending) {
        const [x1, y1] = applyMatrix(ctm, r.x, r.y)
        const [x2, y2] = applyMatrix(ctm, r.x + r.w, r.y + r.h)
        rects.push({
          x:      Math.min(x1, x2),
          y:      Math.min(y1, y2),
          width:  Math.abs(x2 - x1),
          height: Math.abs(y2 - y1),
          color:  fillColor,
        })
      }
      pending.length = 0
    }

    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn   = ops.fnArray[i]
      const args = ops.argsArray[i] as any[]

      if      (fn === OPS.save)    { gStateStack.push({ fillColor, ctm: [...ctm] }) }
      else if (fn === OPS.restore) {
        const prev = gStateStack.pop()
        if (prev) { fillColor = prev.fillColor; ctm = prev.ctm }
        pending.length = 0
      }
      else if (fn === OPS.transform) { ctm = matMul(ctm, args.slice(0, 6)) }

      // fill color tracking (mirrors extractTextColors)
      else if (fn === OPS.setFillRGBColor)  fillColor = rgbToHex(args[0], args[1], args[2])
      else if (fn === OPS.setFillGray)      fillColor = rgbToHex(args[0], args[0], args[0])
      else if (fn === OPS.setFillCMYKColor) fillColor = cmykToHex(args[0], args[1], args[2], args[3])
      else if (fn === OPS.setFillColor || fn === OPS.setFillColorN) {
        if      (args.length >= 3) fillColor = rgbToHex(args[0], args[1], args[2])
        else if (args.length === 1) fillColor = rgbToHex(args[0], args[0], args[0])
      }

      // standalone re operator
      else if (fn === OPS.rectangle) {
        pending.push({ x: args[0], y: args[1], w: args[2], h: args[3] })
      }

      // PDF.js combines path ops into constructPath: args[0]=op-codes, args[1]=coords
      else if (fn === OPS.constructPath) {
        try {
          const subOps = args[0] as number[]
          const coords = args[1] as number[]
          let ci = 0
          for (let si = 0; si < subOps.length; si++) {
            if (ci >= coords.length) break
            const sop = subOps[si]
            if (sop === OPS.rectangle) {
              if (ci + 3 < coords.length) {
                pending.push({
                  x: coords[ci], y: coords[ci + 1],
                  w: coords[ci + 2], h: coords[ci + 3],
                })
              }
              ci += 4
            } else {
              // moveto/lineto = 2 coords; curveTo = 6; closePath = 0
              // Use the op value as a hint — unknown ops default to 2 coords
              const skip = (sop === (OPS.curveTo ?? -1) ||
                            sop === (OPS.curveTo2 ?? -2) ||
                            sop === (OPS.curveTo3 ?? -3)) ? 6 :
                           (sop === (OPS.closePath ?? -4)) ? 0 : 2
              ci += skip
            }
          }
        } catch { /* ignore malformed constructPath */ }
      }

      // fill operations → emit pending rects
      else if (
        fn === OPS.fill            || fn === OPS.eoFill         ||
        fn === OPS.fillStroke      || fn === OPS.eoFillStroke   ||
        fn === OPS.closeFillStroke || fn === (OPS.closeEOFillStroke ?? OPS.eoFillStroke)
      ) { emitPending() }

      // non-fill path end → discard pending without emitting
      else if (
        fn === OPS.stroke      || fn === OPS.closeStroke ||
        fn === OPS.endPath     || fn === (OPS.closePath ?? -1)
      ) { pending.length = 0 }
    }

    return rects
  } catch (err) {
    console.warn('[operatorParser] extractBackgroundRects error:', err)
    return []
  }
}

/**
 * Returns the exact fill color of the LAST (topmost z-order) filled rectangle
 * that contains the point (pdfX, pdfY) in user space.
 * Defaults to '#ffffff' (PDF page default background).
 */
export function matchBgColorToItem(
  rects: BackgroundRect[],
  pdfX:  number,
  pdfY:  number,
  pdfWidth = 0,
  pdfFontSize = 0
): string | null {
  // Returns null when no reliable covering rect is found — caller may use
  // pixel sampling or reconstruction. We intentionally ignore tiny path
  // rectangles (often decorative/vector glyphs) to avoid false black fills.
  const containing = rects.filter(r =>
    pdfX >= r.x - 2 &&
    pdfX <= r.x + r.width + 2 &&
    pdfY >= r.y - 2 &&
    pdfY <= r.y + r.height + 2
  )

  if (containing.length === 0) return null

  const minUsefulWidth = Math.max(pdfWidth * 0.9, pdfFontSize * 1.2, 1)
  const minUsefulHeight = Math.max(pdfFontSize * 0.8, 1)
  const viable = containing.filter(r =>
    r.width >= minUsefulWidth &&
    r.height >= minUsefulHeight
  )

  if (viable.length === 0) return null

  return [...viable].sort((a, b) =>
    (a.width * a.height) - (b.width * b.height)
  )[0]?.color ?? null
}

/**
 * Returns the most relevant background rect that contains the text item.
 * Prefers the smallest containing rect so local label/cards win over large
 * page sections.
 */
export function matchBgRectToItem(
  rects: BackgroundRect[],
  pdfX: number,
  pdfY: number,
  pdfWidth = 0,
  pdfFontSize = 0
): BackgroundRect | null {
  const containing = rects.filter(r =>
    pdfX >= r.x - 2 &&
    pdfX <= r.x + r.width + 2 &&
    pdfY >= r.y - 2 &&
    pdfY <= r.y + r.height + 2
  )

  if (containing.length === 0) return null

  const minUsefulWidth = Math.max(pdfWidth * 0.9, pdfFontSize * 1.2, 1)
  const minUsefulHeight = Math.max(pdfFontSize * 0.8, 1)

  const viable = containing.filter(r =>
    r.width >= minUsefulWidth &&
    r.height >= minUsefulHeight
  )

  const pool = viable.length > 0 ? viable : containing

  return [...pool].sort((a, b) =>
    (a.width * a.height) - (b.width * b.height)
  )[0] ?? null
}

// ─── Color utilities ─────────────────────────────────────────────────────────

function rgbToHex(r: number, g: number, b: number): string {
  const h = (v: number) =>
    Math.round(Math.max(0, Math.min(1, v)) * 255)
      .toString(16).padStart(2, '0')
  return `#${h(r)}${h(g)}${h(b)}`
}

function cmykToHex(c: number, m: number, y: number, k: number): string {
  return rgbToHex((1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k))
}
