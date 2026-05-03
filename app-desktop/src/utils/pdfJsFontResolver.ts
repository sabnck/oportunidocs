export interface PDFJSResolvedFont {
  internalName: string
  loadedName: string
  cssFontFamily: string
  displayName: string
  familyName: string
  baseName: string
  fallbackName: string
  bytes?: Uint8Array
  mimetype?: string
  isBold: boolean
  isItalic: boolean
  isSerif: boolean
  isMonospace: boolean
}

const registeredFamilies = new Set<string>()

function stripSubsetPrefix(name: string): string {
  return name.replace(/^[A-Z]{6}\+/, '')
}

function cleanDisplayName(name: string): string {
  return stripSubsetPrefix(name).replace(/[_-]+/g, ' ').trim()
}

function normalizeFamilyName(name: string): string {
  const clean = cleanDisplayName(name)
  return clean
    .replace(/\b(regular|roman|book|medium|semibold|semi bold|bold|black|heavy|light|thin|italic|oblique)\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim() || clean
}

function guessGenericFamily(fontObj: any, fallbackName?: string, baseName?: string): string {
  if (fontObj?.isMonospace || /mono|courier|code/i.test(`${fallbackName || ''} ${baseName || ''}`)) {
    return 'monospace'
  }
  if (
    fontObj?.isSerifFont ||
    /serif|times|georgia|garamond|palatin|baskerville|lora|playfair|didot/i.test(
      `${fallbackName || ''} ${baseName || ''}`
    )
  ) {
    return 'serif'
  }
  return 'sans-serif'
}

function buildCssFontFamily(fontObj: any, loadedName: string, fallbackName: string): string {
  if (fontObj?.systemFontInfo?.css) return fontObj.systemFontInfo.css

  const familyName = fontObj?.cssFontInfo?.fontFamily || loadedName
  return `'${familyName}', ${fallbackName}`
}

async function ensureBrowserFont(fontObj: any, loadedName: string): Promise<void> {
  if (typeof document === 'undefined' || !fontObj?.data || !loadedName) return
  if (document.fonts.check(`16px '${loadedName}'`)) return
  if (registeredFamilies.has(loadedName)) return

  try {
    const face = new FontFace(loadedName, fontObj.data, {})
    registeredFamilies.add(loadedName)
    await face.load()
    document.fonts.add(face)
  } catch {
    registeredFamilies.delete(loadedName)
  }
}

export async function resolvePDFJSFont(
  page: any,
  internalFontName: string
): Promise<PDFJSResolvedFont | null> {
  const commonObjs = page?.commonObjs
  if (!commonObjs?.has?.(internalFontName)) return null

  try {
    const fontObj = commonObjs.get(internalFontName)
    if (!fontObj) return null

    const loadedName = fontObj.loadedName || internalFontName
    const rawName = fontObj.name || loadedName || internalFontName
    const baseName = cleanDisplayName(rawName)
    const fallbackName = fontObj.fallbackName || guessGenericFamily(fontObj, '', baseName)

    await ensureBrowserFont(fontObj, loadedName)

    return {
      internalName: internalFontName,
      loadedName,
      cssFontFamily: buildCssFontFamily(fontObj, loadedName, fallbackName),
      displayName: baseName || cleanDisplayName(internalFontName) || internalFontName,
      familyName: normalizeFamilyName(rawName || loadedName || internalFontName),
      baseName,
      fallbackName,
      bytes: fontObj.data instanceof Uint8Array ? fontObj.data : undefined,
      mimetype: typeof fontObj.mimetype === 'string' ? fontObj.mimetype : undefined,
      isBold: !!(fontObj.black || fontObj.bold),
      isItalic: !!fontObj.italic,
      isSerif: !!fontObj.isSerifFont,
      isMonospace: !!fontObj.isMonospace,
    }
  } catch {
    return null
  }
}
