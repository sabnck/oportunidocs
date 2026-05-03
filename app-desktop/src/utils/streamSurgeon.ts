/**
 * streamSurgeon.ts
 *
 * Substituição real de texto em content streams de PDF.
 *
 * Em vez de apagar o texto e colocar um PNG por cima (que nunca fica
 * igual), este módulo modifica DIRETAMENTE os operadores Tj/TJ no
 * content stream. O operador que desenhava o texto original passa a
 * desenhar o novo texto — mesma fonte, mesma posição, mesmo tamanho,
 * mesma cor. Nada é tocado além da string do operador.
 *
 * Fluxo:
 *   1. Pega os content streams da página via pdf-lib internals.
 *   2. Descomprime FlateDecode se necessário.
 *   3. Tokeniza o stream de operadores PDF.
 *   4. Rastreia CTM + text matrix (Tm/Td/TD/T*).
 *   5. Nos operadores Tj/TJ que estejam dentro do bounding box alvo,
 *      substitui o argumento string pela string codificada nova.
 *   6. Reconstrói o stream sem compressão (PDF válido) e escreve de
 *      volta via context.assign.
 */

import {
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFArray,
  PDFRawStream,
  PDFDict,
} from 'pdf-lib'

// ─── Tipos públicos ───────────────────────────────────────────────────────────

export interface ReplaceTarget {
  /** X esquerda em user space do PDF (Y-up, igual a pdfRawX) */
  x: number
  /** Y base em user space do PDF (Y-up, igual a pdfRawY) */
  y: number
  width: number
  height: number
  /**
   * Texto novo já codificado como string hex para usar em PDF.
   * Ex.: "004E006F766F" para CIDFont/Identity-H (2 bytes por char)
   *  ou  "4E6F766F"     para fonte simples 1 byte por char.
   */
  encodedHex: string
}

export interface EraseTarget {
  x: number
  y: number
  width: number
  height: number
}

// ─── API pública ──────────────────────────────────────────────────────────────

/**
 * Substitui texto nos content streams da página.
 * Retorna true se pelo menos um operador foi modificado.
 */
export async function replaceTextInPage(
  pdfDoc: PDFDocument,
  pageIndex: number,
  targets: ReplaceTarget[]
): Promise<boolean> {
  if (targets.length === 0) return false
  return processPageStreams(pdfDoc, pageIndex, targets, 'replace')
}

/**
 * Apaga texto nos content streams (substitui por string vazia).
 * Usado como fallback quando replaceTextInPage falha.
 */
export async function eraseTextFromPage(
  pdfDoc: PDFDocument,
  pageIndex: number,
  targets: EraseTarget[]
): Promise<boolean> {
  if (targets.length === 0) return false
  const asReplace: ReplaceTarget[] = targets.map(t => ({ ...t, encodedHex: '' }))
  return processPageStreams(pdfDoc, pageIndex, asReplace, 'erase')
}

// ─── Detecção de encoding da fonte ────────────────────────────────────────────

/**
 * Lê o dicionário de fonte na página e decide se é CIDFont (2 bytes por
 * char, encoding Identity-H) ou fonte simples (1 byte por char).
 */
export async function detectFontEncoding(
  pdfDoc: PDFDocument,
  pageIndex: number,
  fontRef: string
): Promise<'2byte' | '1byte'> {
  try {
    const pages = pdfDoc.getPages()
    const page  = pages[pageIndex]
    if (!page) return '1byte'

    const ctx = pdfDoc.context
    const resourcesRaw = page.node.get(PDFName.of('Resources'))
    if (!resourcesRaw) return '1byte'

    const resources = resourcesRaw instanceof PDFRef
      ? ctx.lookup(resourcesRaw) : resourcesRaw
    if (!(resources instanceof PDFDict)) return '1byte'

    const fontDictRaw = resources.get(PDFName.of('Font'))
    if (!fontDictRaw) return '1byte'

    const fontDict = fontDictRaw instanceof PDFRef
      ? ctx.lookup(fontDictRaw) : fontDictRaw
    if (!(fontDict instanceof PDFDict)) return '1byte'

    const fontObjRaw = fontDict.get(PDFName.of(fontRef))
    if (!fontObjRaw) return '1byte'

    const fontObj = fontObjRaw instanceof PDFRef
      ? ctx.lookup(fontObjRaw) : fontObjRaw
    if (!(fontObj instanceof PDFDict)) return '1byte'

    const subtype = fontObj.get(PDFName.of('Subtype'))?.toString()
    // Type0 = fonte composta CIDFont → usa 2 bytes por caractere
    return subtype === '/Type0' ? '2byte' : '1byte'
  } catch {
    return '1byte'
  }
}

