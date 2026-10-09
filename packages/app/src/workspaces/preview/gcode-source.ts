// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Where the line view's text comes from: the plate's slice (its G-code, as the engine wrote it, so the line
// numbers match the toolpaths) or a G-code file opened on its own. A slice's text stays with the host that keeps it
// (the web pool, or the desktop app's slice result), which export reads too: the page asks it for the line starts
// while something holds them (the G-code panel while it is open, or a reader of markers or purges until it is done),
// and for the bytes of the lines it reads. A file's text stays while the file is open.
import type { FileRef, Host, PreviewBuffers } from '@slicerx/contracts'
import { appStore, get, set, toast, type AppState } from '../../state/store'
import { gcodeView } from './gcode-file'
import { indexLines, rangeSource, wholeSource, type LineSource } from './gcode-lines'
import { parseGcodePreview } from './gcode-parse'

let held: { key: string; source: Promise<LineSource>; users: number } | null = null
/** The plate's slice from before a file was opened, put back when the file closes. */
let beforeFile: Pick<AppState, 'slice' | 'preview' | 'layerHi' | 'layerLo' | 'moveCut'> | null = null
let filePreview: PreviewBuffers | null = null
let offWatch: (() => void) | null = null

/** Thrown when the slice has no text to show. */
export class NoTextError extends Error {}

/** A hold on the lines behind what Preview shows, or null when there are none; release it when done. */
export interface TextHold {
  source: Promise<LineSource> | null
  release(): void
}

const NO_HOLD: TextHold = { source: null, release: () => undefined }

/** The lines of slice `id`: from the host that keeps its text, or (a host that cannot read lines) the whole text. */
async function sliceSource(host: Host, id: string): Promise<LineSource> {
  const { gcodeLineStarts, gcodeBytes } = host.slicer
  if (gcodeLineStarts && gcodeBytes) {
    const starts = await gcodeLineStarts.call(host.slicer, id)
    return rangeSource(starts, (a, b) => gcodeBytes.call(host.slicer, id, a, b))
  }
  const out = await host.slicer.exportGcode(id, { kind: 'blob' })
  if (!out.blob) throw new NoTextError('The G-code is not available in this app.')
  return wholeSource(await indexLines(new Uint8Array(await out.blob.arrayBuffer())))
}

/**
 * Holds the lines behind what Preview shows now. A slice's line starts are read on the first hold and shared by
 * every hold at the same time; they are let go once the last one is released.
 */
export function holdText(host: Host): TextHold {
  const s = get()
  const file = gcodeView.getState().file
  if (file && held?.key.startsWith('file:')) return { source: held.source, release: () => undefined }
  if (s.slice.status !== 'done') return NO_HOLD
  const r = s.slice.result
  const key = `slice:${r.id}`
  if (held?.key !== key) {
    if (r.gcodeFormat === 'bgcode') return { source: Promise.reject(new NoTextError('This printer takes binary G-code, which has no text lines to show.')), release: () => undefined }
    const source = sliceSource(host, r.id)
    held = { key, source, users: 0 }
    // A failed load is not kept, so the next hold tries again.
    source.catch(() => {
      if (held?.key === key) held = null
    })
  }
  const h = held!
  h.users++
  let done = false
  return {
    source: h.source,
    release: () => {
      if (done) return
      done = true
      h.users--
      if (h.users <= 0 && held === h) held = null
    },
  }
}

/** Whether a slice's lines are held now (for tests). */
export function textHeld(): boolean {
  return held !== null && held.key.startsWith('slice:')
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
    held = { key: `file:${ref.name}:${bytes.length}`, source: Promise.resolve(wholeSource(index)), users: 0 }
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
