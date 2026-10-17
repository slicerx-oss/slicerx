// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { Host } from '@slicerx/contracts'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { APP_LINK_METHODS, runCall } from '../src/app-link/methods'
import { bindPreviewSource, previewSource } from '../src/app-link/preview-source'
import { history } from '../src/plate/history'
import { toolStore } from '../src/plate/tools'
import { get, set } from '../src/state/store'
import { gcodeView } from '../src/workspaces/preview/gcode-file'
import { indexLines } from '../src/workspaces/preview/gcode-lines'
import { parseGcodePreview } from '../src/workspaces/preview/gcode-parse'
import { closeFile, openGcodeFile, textHeld } from '../src/workspaces/preview/gcode-source'
import { jumpToLine } from '../src/workspaces/preview/gcode-panel'

const TEXT = 'G90\nM83\n;LAYER_CHANGE\nG1 Z0.2\nG1 X0 Y0 F6000\nG1 X10 Y0 E1 F1200\nG1 X10 Y10 E1\n;LAYER_CHANGE\nG1 Z0.4\nG1 X0 Y10 E1\n'
const enc = new TextEncoder()
const read = (args: Record<string, unknown> = {}) => runCall('preview.gcode', args)
const jump = (args: Record<string, unknown>) => runCall('preview.gcode_jump', args)
let release: (() => void) | undefined
async function fixture() {
  const ix = await indexLines(enc.encode(TEXT))
  const { preview } = await parseGcodePreview(ix)
  const bytes = vi.fn(async (_id: string, a: number, b: number) => ix.bytes.slice(a, b))
  const host = { slicer: { gcodeLineStarts: async () => ix.starts, gcodeBytes: bytes }, files: { read: async () => enc.encode(TEXT).buffer } } as unknown as Host
  set({ preview, layerHi: preview.layerCount, moveCut: 1, slice: { status: 'done', result: { id: 'gcode-test', layerCount: preview.layerCount } } as never })
  release = bindPreviewSource(host)
  return { host, preview, ix, bytes }
}
beforeEach(() => { set({ workspace: 'prepare', modelMode: 'slice', sliceLook: 'toolpaths', objectTool: null, preview: null, slice: { status: 'idle' }, toolChange: null }); toolStore.setState({ tool: 'select' }) })
afterEach(() => { release?.(); release = undefined; closeFile(); set({ preview: null, slice: { status: 'idle' }, toolChange: null, objectTool: null }); gcodeView.setState({ panel: false }); toolStore.setState({ tool: 'select' }) })

it('reads host text and independently reads a line jump without changing history or opening the panel', async () => {
  const { bytes } = await fixture()
  const revision = history().state().revision
  expect(APP_LINK_METHODS['preview.gcode']).toBe('read')
  expect(APP_LINK_METHODS['preview.gcode_jump']).toBe('read')
  expect(await read({ fromLine: 1, count: 2 })).toMatchObject({ source: { kind: 'slice', id: 'gcode-test' }, totalLines: 10, lines: [{ number: 1, text: 'G90' }, { number: 2, text: 'M83' }], next: { fromLine: 3, byteOffset: 0 } })
  expect(bytes).toHaveBeenLastCalledWith('gcode-test', 0, 8)
  expect(await jump({ line: 6, count: 1 })).toMatchObject({ requestedLine: 6, currentLine: 6, layer: 1, panelOpen: false, lines: [{ number: 6, text: 'G1 X10 Y0 E1 F1200' }] })
  expect(await read({ count: 1 })).toMatchObject({ currentLine: 6, fromLine: 6, lines: [{ number: 6 }] })
  expect(await jump({ line: 1 })).toMatchObject({ currentLine: 0, layer: 1, moveShare: 0 })
  expect(history().state().revision).toBe(revision)
  expect(textHeld()).toBe(false)
})