/**
 * Codifica `text` para o formato hex que vai dentro de <...> no PDF.
 *
 * - '2byte': cada char → 2 bytes big-endian (Unicode codepoint).
 *   Usado em CIDFonts com encoding Identity-H (Word, InDesign, etc.)
 * - '1byte': cada char → 1 byte (Windows-1252/Latin-1).
 *   Usado em fontes simples Type1/TrueType com encoding padrão.
 */
export function encodeTextHex(text: string, encoding: '2byte' | '1byte'): string {
  if (encoding === '2byte') {
    return Array.from(text).map(c => {
      const cp = c.codePointAt(0) ?? 0x3F
      return cp.toString(16).padStart(4, '0')
    }).join('')
  }
  return Array.from(text).map(c => {
    const code = c.charCodeAt(0) & 0xFF
    return code.toString(16).padStart(2, '0')
  }).join('')
}

// ─── Processamento de streams ─────────────────────────────────────────────────

async function processPageStreams(
  pdfDoc: PDFDocument,
  pageIndex: number,
  targets: ReplaceTarget[],
  mode: 'replace' | 'erase'
): Promise<boolean> {
  const pages = pdfDoc.getPages()
  const page  = pages[pageIndex]
  if (!page) return false

  const contentsEntry = page.node.get(PDFName.of('Contents'))
  if (!contentsEntry) return false

  const streamPairs: Array<{ ref: PDFRef; stream: PDFRawStream }> = []

  const collectRef = (ref: PDFRef) => {
    const obj = pdfDoc.context.lookup(ref)
    if (obj instanceof PDFRawStream) streamPairs.push({ ref, stream: obj })
  }

  if (contentsEntry instanceof PDFRef) {
    const resolved = pdfDoc.context.lookup(contentsEntry)
    if (resolved instanceof PDFRawStream) {
      streamPairs.push({ ref: contentsEntry, stream: resolved })
    } else if (resolved instanceof PDFArray) {
      for (let i = 0; i < resolved.size(); i++) {
        const item = resolved.get(i)
        if (item instanceof PDFRef) collectRef(item)
      }
    }
  } else if (contentsEntry instanceof PDFArray) {
    for (let i = 0; i < contentsEntry.size(); i++) {
      const item = contentsEntry.get(i)
      if (item instanceof PDFRef) collectRef(item)
    }
  }

  let anyModified = false

  for (const { ref, stream } of streamPairs) {
    const filterEntry = stream.dict.get(PDFName.of('Filter'))
    const filterName  = filterEntry?.toString() ?? ''
    const isFlate     = filterName.includes('FlateDecode') || filterName.includes('/Fl')

    let rawBytes = stream.getContents()

    if (isFlate) {
      const decoded = await decompressFlate(rawBytes)
      if (decoded !== null) rawBytes = decoded
      else continue
    }

    const modified = mode === 'replace'
      ? replaceTextInStream(rawBytes, targets)
      : eraseTextInStream(rawBytes, targets)

    if (modified === rawBytes) continue

    const newDict = stream.dict.clone(pdfDoc.context)
    newDict.delete(PDFName.of('Filter'))
    newDict.delete(PDFName.of('DecodeParms'))
    newDict.set(PDFName.of('Length'), PDFNumber.of(modified.length))

    pdfDoc.context.assign(ref, PDFRawStream.of(newDict, modified))
    anyModified = true
  }

  return anyModified
}

