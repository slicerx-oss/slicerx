// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Paint from a texture and the crossing check's rebuild: whether the rebuild lands after the texture paint or while the
// engine is painting, every face of the rebuilt mesh ends up in the filament of the box it belongs to. Two boxes in one
// part cross each other, box A red and box B green in the texture's materials; the rebuild is the engine's own answer
// for them (sx-geom import.selfIntersections, perShell false). Runs the real geometry engine
// (packages/geom/wasm/pkg); skips without one, except on CI.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Host, MeshPart } from '@slicerx/contracts'
import { decodeTree, leavesOf } from '@slicerx/viewport'
import { setGeomProvider, type GeomProvider } from '../src/geom/client'
import { history, inStep } from '../src/plate/history'
import { switchPlate } from '../src/plate/plates'
import { commitStroke } from '../src/plate/paint'
import { forgetTexture, paintOpenedFromTexture, textureRepaints, type TextureSource } from '../src/plate/texture-paint'
import { checkCrossings, type CrossingRunner, type Quiet } from '../src/state/import-auto'
import { get, set, type PlateEntry } from '../src/state/store'
import { liveEngine, wasmGeom } from './geom-engine'

type V3 = [number, number, number]

// Box A [0,20]^3 and box B [10,30]^3 in one part, and the rebuilt mesh without the crossings: every triangle has a new
// number, and the faces of each box inside the other are gone.
const before = {
  positions: [0, 0, 0, 20, 0, 0, 0, 20, 0, 20, 20, 0, 0, 0, 20, 20, 0, 20, 0, 20, 20, 20, 20, 20, 10, 10, 10, 30, 10, 10, 10, 30, 10, 30, 30, 10, 10, 10, 30, 30, 10, 30, 10, 30, 30, 30, 30, 30],
  indices: [0, 2, 3, 0, 3, 1, 4, 5, 7, 4, 7, 6, 0, 1, 5, 0, 5, 4, 2, 6, 7, 2, 7, 3, 0, 4, 6, 0, 6, 2, 1, 3, 7, 1, 7, 5, 8, 10, 11, 8, 11, 9, 12, 13, 15, 12, 15, 14, 8, 9, 13, 8, 13, 12, 10, 14, 15, 10, 15, 11, 8, 12, 14, 8, 14, 10, 9, 11, 15, 9, 15, 13],
}
const rebuilt = {
  positions: [0, 0, 0, 0, 0, 20, 10, 10, 20, 10, 10, 30, 0, 20, 0, 10, 20, 10, 10, 30, 10, 0, 20, 20, 10, 20, 20, 10, 30, 30, 20, 0, 0, 20, 10, 10, 30, 10, 10, 20, 0, 20, 20, 10, 20, 30, 10, 30, 20, 20, 0, 20, 20, 10, 30, 30, 10, 30, 30, 30],
  indices: [0, 1, 7, 0, 13, 1, 0, 7, 4, 0, 4, 16, 0, 10, 13, 0, 16, 10, 7, 1, 2, 2, 1, 13, 3, 8, 2, 2, 14, 3, 5, 4, 7, 16, 4, 5, 5, 8, 6, 6, 17, 5, 8, 7, 2, 7, 8, 5, 8, 3, 9, 6, 8, 9, 13, 10, 11, 11, 10, 16, 12, 14, 11, 11, 17, 12, 13, 14, 2, 14, 13, 11, 3, 14, 15, 14, 12, 15, 17, 16, 5, 16, 17, 11, 17, 6, 18, 12, 17, 18, 3, 19, 9, 6, 9, 19, 3, 15, 19, 12, 19, 15, 6, 19, 18, 12, 18, 19],
}

const RED = '#e6141e'
const GREEN = '#14c828'

/** Box C, a part of its own: box A moved 50 mm along x. */
const boxC = { positions: before.positions.slice(0, 24).map((v, k) => (k % 3 === 0 ? v + 50 : v)), indices: before.indices.slice(0, 36) }

