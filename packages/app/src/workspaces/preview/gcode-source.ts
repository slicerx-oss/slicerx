// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Where the line view's text comes from: the plate's slice (its G-code, as the engine wrote it, so the line
// numbers match the toolpaths) or a G-code file opened on its own. One text is kept at a time; a new slice or
// file replaces it.
import type { FileRef, Host, PreviewBuffers } from '@slicerx/contracts'
import { appStore, get, set, toast, type AppState } from '../../state/store'
import { gcodeView } from './gcode-file'
import { indexLines, type LineIndex } from './gcode-lines'
import { parseGcodePreview } from './gcode-parse'

let held: { key: string; index: Promise<LineIndex> } | null = null
/** The plate's slice from before a file was opened, put back when the file closes. */
let beforeFile: Pick<AppState, 'slice' | 'preview' | 'layerHi' | 'layerLo' | 'moveCut'> | null = null
let filePreview: PreviewBuffers | null = null
let offWatch: (() => void) | null = null

/** Thrown when the slice has no text to show. */
export class NoTextError extends Error {}

/**
 * The text behind what Preview shows now, indexed by line, or null when there is nothing. Loads the slice's
 * G-code once per slice.
 */
export function currentText(host: Host): Promise<LineIndex> | null {
  const s = get()
  const file = gcodeView.getState().file
  if (file && held?.key.startsWith('file:')) return held.index
  if (s.slice.status !== 'done') return null
  const r = s.slice.result
  const key = `slice:${r.id}`
  if (held?.key === key) return held.index
  if (r.gcodeFormat === 'bgcode') return Promise.reject(new NoTextError('This printer takes binary G-code, which has no text lines to show.'))
  const index = host.slicer.exportGcode(r.id, { kind: 'blob' }).then(async (out) => {
    if (!out.blob) throw new NoTextError('The G-code is not available in this app.')
    return indexLines(new Uint8Array(await out.blob.arrayBuffer()))
  })
  held = { key, index }
  // A failed load is not kept, so the next open tries again.
  index.catch(() => {
    if (held?.key === key) held = null
  })
  return index
}

/** Reads a G-code file into Preview: toolpaths from its moves and the line view from its text. */
export async function openGcodeFile(host: Host, ref: FileRef): Promise<void> {
  gcodeView.setState({ reading: ref.name })
  try {
    const bytes = new Uint8Array(await host.files.read(ref))
    const index = await indexLines(bytes)
    const parsed = await parseGcodePreview(index)
    if (parsed.preview.segmentCount === 0) {
      toast(`${ref.name} has no printing moves to show`, 'warn')
      return
    }
    const s = get()
    if (!gcodeView.getState().file) beforeFile = { slice: s.slice, preview: s.preview, layerHi: s.layerHi, layerLo: s.layerLo, moveCut: s.moveCut }
    held = { key: `file:${ref.name}:${bytes.length}`, index: Promise.resolve(index) }
    filePreview = parsed.preview
    gcodeView.setState({ file: { name: ref.name, bytes: bytes.length, lines: index.count, timeS: parsed.timeS, filamentMm: parsed.filamentMm } })
    set({ workspace: 'prepare', modelMode: 'slice', sliceLook: 'toolpaths', slice: { status: 'idle' }, preview: parsed.preview, layerHi: parsed.preview.layerCount, layerLo: 1, moveCut: 1, norn: { ...s.norn, pick: null, before: null, ghost: false } })
    // A slice of the plate takes the view back; the file is let go.
    offWatch?.()
    offWatch = appStore.subscribe((st) => {
      if (st.preview !== filePreview) forgetFile()
    })
  } catch (e) {
    toast(e instanceof Error ? `Could not read ${ref.name}: ${e.message}` : `Could not read ${ref.name}`, 'error')
  } finally {
    gcodeView.setState({ reading: null })
  }
}

function forgetFile(): void {
  offWatch?.()
  offWatch = null
  filePreview = null
  beforeFile = null
  if (held?.key.startsWith('file:')) held = null
  gcodeView.setState({ file: null })
}

/** Closes the file and shows the plate's slice again, if there was one. */
export function closeFile(): void {
  const back = beforeFile
  forgetFile()
  if (back) set(back)
  else set({ preview: null })
}
