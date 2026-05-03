import { useState } from 'react'
import { usePDFStore } from '../store/pdfStore'
import { flattenAnnotations } from '../utils/pdfOperations'
import {
  chooseExportFormat,
  createEditableDocumentFromBytes,
  defaultExportName,
  exportPdfPagesAsImages,
  inferExportFormatFromPath,
  isSupportedInput,
  SUPPORTED_OPEN_ACCEPT,
  withExportExtension,
  type ExportFormat
} from '../utils/documentIO'

type ElectronApi = {
  openFile?: () => Promise<Array<{ path: string; data: string; name: string; mimeType?: string }> | null>
  saveFile?: (opts: { defaultName: string; formats?: string[] }) => Promise<string | null>
  writeFile?: (opts: { path: string; data: number[] }) => Promise<{ success: boolean; error?: string }>
}

function getElectronApi(): ElectronApi | undefined {
  return (window as any).electronAPI
}

function flushOpenTextEdit() {
  window.dispatchEvent(new CustomEvent('oportunidocs:commit-text-edit'))
}

async function waitForTextEditCommit() {
  flushOpenTextEdit()
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
}

function bytesFromBase64(data: string) {
  return Uint8Array.from(atob(data), (char: string) => char.charCodeAt(0))
}

function downloadBlob(bytes: Uint8Array, name: string, mimeType: string) {
  const arrayBuffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(arrayBuffer).set(bytes)
  const blob = new Blob([arrayBuffer], { type: mimeType })
  const url = URL.createObjectURL(blob)

  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !(window as any).MSStream
  if (isIOS) {
    const win = window.open(url, '_blank')
    if (!win) window.location.href = url
    setTimeout(() => URL.revokeObjectURL(url), 30_000)
    return
  }

  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

async function assertWriteResult(result: { success: boolean; error?: string } | undefined) {
  if (!result?.success) {
    throw new Error(result?.error || 'Unable to write file')
  }
}

export function useDocumentActions() {
  const [saving, setSaving] = useState(false)
  const addFile = usePDFStore(state => state.addFile)
  const addRecentFile = usePDFStore(state => state.addRecentFile)
  const updateFileData = usePDFStore(state => state.updateFileData)
  const markSaved = usePDFStore(state => state.markSaved)

  async function addOpenedFile(input: { name: string; data: Uint8Array; path?: string; mimeType?: string }) {
    const prepared = await createEditableDocumentFromBytes(input)
    addFile({
      id: crypto.randomUUID(),
      name: input.name,
      path: prepared.sourceKind === 'pdf' ? input.path : undefined,
      sourcePath: input.path,
      sourceKind: prepared.sourceKind,
      data: prepared.data,
      pageCount: 0,
      annotations: [],
      modified: false
    })
    if (input.path) addRecentFile({ name: input.name, path: input.path })
  }

  async function openDroppedFiles(files: File[]) {
    for (const file of files.filter(file => isSupportedInput(file.name, file.type))) {
      const data = new Uint8Array(await file.arrayBuffer())
      await addOpenedFile({ name: file.name, data, mimeType: file.type })
    }
  }

  async function openFile() {
    const api = getElectronApi()
    if (api?.openFile) {
      const result = await api.openFile()
      if (!result) return
      for (const file of result) {
        await addOpenedFile({
          name: file.name,
          path: file.path,
          data: bytesFromBase64(file.data),
          mimeType: file.mimeType
        })
      }
      return
    }

    const input = document.createElement('input')
    input.type = 'file'
    input.accept = SUPPORTED_OPEN_ACCEPT
    input.multiple = true
    input.onchange = async () => {
      await openDroppedFiles(Array.from(input.files ?? []))
    }
    input.click()
  }

  async function save() {
    if (saving) return
    setSaving(true)
    try {
      await waitForTextEditCommit()
      const state = usePDFStore.getState()
      const file = state.files.find(file => file.id === state.activeFileId)
      if (!file) return

      const pdfBytes = await flattenAnnotations(file.data, file.annotations, state.zoom)
      const api = getElectronApi()

      if (api?.writeFile && file.path) {
        await assertWriteResult(await api.writeFile({ path: file.path, data: Array.from(pdfBytes) }))
        updateFileData(file.id, pdfBytes)
        markSaved(file.id)
        return
      }

      await saveAs(pdfBytes)
    } finally {
      setSaving(false)
    }
  }

  async function saveAs(existingPdfBytes?: Uint8Array) {
    if (saving && !existingPdfBytes) return
    setSaving(true)
    try {
      await waitForTextEditCommit()
      const state = usePDFStore.getState()
      const file = state.files.find(file => file.id === state.activeFileId)
      if (!file) return

      const pdfBytes = existingPdfBytes ?? await flattenAnnotations(file.data, file.annotations, state.zoom)
      const defaultFormat: ExportFormat = file.sourceKind === 'image' ? 'png' : 'pdf'
      const defaultName = defaultExportName(file.name, defaultFormat)
      const api = getElectronApi()

      if (api?.saveFile && api.writeFile) {
        const selectedPath = await api.saveFile({ defaultName, formats: ['pdf', 'png', 'jpeg'] })
        if (!selectedPath) return
        const format = inferExportFormatFromPath(selectedPath)
        await writeExportedFile({
          api: { writeFile: api.writeFile },
          fileId: file.id,
          selectedPath,
          pdfBytes,
          format
        })
        return
      }

      const format = chooseExportFormat(defaultFormat)
      if (!format) return
      await downloadExport(file.name, pdfBytes, format)
    } finally {
      setSaving(false)
    }
  }

  async function writeExportedFile({
    api,
    fileId,
    selectedPath,
    pdfBytes,
    format
  }: {
    api: Required<Pick<ElectronApi, 'writeFile'>>
    fileId: string
    selectedPath: string
    pdfBytes: Uint8Array
    format: ExportFormat
  }) {
    if (format === 'pdf') {
      const path = withExportExtension(selectedPath, 'pdf')
      await assertWriteResult(await api.writeFile({ path, data: Array.from(pdfBytes) }))
      updateFileData(fileId, pdfBytes)
      markSaved(fileId)
      return
    }

    const images = await exportPdfPagesAsImages(pdfBytes, format, selectedPath)
    const target = withExportExtension(selectedPath, format)
    const ext = format === 'png' ? 'png' : 'jpg'
    const withoutExt = target.replace(/\.[^.\\/]+$/, '')
    for (const image of images) {
      const path = images.length === 1
        ? target
        : `${withoutExt}-page-${String(image.pageIndex + 1).padStart(2, '0')}.${ext}`
      await assertWriteResult(await api.writeFile({ path, data: Array.from(image.bytes) }))
    }
  }

  async function downloadExport(name: string, pdfBytes: Uint8Array, format: ExportFormat) {
    if (format === 'pdf') {
      downloadBlob(pdfBytes, defaultExportName(name, 'pdf'), 'application/pdf')
      return
    }

    const images = await exportPdfPagesAsImages(pdfBytes, format, name)
    for (const image of images) {
      downloadBlob(image.bytes, image.name, image.mimeType)
    }
  }

  return {
    addOpenedFile,
    openDroppedFiles,
    openFile,
    save,
    saveAs,
    saving
  }
}