/** A second pair of crossing boxes, the first moved 100 mm along x, and its rebuild. */
const shift = (v: number[]) => v.map((x, k) => (k % 3 === 0 ? x + 100 : x))
const before2 = { positions: shift(before.positions), indices: before.indices }
const rebuilt2 = { positions: shift(rebuilt.positions), indices: rebuilt.indices }

/**
 * The boxes as an OBJ: box A in a red material and box B in a green one, box C in green, and the second pair as the
 * first.
 */
function source(): TextureSource {
  const p = [...before.positions, ...boxC.positions, ...before2.positions]
  const v = Array.from({ length: p.length / 3 }, (_, i) => `v ${p[i * 3]} ${p[i * 3 + 1]} ${p[i * 3 + 2]}`)
  const f = (from: number) => Array.from({ length: 12 }, (_, t) => `f ${before.indices.slice((from + t) * 3, (from + t) * 3 + 3).map((i) => i + 1).join(' ')}`)
  const c = Array.from({ length: 12 }, (_, t) => `f ${boxC.indices.slice(t * 3, t * 3 + 3).map((i) => i + 17).join(' ')}`)
  const f2 = (from: number) => Array.from({ length: 12 }, (_, t) => `f ${before.indices.slice((from + t) * 3, (from + t) * 3 + 3).map((i) => i + 25).join(' ')}`)
  const obj = ['mtllib boxes.mtl', ...v, 'usemtl red', ...f(0), 'usemtl green', ...f(12), ...c, 'usemtl red', ...f2(0), 'usemtl green', ...f2(12), ''].join('\n')
  const mtl = 'newmtl red\nKd 0.902 0.078 0.118\nnewmtl green\nKd 0.078 0.784 0.157\n'
  const enc = new TextEncoder()
  return { kind: 'obj', name: 'boxes.obj', obj: enc.encode(obj), files: { 'boxes.mtl': enc.encode(mtl) } }
}

const part = (): MeshPart => ({ name: 'boxes', slot: 1, positions: new Float32Array(before.positions), indices: new Uint32Array(before.indices) })
const part2 = (): MeshPart => ({ name: 'boxes2', slot: 1, positions: new Float32Array(before2.positions), indices: new Uint32Array(before2.indices) })
const partC = (): MeshPart => ({ name: 'c', slot: 1, positions: new Float32Array(boxC.positions), indices: new Uint32Array(boxC.indices) })
const entry = (...parts: MeshPart[]): PlateEntry => ({ id: 'o', name: 'o', handle: { id: 'o#0', hash: 'o', name: 'o', triangles: 24, bboxMm: [30, 30, 30], openEdges: 0, parts: parts.map((p) => ({ name: p.name, slot: p.slot, triangles: p.indices.length / 3 })) }, parts, colors: ['#fff'], transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }) as PlateEntry
const host = { slicer: { loadParts: async (name: string, parts: MeshPart[]) => ({ id: `${name}#1`, name, parts: parts.map((p) => ({ name: p.name, slot: p.slot, triangles: p.indices.length / 3 })), triangles: 36, bboxMm: [30, 30, 30], hash: name, openEdges: 0 }), release: () => undefined } } as unknown as Host
const quiet: Quiet = { wait: async () => undefined, onBusy: () => () => undefined }
// only the crossing boxes cross; box C does not
const cross: CrossingRunner = async (p) => (p.name === 'boxes' ? { crossing: true, mesh: rebuilt } : { crossing: false })
// the open's undo step, as addAutoImport hands it to the crossing check
const openStep = () => {
  const token = {}
  return (fn: () => void) => inStep(token, fn)
}

function plain(v: unknown): unknown {
  if (ArrayBuffer.isView(v)) return Array.from(v as unknown as ArrayLike<number>)
  if (Array.isArray(v)) return v.map(plain)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, e]) => [k, plain(e)]))
  return v
}

/**
 * Every face of the object's mesh in the filament of its box: B's faces are the ones reaching past 20 mm, the rest are
 * A's (the rebuilt mesh keeps no face inside both). Answers the faces in the wrong filament.
 */
