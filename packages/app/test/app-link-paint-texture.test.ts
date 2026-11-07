// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// paint.from_texture over the app link, as a client calls it: a preview of color paint from the texture an object was
// opened with, nothing changed until paint.apply, which paints it as one Undo step. Refused for an object opened
// without a texture, for palette mode while a filament color is set by hand or by the printer, and when the project
// changed after the preview. Runs the real geometry engine (packages/geom/wasm/pkg); skips without one, except on CI.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FilamentSlot, FileRef, Host, MeshHandle, MeshPart } from '@slicerx/contracts'
import { runCall } from '../src/app-link/methods'
import { setGeomProvider } from '../src/geom/client'
import { history, inStep } from '../src/plate/history'
import { commitStroke } from '../src/plate/paint'
import { toolStore } from '../src/plate/tools'
import { paletteAllowed } from '../src/plate/texture-paint'
import { addFileRefs } from '../src/state/open-models'
import { get, set } from '../src/state/store'
import { liveEngine, wasmGeom } from './geom-engine'

const dir = join(__dirname, '..', '..', 'geom', 'tests', 'fixtures', 'texture')
const RGBW = ['#e6141e', '#14c828', '#1428dc', '#f5f5f5']
const client = { id: 'client', name: 'Test client' }
type Out = { preview: string; changed: boolean; filaments: { slot: number; areaMm2: number; color: string }[]; partSlots: { part: number; name: string; slot: number }[]; palette?: string[]; revision: string }
const call = (method: string, args: Record<string, unknown>) => runCall(`paint.${method}`, args, client) as Promise<{ summary: string; output: Out }>

function plain(v: unknown): unknown {
  if (ArrayBuffer.isView(v)) return Array.from(v as unknown as ArrayLike<number>)
  if (Array.isArray(v)) return v.map(plain)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, e]) => [k, plain(e)]))
  return v
}

describe('paint and its own filament from the open filament setup', () => {
  beforeEach(() => set({ plate: [], plates: [{ id: 'p', name: 'Plate 1', objects: [], settings: {} }], activePlate: 'p', printerSlots: [], slotSetup: {}, fileSlotColors: [] }))
  const slot = (o: Partial<FilamentSlot> = {}) => ({ id: 'A', ...o }) as FilamentSlot

  it('picks filament colors only when none is set by hand or by the printer, and two or more are there', () => {
    set({ printerSlots: [slot(), slot(), slot(), slot()] })
    expect(paletteAllowed()).toBe(true)
    set({ slotSetup: { 2: { type: 'PLA', brand: '', color: '#ff0000' } } })
    expect(paletteAllowed()).toBe(false)
    set({ slotSetup: {}, printerSlots: [slot(), slot({ material: 'PLA', color: '#00ff00' })] })
    expect(paletteAllowed()).toBe(false)
    set({ printerSlots: [] })
    expect(paletteAllowed()).toBe(false)
  })
})