it('clears a stale tool-change position when the panel jumps to an ordinary move', async () => {
  const { preview } = await fixture()
  set({ toolChange: { segment: 0, seconds: 1, fixed: 2 } })
  expect(jumpToLine(preview, 10)).toBe(true)
  expect(get().toolChange).toBeNull()
})

it('reads the standalone file actually open in Preview', async () => {
  const { host } = await fixture()
  await openGcodeFile(host, { id: 'file', name: 'part.gcode', size: TEXT.length })
  expect(await read({ fromLine: 2, count: 1 })).toMatchObject({ source: { kind: 'file', name: 'part.gcode' }, lines: [{ number: 2, text: 'M83' }] })
  expect(await jump({ line: 10 })).toMatchObject({ currentLine: 10, layer: 2 })
})

it('refuses bad inputs and unavailable mapping without changing the view', async () => {
  const { preview } = await fixture()
  const before = { layerHi: get().layerHi, moveCut: get().moveCut }
  for (const args of [{ line: 0 }, { line: 1.5 }, { line: 11 }, { line: 6, count: 201 }, { line: 6, unknown: true }]) await expect(jump(args)).rejects.toMatchObject({ code: 'invalid_input' })
  await expect(read({ byteOffset: 2 })).rejects.toMatchObject({ code: 'invalid_input' })
  await expect(read({ fromLine: 1, byteOffset: 100 })).rejects.toMatchObject({ code: 'invalid_input' })
  expect(get()).toMatchObject(before)
  set({ preview: { ...preview, extrasOffset: -1 } })
  await expect(jump({ line: 6 })).rejects.toMatchObject({ code: 'refused' })
  expect(textHeld()).toBe(false)
})

it('refuses binary or missing text and releases a failed read so it can retry', async () => {
  const { host } = await fixture()
  set({ slice: { status: 'done', result: { id: 'binary', gcodeFormat: 'bgcode' } } as never })
  await expect(read()).rejects.toMatchObject({ code: 'refused' })
  set({ slice: { status: 'idle' } })
  await expect(read()).rejects.toMatchObject({ code: 'not_ready' })
  set({ slice: { status: 'done', result: { id: 'failed' } } as never })
  const original = host.slicer.gcodeBytes!
  host.slicer.gcodeBytes = async () => { throw new Error('read failed') }
  await expect(read()).rejects.toThrow('read failed')
  expect(textHeld()).toBe(false)
  host.slicer.gcodeBytes = original
  expect(await read({ fromLine: 1, count: 1 })).toMatchObject({ lines: [{ text: 'G90' }] })
})

it('refuses a replaced source or changed host binding after an asynchronous read', async () => {
  for (const change of ['preview', 'binding'] as const) {
    const { host, ix, preview } = await fixture()
    let done!: () => void
    let entered!: () => void
    const reading = new Promise<void>((r) => { entered = r })
    host.slicer.gcodeBytes = async (_id, a, b) => { entered(); await new Promise<void>((r) => { done = r }); return ix.bytes.slice(a, b) }
    const pending = jump({ line: 6 })
    await reading
    const previous = release!
    if (change === 'preview') set({ preview: { ...preview }, layerHi: 2, moveCut: 0.25 })
    else { release = bindPreviewSource(host); previous(); expect(previewSource()?.host).toBe(host) }
    const before = { layerHi: get().layerHi, moveCut: get().moveCut }
    done()
    await expect(pending).rejects.toMatchObject({ code: 'busy' })
    expect(get()).toMatchObject(before)
    expect(textHeld()).toBe(false)
    release!()
  }
})

it('does not change the view if an object tool opens while text is loading', async () => {
  const { host, ix } = await fixture()
  host.slicer.gcodeBytes = async (_id, a, b) => { toolStore.setState({ tool: 'paint' }); return ix.bytes.slice(a, b) }
  const before = { layerHi: get().layerHi, moveCut: get().moveCut }
  await expect(jump({ line: 6 })).rejects.toMatchObject({ code: 'busy' })
  expect(get()).toMatchObject(before)
  expect(textHeld()).toBe(false)
})