function triangleOf(p: MeshPart, t: number): [V3, V3, V3] {
  const corner = (k: number): V3 => {
    const i = p.indices[t * 3 + k]! * 3
    return [p.positions[i]!, p.positions[i + 1]!, p.positions[i + 2]!]
  }
  return [corner(0), corner(1), corner(2)]
}

function wrongFaces(e: PlateEntry, k = 0, dx = 0, as: (want: number) => number = (w) => w): string[] {
  const p = e.parts[k]!
  const own = e.slotOverrides?.[p.name] ?? p.slot
  const texts = e.paint?.[k]?.color ?? {}
  const wrong: string[] = []
  for (let t = 0; t < p.indices.length / 3; t++) {
    const tri = triangleOf(p, t)
    const mid = [0, 1, 2].map((j) => (tri[0][j]! + tri[1][j]! + tri[2][j]! - (j === 0 ? 3 * dx : 0)) / 3)
    const want = as(mid.some((c) => c > 20 + 1e-6) ? 2 : 1)
    const text = texts[t]
    const got = text ? [...new Set(leavesOf(tri, decodeTree(text)!).map((l) => l.state || own))] : [own]
    if (got.length !== 1 || got[0] !== want) wrong.push(`${t} ${mid.map((c) => c.toFixed(1)).join(',')}: ${got.join('/')} for ${want}`)
  }
  return wrong
}