// ─── Descompressão ─────────────────────────────────────────────────────────────

async function decompressFlate(bytes: Uint8Array): Promise<Uint8Array | null> {
  for (const format of ['deflate', 'deflate-raw'] as CompressionFormat[]) {
    try {
      const ds     = new DecompressionStream(format)
      const writer = ds.writable.getWriter()
      const reader = ds.readable.getReader()

      writer.write(bytes.slice())
      await writer.close()

      const chunks: Uint8Array[] = []
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) chunks.push(value)
      }

      const total = chunks.reduce((n, c) => n + c.length, 0)
      if (total === 0) continue

      const out = new Uint8Array(total)
      let off = 0
      for (const c of chunks) { out.set(c, off); off += c.length }
      return out
    } catch { /* tenta próximo formato */ }
  }
  return null
}

// ─── Helpers de matriz ────────────────────────────────────────────────────────

function matMul(m1: number[], m2: number[]): number[] {
  const [a1, b1, c1, d1, e1, f1] = m1
  const [a2, b2, c2, d2, e2, f2] = m2
  return [
    a1*a2+c1*b2, b1*a2+d1*b2,
    a1*c2+c1*d2, b1*c2+d1*d2,
    a1*e2+c1*f2+e1, b1*e2+d1*f2+f1,
  ]
}

function applyMat(m: number[], x: number, y: number): [number, number] {
  return [m[0]*x + m[2]*y + m[4], m[1]*x + m[3]*y + m[5]]
}

// ─── Tokenizador ──────────────────────────────────────────────────────────────

type TokenType = 'num' | 'str' | 'hexstr' | 'name' | 'op' | '[' | ']'

interface Token {
  type: TokenType
  raw: string
  value: number | string
  startByte: number
  endByte: number
}

function tokenize(bytes: Uint8Array): Token[] {
  const tokens: Token[] = []
  let i = 0
  const len = bytes.length

  const isWS   = (b: number) => b===0x20||b===0x09||b===0x0a||b===0x0d||b===0x0c||b===0x00
  const isDelim = (b: number) => isWS(b)||b===0x28||b===0x29||b===0x3c||b===0x3e||b===0x5b||b===0x5d||b===0x7b||b===0x7d||b===0x2f||b===0x25

  const slice = (s: number, e: number) => {
    let r = ''
    for (let j = s; j < e; j++) r += String.fromCharCode(bytes[j])
    return r
  }

  while (i < len) {
    while (i < len && isWS(bytes[i])) i++
    if (i >= len) break

    if (bytes[i] === 0x25) { // %  comentário
      while (i < len && bytes[i] !== 0x0a && bytes[i] !== 0x0d) i++
      continue
    }

    const start = i
    const c = bytes[i]

    // String literal ( ... )
    if (c === 0x28) {
      i++
      let depth = 1
      while (i < len && depth > 0) {
        const b = bytes[i]
        if (b === 0x5c) { i += 2; continue }
        if (b === 0x28) depth++
        else if (b === 0x29) depth--
        i++
      }
      tokens.push({ type: 'str', raw: slice(start, i), value: slice(start+1, i-1), startByte: start, endByte: i })
      continue
    }

    // Hex string < ... > (não dict << >>)
    if (c === 0x3c && (i+1 >= len || bytes[i+1] !== 0x3c)) {
      i++
      while (i < len && bytes[i] !== 0x3e) i++
      if (i < len) i++
      tokens.push({ type: 'hexstr', raw: slice(start, i), value: slice(start+1, i-1), startByte: start, endByte: i })
      continue
    }

    // Dicionário << >> — pular
    if (c === 0x3c && i+1 < len && bytes[i+1] === 0x3c) {
      i += 2
      let depth = 1
      while (i < len-1 && depth > 0) {
        if (bytes[i]===0x3c && bytes[i+1]===0x3c) { depth++; i+=2 }
        else if (bytes[i]===0x3e && bytes[i+1]===0x3e) { depth--; i+=2 }
        else i++
      }
      continue
    }

    // Nome /word
    if (c === 0x2f) {
      i++
      while (i < len && !isDelim(bytes[i])) i++
      tokens.push({ type: 'name', raw: slice(start, i), value: slice(start+1, i), startByte: start, endByte: i })
      continue
    }

    // Delimitadores de array
    if (c === 0x5b) { i++; tokens.push({ type: '[', raw: '[', value: '[', startByte: start, endByte: i }); continue }
    if (c === 0x5d) { i++; tokens.push({ type: ']', raw: ']', value: ']', startByte: start, endByte: i }); continue }

    // Número
    if ((c>=0x30&&c<=0x39)||c===0x2b||c===0x2d||c===0x2e) {
      // Garante que não é operador começando com - ou +
      const isSign = (c === 0x2b || c === 0x2d)
      if (!isSign || (i+1 < len && (bytes[i+1]===0x2e || (bytes[i+1]>=0x30&&bytes[i+1]<=0x39)))) {
        i++
        while (i < len) {
          const b = bytes[i]
          if ((b>=0x30&&b<=0x39)||b===0x2e||b===0x45||b===0x65) i++
          else break
        }
        const raw = slice(start, i)
        const num = parseFloat(raw)
        if (!isNaN(num)) {
          tokens.push({ type: 'num', raw, value: num, startByte: start, endByte: i })
          continue
        }
        i = start // reset
      }
    }

    // Operador / keyword
    if ((c>=0x41&&c<=0x5a)||(c>=0x61&&c<=0x7a)||c===0x27||c===0x22||c===0x2a) {
      i++
      while (i < len && !isDelim(bytes[i])) i++
      tokens.push({ type: 'op', raw: slice(start, i), value: slice(start, i), startByte: start, endByte: i })
      continue
    }

    i++
  }

  return tokens
}