describe.skipIf(!liveEngine)('paint.from_texture over the app link', () => {
  const slicer = {
    loadParts: async (name: string, parts: MeshPart[]): Promise<MeshHandle> => ({ id: name, hash: name, name, triangles: parts.reduce((n, p) => n + p.indices.length / 3, 0), bboxMm: [20, 20, 20], openEdges: 0, parts: parts.map((p) => ({ name: p.name, slot: p.slot, triangles: p.indices.length / 3 })) }),
    release: () => undefined,
  }
  const bytes = new Map<string, Uint8Array>()
  const host = { slicer, files: { read: async (r: FileRef) => bytes.get(r.name)!.slice().buffer } } as unknown as Host
  const ref = (name: string): FileRef => {
    bytes.set(name, new Uint8Array(readFileSync(join(dir, name))))
    return { id: name, name, size: bytes.get(name)!.length }
  }
  const open = async (...names: string[]) => {
    await addFileRefs(host, names.map(ref))
    // the open painted it; start the link from an unpainted cube
    if (get().plate[0]!.paint) history().undo()
    return get().plate[0]!
  }

  beforeAll(async () => {
    const wasm = await wasmGeom()
    setGeomProvider({ call: (op, request) => wasm.call(op, plain(request)) })
  })
  afterAll(() => setGeomProvider(null))
  beforeEach(() => {
    set({ plate: [], plates: [{ id: 'p', name: 'Plate 1', objects: [], settings: {} }], activePlate: 'p', printerSlots: [], fileSlotColors: [], slotSetup: Object.fromEntries(RGBW.map((color, i) => [i + 1, { type: 'PLA', brand: '', color }])), toast: null })
    toolStore.setState({ tool: 'move' })
    history().clear()
  })

  it('previews without a change, then applies the paint and the part filament as one Undo step', async () => {
    const e = await open('textured-cube.obj', 'textured-cube.mtl', 'quadrants.png')
    expect(e.paint).toBeUndefined()
    const steps = history().state().undo
    const pv = (await call('from_texture', { object: e.id })).output
    expect(get().plate[0]!.paint).toBeUndefined()
    expect(history().state().undo).toBe(steps)
    expect(pv.changed).toBe(true)
    expect(pv.filaments.map((f) => [f.slot, Math.round(f.areaMm2), f.color])).toEqual([[1, 900, RGBW[0]], [2, 500, RGBW[1]], [3, 500, RGBW[2]], [4, 500, RGBW[3]]])
    expect(pv.partSlots).toEqual([{ part: 0, name: e.parts[0]!.name, slot: 1 }])
    const toasts: string[] = []
    const applied = (await call('apply', { preview: pv.preview })).output
    if (get().toast) toasts.push(get().toast!.text)
    expect(applied.changed).toBe(true)
    expect(Object.keys(get().plate[0]!.paint?.[0]?.color ?? {}).length).toBeGreaterThan(0)
    expect(history().state().undo).toBe(steps + 1)
    expect(toasts).toEqual(['Painted from texture: 4 colors to filaments 1, 2, 3 and 4.'])
    // the same texture again changes nothing
    const again = (await call('from_texture', { object: e.id })).output
    expect(again.changed).toBe(false)
    expect((await call('apply', { preview: again.preview })).output.changed).toBe(false)
    expect(history().state().undo).toBe(steps + 1)
    history().undo()
    expect(get().plate[0]!.paint).toBeUndefined()
  })

  it('says not_found for an object opened without its texture', async () => {
    const e = await open('textured-cube.obj')
    await expect(call('from_texture', { object: e.id })).rejects.toMatchObject({ code: 'not_found' })
  })

  it('refuses palette mode while a filament color is set by hand', async () => {
    const e = await open('textured-cube.obj', 'textured-cube.mtl', 'quadrants.png')
    await expect(call('from_texture', { object: e.id, mode: 'palette' })).rejects.toMatchObject({ code: 'refused' })
  })

  it('picks the filament colors from the texture in palette mode and sets them on apply, each keeping its type', async () => {
    const types = ['PETG', 'ABS', 'PLA', 'TPU']
    set({ slotSetup: {}, printerSlots: [{ id: '1' }, { id: '2' }, { id: '3' }, { id: '4' }] as FilamentSlot[], fileSlotTypes: types })
    const e = await open('textured-cube.obj', 'textured-cube.mtl', 'quadrants.png')
    const steps = history().state().undo
    const pv = (await call('from_texture', { object: e.id, mode: 'palette' })).output
    expect(pv.palette).toHaveLength(4)
    expect(pv.changed).toBe(true)
    await call('apply', { preview: pv.preview })
    expect([1, 2, 3, 4].map((i) => [get().slotSetup[i]?.type, get().slotSetup[i]?.color])).toEqual(types.map((t, i) => [t, pv.palette![i]]))
    expect(Object.keys(get().plate[0]!.paint?.[0]?.color ?? {}).length).toBeGreaterThan(0)
    expect(history().state().undo).toBe(steps + 1)
    history().undo()
    expect(get().slotSetup).toEqual({})
    expect(get().plate[0]!.paint).toBeUndefined()
    expect(history().state().undo).toBe(steps)
  })

  it('refuses a preview applied after the project changed', async () => {
    const e = await open('textured-cube.obj', 'textured-cube.mtl', 'quadrants.png')
    const pv = (await call('from_texture', { object: e.id })).output
    inStep({}, () => commitStroke({ objectId: e.id, partIndex: 0, layer: 'seam', edits: [{ triangle: 0, after: '4' }] }))
    await expect(call('apply', { preview: pv.preview })).rejects.toMatchObject({ code: 'busy' })
  })
})
