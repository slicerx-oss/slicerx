// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { toolStore } from '../plate/tools'
import { get } from '../state/store'
import { gcodeView } from '../workspaces/preview/gcode-file'
import { lineAtNozzle, selectGcodeLine } from '../workspaces/preview/gcode-selection'
import { holdText, NoTextError } from '../workspaces/preview/gcode-source'
import { readGcodeWindow } from '../workspaces/preview/gcode-window'
import { LinkError } from './methods-error'
import { previewSource } from './preview-source'

function integer(value: unknown, name: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new LinkError('invalid_input', `${name} must be an integer between ${min} and ${max}`)
  return value
}

export async function previewGcode(args: Record<string, unknown>, jump: boolean) {
  const allowed = jump ? ['line', 'count'] : ['fromLine', 'count', 'byteOffset']
  if (Object.keys(args).some((k) => !allowed.includes(k))) throw new LinkError('invalid_input', `Give ${allowed.join(', ')}`)
  const line = jump ? integer(args['line'], 'line', 1) : args['fromLine'] === undefined ? undefined : integer(args['fromLine'], 'fromLine', 1)
  const count = args['count'] === undefined ? 40 : integer(args['count'], 'count', 1, 200)
  const byteOffset = args['byteOffset'] === undefined ? 0 : integer(args['byteOffset'], 'byteOffset', 0)
  if (byteOffset && line === undefined) throw new LinkError('invalid_input', 'fromLine is required with byteOffset')
  const before = get()
  const preview = before.preview
  if (!preview) throw new LinkError('not_ready', 'open a slice or G-code file in Preview first')
  const canJump = () => {
    const s = get()
    return s.workspace === 'prepare' && s.modelMode === 'slice' && s.sliceLook === 'toolpaths' && !s.objectTool && !['paint', 'brim', 'face'].includes(toolStore.getState().tool)
  }
  if (jump && !canJump()) throw new LinkError('busy', 'open the toolpath preview and finish the active object tool before selecting a line')
  if (jump && preview.extrasOffset < 0) throw new LinkError('refused', 'this preview has no G-code line mapping')
  const binding = previewSource()
  if (!binding) throw new LinkError('not_ready', 'the app has not attached its slice text reader')
  const host = binding.host
  const file = gcodeView.getState().file
  const slice = before.slice
  const same = () => get().preview === preview && get().slice === slice && gcodeView.getState().file === file && previewSource() === binding
  const hold = holdText(host)
  try {
    if (!hold.source) throw new LinkError('not_ready', 'the current preview has no G-code text')
    const source = await hold.source
    if (!same()) throw new LinkError('busy', 'the preview changed while its G-code was loading; read again')
    if (line !== undefined && line > source.count) throw new LinkError('invalid_input', `line must not exceed ${source.count}`)
    const from = line ?? Math.max(1, lineAtNozzle(preview, get().layerHi, get().moveCut))
    const window = await readGcodeWindow(source, from, count, byteOffset)
    if (!same()) throw new LinkError('busy', 'the preview changed while its G-code was loading; read again')
    if (jump) {
      if (!canJump()) throw new LinkError('busy', 'the view or active tool changed while its G-code was loading')
      selectGcodeLine(preview, line!)
    }
    const s = get()
    return {
      source: file ? { kind: 'file', name: file.name } : { kind: 'slice', id: slice.status === 'done' ? slice.result.id : null },
      totalLines: source.count, panelOpen: gcodeView.getState().panel, mapped: preview.extrasOffset >= 0,
      requestedLine: line ?? null, fromLine: from, byteOffset, currentLine: lineAtNozzle(preview, s.layerHi, s.moveCut), layer: s.layerHi, moveShare: s.moveCut,
      ...window,
    }
  } catch (e) {
    if (e instanceof NoTextError) throw new LinkError('refused', e.message)
    if (e instanceof RangeError) throw new LinkError('invalid_input', e.message)
    throw e
  } finally { hold.release() }
}