// ─── Substituição ─────────────────────────────────────────────────────────────

interface StreamPatch {
  start: number
  end: number
  replacement: string
}

const PAD = 4

function inTarget(targets: ReplaceTarget[], x: number, y: number): ReplaceTarget | null {
  for (const t of targets) {
    if (x >= t.x - PAD && x <= t.x + t.width + PAD &&
        y >= t.y - PAD && y <= t.y + t.height + PAD) return t
  }
  return null
}

function replaceTextInStream(sourceBytes: Uint8Array, targets: ReplaceTarget[]): Uint8Array {
  return processStream(sourceBytes, targets, 'replace')
}

function eraseTextInStream(sourceBytes: Uint8Array, targets: ReplaceTarget[]): Uint8Array {
  const eraseTargets: ReplaceTarget[] = targets.map(t => ({ ...t, encodedHex: '' }))
  return processStream(sourceBytes, eraseTargets, 'erase')
}

function processStream(
  sourceBytes: Uint8Array,
  targets: ReplaceTarget[],
  mode: 'replace' | 'erase'
): Uint8Array {
  const tokens = tokenize(sourceBytes)
  if (tokens.length === 0) return sourceBytes

  let ctm = [1,0,0,1,0,0]
  let tm  = [1,0,0,1,0,0]
  let lm  = [1,0,0,1,0,0]
  let leading = 0
  let inBT = false
  const gStack: Array<{ ctm: number[] }> = []
  const operands: Token[] = []
  const patches: StreamPatch[] = []

  const textPos = (): [number, number] => applyMat(matMul(ctm, tm), 0, 0)
  const popNum  = (): number => { const t = operands.pop(); return t ? Number(t.value) : 0 }
  const clear   = () => { operands.length = 0 }

  // Gera o replacement string para um target
  const makeReplacement = (target: ReplaceTarget | null): string => {
    if (!target || mode === 'erase') return '<>'  // string hex vazia
    return `<${target.encodedHex}>`
  }

  for (const tok of tokens) {
    if (tok.type !== 'op') { operands.push(tok); continue }
    const op = tok.value as string

    switch (op) {
      case 'q':  gStack.push({ ctm: [...ctm] }); clear(); break
      case 'Q': { const s = gStack.pop(); if (s) ctm = s.ctm; clear(); break }
      case 'cm': {
        if (operands.length >= 6) {
          const f=popNum(),e=popNum(),d=popNum(),c2=popNum(),b=popNum(),a=popNum()
          ctm = matMul(ctm, [a,b,c2,d,e,f])
        }
        clear(); break
      }
      case 'BT': inBT=true; tm=[1,0,0,1,0,0]; lm=[1,0,0,1,0,0]; clear(); break
      case 'ET': inBT=false; clear(); break
      case 'Tm': {
        if (inBT && operands.length >= 6) {
          const f=popNum(),e=popNum(),d=popNum(),c2=popNum(),b=popNum(),a=popNum()
          tm=[a,b,c2,d,e,f]; lm=[...tm]
        }
        clear(); break
      }
      case 'Td': case 'TD': {
        if (inBT && operands.length >= 2) {
          const ty=popNum(),tx=popNum()
          lm=[...lm]; lm[4]+=tx; lm[5]+=ty
          if (op==='TD') leading=-ty
          tm=[...lm]
        }
        clear(); break
      }
      case 'T*': {
        if (inBT) { lm=[...lm]; lm[5]-=leading; tm=[...lm] }
        clear(); break
      }
      case 'TL': {
        if (inBT && operands.length >= 1) { const l=operands.pop(); if(l) leading=Number(l.value) }
        clear(); break
      }

      // ── Operadores de texto ───────────────────────────────────────────────

      case 'Tj': {
        if (inBT && operands.length >= 1) {
          const strTok = operands[operands.length - 1]
          if (strTok.type === 'str' || strTok.type === 'hexstr') {
            const [px, py] = textPos()
            const target = inTarget(targets, px, py)
            if (target !== null) {
              patches.push({
                start: strTok.startByte,
                end:   strTok.endByte,
                replacement: makeReplacement(target),
              })
            }
          }
        }
        clear(); break
      }

      case "'": case '"': {
        if (inBT) {
          lm=[...lm]; lm[5]-=leading; tm=[...lm]
          const strTok = operands.find(t => t.type==='str' || t.type==='hexstr')
          if (strTok) {
            const [px, py] = textPos()
            const target = inTarget(targets, px, py)
            if (target !== null) {
              patches.push({
                start: strTok.startByte,
                end:   strTok.endByte,
                replacement: makeReplacement(target),
              })
            }
          }
        }
        clear(); break
      }

      case 'TJ': {
        if (inBT) {
          const [px, py] = textPos()
          const target = inTarget(targets, px, py)
          if (target !== null) {
            // Encontra [ e ] que delimitam o array antes do TJ
            let openTok: Token | null = null
            let closeTok: Token | null = null
            for (let j = operands.length-1; j >= 0; j--) {
              if (operands[j].type===']' && !closeTok) closeTok = operands[j]
              if (operands[j].type==='[') { openTok = operands[j]; break }
            }
            if (openTok && closeTok) {
              // Substitui o array inteiro por [<novoHex>]
              const repl = `[${makeReplacement(target)}]`
              patches.push({
                start: openTok.startByte,
                end:   closeTok.endByte,
                replacement: repl,
              })
            }
          }
        }
        clear(); break
      }

      default: clear(); break
    }
  }

  if (patches.length === 0) return sourceBytes

  patches.sort((a, b) => a.start - b.start)

  const enc = new TextEncoder()
  const parts: Uint8Array[] = []
  let pos = 0

  for (const { start, end, replacement } of patches) {
    if (start < pos) continue
    if (start > pos) parts.push(sourceBytes.slice(pos, start))
    parts.push(enc.encode(replacement))
    pos = end
  }
  if (pos < sourceBytes.length) parts.push(sourceBytes.slice(pos))

  const total = parts.reduce((n, p) => n + p.length, 0)
  const out   = new Uint8Array(total)
  let off = 0
  for (const p of parts) { out.set(p, off); off += p.length }
  return out
}