describe.skipIf(!liveEngine)('paint from a texture and the crossing rebuild', () => {
  let wasm: GeomProvider
  beforeAll(async () => {
    const w = await wasmGeom()
    wasm = { call: (op, request) => w.call(op, plain(request)) }
    setGeomProvider(wasm)
  })
  afterAll(() => setGeomProvider(null))
  beforeEach(() => {
    forgetTexture('o')
    set({ plate: [], plates: [{ id: 'p', name: 'Plate 1', objects: [], settings: {} }], activePlate: 'p', printerSlots: [], fileSlotColors: [], toast: null, openNote: null, slotSetup: { 1: { type: 'PLA', brand: '', color: RED }, 2: { type: 'PLA', brand: '', color: GREEN } } })
    history().clear()
    setGeomProvider(wasm)
  })

  it('paints the boxes in their own filaments before any rebuild', async () => {
    set({ plate: [entry(part())] })
    expect(await paintOpenedFromTexture(['o'], source())).toEqual([1, 2])
    expect(wrongFaces(get().plate[0]!)).toEqual([])
  })

  it('paints the rebuilt mesh again when the rebuild lands after the texture paint, in the rebuild\'s undo step', async () => {
    const old = part()
    set({ plate: [entry(old)] })
    await paintOpenedFromTexture(['o'], source())
    const painted = get().plate[0]!.paint
    const steps = history().state().undo
    expect(await checkCrossings(host, 'boxes.obj', [{ id: 'o', perShell: false }], cross, openStep(), quiet)).toEqual({ fixed: 1, left: 0 })
    await textureRepaints()
    const o = get().plate[0]!
    expect(o.parts[0]!.indices.length).toBe(rebuilt.indices.length)
    expect(wrongFaces(o)).toEqual([])
    // one Undo takes the rebuild and its repaint back together: the old mesh with the texture's paint on it
    expect(history().state().undo).toBe(steps + 1)
    history().undo()
    expect(get().plate[0]!.parts[0]).toBe(old)
    expect(get().plate[0]!.paint).toEqual(painted)
  })

  it('leaves paint brushed after the texture paint alone when the rebuild lands', async () => {
    set({ plate: [entry(part())] })
    await paintOpenedFromTexture(['o'], source())
    commitStroke({ objectId: 'o', partIndex: 0, layer: 'color', edits: [{ triangle: 2, after: '4' }] })
    const steps = history().state().undo
    await checkCrossings(host, 'boxes.obj', [{ id: 'o', perShell: false }], cross, openStep(), quiet)
    // the stroke is the person's: the paint stays as the rebuild left it (kept by number, or carried onto the new
    // triangles), the stroke's own filament 1 with it, and nothing is painted again
    const left = get().plate[0]!.paint
    await textureRepaints()
    const p = get().plate[0]!
    expect(p.paint).toBe(left)
    expect(Object.entries(p.paint![0]!.color!).some(([t, text]) => leavesOf(triangleOf(p.parts[0]!, Number(t)), decodeTree(text)!).some((l) => l.state === 1))).toBe(true)
    expect(history().state().undo).toBe(steps + 1)
  })

  it('paints only the rebuilt part again: a stroke and the own filament on another part stay', async () => {
    set({ plate: [entry(part(), partC())] })
    await paintOpenedFromTexture(['o'], source())
    // the person brushes box C and gives it filament 1 of its own
    commitStroke({ objectId: 'o', partIndex: 1, layer: 'color', edits: [{ triangle: 0, after: '4' }] })
    set((s) => ({ plate: s.plate.map((e) => ({ ...e, slotOverrides: { ...e.slotOverrides, c: 1 } })) }))
    const c = get().plate[0]!.paint?.[1]
    await checkCrossings(host, 'boxes.obj', [{ id: 'o', perShell: false }], cross, openStep(), quiet)
    await textureRepaints()
    const o = get().plate[0]!
    expect(wrongFaces(o)).toEqual([])
    expect(o.paint?.[1]).toBe(c)
    expect(o.paint?.[1]?.color?.[0]).toBe('4')
    expect(o.slotOverrides?.['c']).toBe(1)
  })

  it('does not paint again when a tool rebakes the parts on purpose and keeps or clears their paint', async () => {
    set({ plate: [entry(part(), partC())] })
    await paintOpenedFromTexture(['o'], source())
    // as Raise text does on a turned object: every part rebaked in the turn, same triangle order, the paint of the part
    // that gets the text (box C) cleared and the boxes' paint kept as it is
    const turn = (p: MeshPart): MeshPart => {
      const positions = new Float32Array(p.positions.length)
      for (let k = 0; k < p.positions.length; k += 3) {
        positions[k] = -p.positions[k + 1]!
        positions[k + 1] = p.positions[k]!
        positions[k + 2] = p.positions[k + 2]!
      }
      return { ...p, positions }
    }
    inStep({}, () =>
      set((s) => ({
        plate: s.plate.map((e) => ({ ...e, parts: e.parts.map(turn), paint: { 0: e.paint![0]! } })),
      })),
    )
    const after = get().plate[0]!
    const steps = history().state().undo
    await textureRepaints()
    expect(get().plate[0]).toBe(after)
    expect(get().plate[0]!.paint?.[1]).toBeUndefined()
    expect(history().state().undo).toBe(steps)
  })

  it('paints the rebuilt mesh when the rebuild lands while the engine paints', async () => {
    set({ plate: [entry(part())] })
    let rebuiltOnce = false
    setGeomProvider({
      call: async (op, request) => {
        if (op === 'paint.texture' && !rebuiltOnce) {
          rebuiltOnce = true
          // the crossing check swaps the part in while this answer is on its way
          await checkCrossings(host, 'boxes.obj', [{ id: 'o', perShell: false }], cross, undefined, quiet)
        }
        return wasm.call(op, request)
      },
    })
    expect(await paintOpenedFromTexture(['o'], source())).toEqual([1, 2])
    await textureRepaints()
    const o = get().plate[0]!
    expect(o.parts[0]!.indices.length).toBe(rebuilt.indices.length)
    expect(wrongFaces(o)).toEqual([])
  })

  /** The open's step for the crossing check, noting whether the rebuild kept the texture's paint by number. */
  const keptStep = () => {
    const before = get().plate[0]!.paint?.[0]?.color
    let kept: boolean | null = null
    const step = openStep()
    // the first change in the step is the rebuild's swap
    return { edit: (fn: () => void) => step(() => { fn(); kept ??= get().plate[0]!.paint?.[0]?.color === before }), kept: () => kept === true }
  }

  /**
   * The engine with something done to the project while the next paint.texture call is on its way. Answers whether
   * that call came: if the rebuild carries the paint onto its new triangles, the paint moves with the mesh, so nothing
   * is painted again and these cases only check the faces.
   */
  const duringNextPaint = (fn: () => void): (() => boolean) => {
    let done = false
    setGeomProvider({
      call: async (op, request) => {
        if (op === 'paint.texture' && !done) {
          done = true
          fn()
        }
        return wasm.call(op, request)
      },
    })
    return () => done
  }

  it('still paints the rebuilt part again when the object is moved while the engine paints, in a step of its own', async () => {
    set({ plate: [entry(part())] })
    await paintOpenedFromTexture(['o'], source())
    const steps = history().state().undo
    const step = keptStep()
    const ran = duringNextPaint(() => inStep({}, () => set((s) => ({ plate: s.plate.map((e) => ({ ...e, transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 40, 0, 0, 1] })) }))))
    await checkCrossings(host, 'boxes.obj', [{ id: 'o', perShell: false }], cross, step.edit, quiet)
    await textureRepaints()
    const o = get().plate[0]!
    expect(o.parts[0]!.indices.length).toBe(rebuilt.indices.length)
    expect(wrongFaces(o)).toEqual([])
    // paint kept by number is painted again; paint carried with the mesh is not
    expect(ran()).toBe(step.kept())
    if (!ran()) return
    expect(o.transform[12]).toBe(40)
    // the rebuild, the move, and the repaint
    expect(history().state().undo).toBe(steps + 3)
  })

  it('paints nothing back when the rebuild is undone while the engine paints', async () => {
    const old = part()
    set({ plate: [entry(old)] })
    await paintOpenedFromTexture(['o'], source())
    const painted = get().plate[0]!.paint
    const steps = history().state().undo
    const step = keptStep()
    const ran = duringNextPaint(() => history().undo())
    await checkCrossings(host, 'boxes.obj', [{ id: 'o', perShell: false }], cross, step.edit, quiet)
    await textureRepaints()
    expect(ran()).toBe(step.kept())
    if (!ran()) return void expect(wrongFaces(get().plate[0]!)).toEqual([])
    expect(get().plate[0]!.parts[0]).toBe(old)
    expect(get().plate[0]!.paint).toEqual(painted)
    expect(history().state()).toMatchObject({ undo: steps, redo: 1 })
  })

  it('stops when the rebuilt part is brushed while the engine paints', async () => {
    set({ plate: [entry(part())] })
    await paintOpenedFromTexture(['o'], source())
    const steps = history().state().undo
    let brushed: Record<number, string> | undefined
    const step = keptStep()
    const ran = duringNextPaint(() => {
      commitStroke({ objectId: 'o', partIndex: 0, layer: 'color', edits: [{ triangle: 0, after: '4' }] })
      brushed = get().plate[0]!.paint![0]!.color
    })
    await checkCrossings(host, 'boxes.obj', [{ id: 'o', perShell: false }], cross, step.edit, quiet)
    await textureRepaints()
    expect(ran()).toBe(step.kept())
    if (!ran()) return void expect(wrongFaces(get().plate[0]!)).toEqual([])
    // the rebuild and the stroke, and no repaint over the stroke
    expect(get().plate[0]!.paint![0]!.color).toBe(brushed)
    expect(history().state().undo).toBe(steps + 2)
  })

  it('keeps a stroke on a second crossing part through the first part\'s repaint and then its own rebuild', async () => {
    set({ plate: [entry(part(), part2())] })
    await paintOpenedFromTexture(['o'], source())
    expect(wrongFaces(get().plate[0]!, 1, 100)).toEqual([])
    commitStroke({ objectId: 'o', partIndex: 1, layer: 'color', edits: [{ triangle: 0, after: '4' }] })
    const only = (name: string, mesh: typeof rebuilt): CrossingRunner => async (p) => (p.name === name ? { crossing: true, mesh } : { crossing: false })
    await checkCrossings(host, 'boxes.obj', [{ id: 'o', perShell: false }], only('boxes', rebuilt), openStep(), quiet)
    await textureRepaints()
    expect(wrongFaces(get().plate[0]!)).toEqual([])
    await checkCrossings(host, 'boxes.obj', [{ id: 'o', perShell: false }], only('boxes2', rebuilt2), openStep(), quiet)
    // the second part's paint is the person's (the stroke): it stays as the rebuild left it, not painted again
    const left = get().plate[0]!.paint?.[1]
    await textureRepaints()
    expect(get().plate[0]!.paint?.[1]).toBe(left)
    expect(wrongFaces(get().plate[0]!)).toEqual([])
  })

  it('keeps the own filament the person gave a part after the texture paint when the part is painted again', async () => {
    set({ plate: [entry(part())] })
    await paintOpenedFromTexture(['o'], source())
    const e = get().plate[0]!
    // the texture's own filament for the part, and the other one, which the person picks
    const textureOwn = e.slotOverrides?.['boxes'] ?? e.parts[0]!.slot
    const mine = textureOwn === 2 ? 1 : 2
    inStep({}, () => set((s) => ({ plate: s.plate.map((x) => ({ ...x, slotOverrides: { ...x.slotOverrides, boxes: mine } })) })))
    const steps = history().state().undo
    const step = keptStep()
    await checkCrossings(host, 'boxes.obj', [{ id: 'o', perShell: false }], cross, step.edit, quiet)
    const left = get().plate[0]!.paint?.[0]?.color
    await textureRepaints()
    const o = get().plate[0]!
    expect(o.parts[0]!.indices.length).toBe(rebuilt.indices.length)
    expect(o.slotOverrides?.['boxes']).toBe(mine)
    // the faces the texture left to the part's own filament print in the person's; the others in the texture's
    expect(wrongFaces(o, 0, 0, (w) => (w === textureOwn ? mine : w))).toEqual([])
    if (!step.kept()) return
    // painted again, in the rebuild's step
    expect(o.paint?.[0]?.color).not.toBe(left)
    expect(history().state().undo).toBe(steps + 1)
  })

  it('paints a second crossing part again on its own rebuild after the first part\'s repaint', async () => {
    set({ plate: [entry(part(), part2())] })
    await paintOpenedFromTexture(['o'], source())
    const own2 = get().plate[0]!.slotOverrides?.['boxes2']
    const only = (name: string, mesh: typeof rebuilt): CrossingRunner => async (p) => (p.name === name ? { crossing: true, mesh } : { crossing: false })
    await checkCrossings(host, 'boxes.obj', [{ id: 'o', perShell: false }], only('boxes', rebuilt), openStep(), quiet)
    await textureRepaints()
    await checkCrossings(host, 'boxes.obj', [{ id: 'o', perShell: false }], only('boxes2', rebuilt2), openStep(), quiet)
    await textureRepaints()
    const o = get().plate[0]!
    expect(o.parts[1]!.indices.length).toBe(rebuilt2.indices.length)
    expect(wrongFaces(o)).toEqual([])
    expect(wrongFaces(o, 1, 100)).toEqual([])
    expect(o.slotOverrides?.['boxes2']).toBe(own2)
  })

  it('paints the rebuilt part again once its plate is shown again, when another plate was shown while the engine painted', async () => {
    set({ plate: [entry(part())], plates: [{ id: 'p', name: 'Plate 1', objects: [], settings: {} }, { id: 'q', name: 'Plate 2', objects: [], settings: {} }], activePlate: 'p' })
    await paintOpenedFromTexture(['o'], source())
    const step = keptStep()
    const ran = duringNextPaint(() => switchPlate('q'))
    await checkCrossings(host, 'boxes.obj', [{ id: 'o', perShell: false }], cross, step.edit, quiet)
    await textureRepaints()
    expect(ran()).toBe(step.kept())
    switchPlate('p')
    await textureRepaints()
    const o = get().plate[0]!
    expect(o.parts[0]!.indices.length).toBe(rebuilt.indices.length)
    expect(wrongFaces(o)).toEqual([])
  })
})
