// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// heimdall in the app: what a strike holds back, the marks it leaves, the jump to its moment, the one-click fixes, the
// Print sheet's checks and the list in Preview.
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { SXPV_HEADER_BYTES, SXPV_MAGIC, SXPV_SEGMENT_BYTES, SXPV_VERSION, readPreview, type Collision, type CollisionFix, type Host, type PreviewBuffers, type SliceResult } from '@slicerx/contracts'
import { applyCollisionFix, closeCalls, collisionsOf, collisionTime, fixesOf, jumpToCollision, printBlock, strikeMarks } from '../src/plate/heimdall'
import { preflight } from '../src/plate/preflight'
import { get, set } from '../src/state/store'
import { HostContext } from '../src/host'
import { CollisionList } from '../src/workspaces/preview/collision-list'

/** `layers` layers of `segs` 10 mm segments each, 100 mm/s, 10 s a layer. */
function preview(layers: number, segs: number): PreviewBuffers {
  const S = layers * segs
  const raw = new ArrayBuffer(SXPV_HEADER_BYTES + (layers + 1) * 4 + layers * 8 + S * SXPV_SEGMENT_BYTES)
  const dv = new DataView(raw)
  dv.setUint32(0, SXPV_MAGIC, true)
  dv.setUint16(4, SXPV_VERSION, true)
  dv.setUint32(8, S, true)
  dv.setUint32(12, layers, true)
  dv.setUint32(20, 1, true)
  dv.setFloat32(24, 0.2, true)
  let o = SXPV_HEADER_BYTES
  for (let k = 0; k <= layers; k++) dv.setUint32(o + k * 4, k * segs, true)
  o += (layers + 1) * 4
  for (let k = 0; k < layers; k++) dv.setFloat32(o + k * 4, 0.2 * (k + 1), true)
  o += layers * 4
  for (let k = 0; k < layers; k++) dv.setFloat32(o + k * 4, 10, true)
  o += layers * 4
  for (let k = 0; k < layers; k++)
    for (let i = 0; i < segs; i++) {
      dv.setFloat32(o, i * 10, true)
      dv.setFloat32(o + 8, i * 10 + 10, true)
      dv.setFloat32(o + 16, 0.2 * (k + 1), true)
      dv.setUint16(o + 20, 400, true)
      dv.setUint16(o + 22, 200, true)
      dv.setUint16(o + 26, 1000, true)
      o += SXPV_SEGMENT_BYTES
    }
  return readPreview(raw)
}

const hit: Collision = { kind: 'gantry', severity: 'hit', part: 'gantry', title: 'The gantry hits Tall', detail: 'Tall is 48.0 mm tall.', objectId: 'low', hitId: 'tall', layer: 2, segment: 5, timeS: 25, lastLayer: 3, at: [50, 50, 0.6], point: [20, 40, 40.6], worstLayer: 2, worstPoint: [21, 41, 40.6], depthMm: 7.4 }
const close: Collision = { ...hit, kind: 'hotend', severity: 'close', part: 'toolhead', title: 'The toolhead passes close to Tall', detail: 'Inside the margin.', worstPoint: [30, 30, 3] }
const reorder: CollisionFix = { kind: 'reorder', title: 'Print Tall last', detail: 'Order: Low, Tall. Clears it.', costS: 0, clears: [0], oneClick: true, order: ['low', 'tall'] }
const byLayer: CollisionFix = { kind: 'by_layer', title: 'Print by layer', detail: 'Clears it.', costS: 840, clears: [0], oneClick: true }
const spread: CollisionFix = { kind: 'spread', title: 'Space the objects 22 mm wider', detail: 'Clears the toolhead strike.', costS: 0, clears: [1], oneClick: false, mm: 22 }
const result = (collisions: Collision[], fixes: CollisionFix[] = []) => ({ id: 'r', engine: 'sx', layerCount: 4, layerZ: new Float32Array([0.2, 0.4, 0.6, 0.8]), layerTimeS: new Float32Array([10, 10, 10, 10]), stats: { timeS: 40, filamentMm: [1], filamentG: [1], cost: 0, toolChanges: 0 }, stageMicros: {}, wallMs: 1, warnings: [], collisions, collisionFixes: fixes }) as SliceResult
/** A 20 mm box as a plate entry. */
function entry(id: string, name: string) {
  const p = [0, 0, 0, 20, 0, 0, 20, 20, 0, 0, 20, 0, 0, 0, 20, 20, 0, 20, 20, 20, 20, 0, 20, 20]
  const i = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 2, 3, 7, 2, 7, 6, 1, 2, 6, 1, 6, 5, 3, 0, 4, 3, 4, 7]
  const handle = { id, hash: id, name, triangles: 12, bboxMm: [20, 20, 20], openEdges: 0, parts: [{ name: 'box', slot: 1, triangles: 12 }] }
  return { id, name, handle, parts: [{ name: 'box', slot: 1, positions: new Float32Array(p), indices: new Uint32Array(i) }], colors: [], transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] } as never
}

describe('heimdall in the app', () => {
  it('holds Print back on a hit and only warns on a close call', () => {
    set({ plate: [entry('tall', 'Tall'), entry('low', 'Low')], slice: { status: 'done', result: result([hit, close]), stale: false } })
    expect(printBlock(get())).toBe('heimdall found a collision: The gantry hits Tall. Apply a fix in Preview, or change the plate, and slice again.')
    set({ slice: { status: 'done', result: result([close]), stale: false } })
    expect(printBlock(get())).toBeNull()
    expect(closeCalls(get())).toEqual(["Low passes within the printer profile's clearance of Tall. The head's own shape clears it."])
    set({ slice: { status: 'idle' } })
    expect(printBlock(get())).toBeNull()
    // Store selectors: the same empty lists every time, so a component reading them renders once.
    set({ slice: { status: 'done', result: { ...result([]), collisions: undefined, collisionFixes: undefined } as SliceResult, stale: false } })
    expect(collisionsOf(get())).toBe(collisionsOf(get()))
    expect(fixesOf(get())).toBe(fixesOf(get()))
  })

  it('marks each strike where it goes deepest, the picked one selected, close calls apart', () => {
    set({ slice: { status: 'done', result: result([hit, close]), stale: false }, strikePick: 1 })
    expect(strikeMarks(get())).toEqual([{ x: 21, y: 41, z: 40.6 }, { x: 30, y: 30, z: 3, close: true, selected: true }])
  })

  it('jumps to the moment: the layer, the move in it, the head shown and the playback stop', () => {
    set({ slice: { status: 'done', result: result([hit]), stale: false }, preview: preview(4, 10), showToolhead: false, layerLo: 3, strikePick: null, strikeJump: null, profile: null })
    jumpToCollision(0)
    const s = get()
    expect(s).toMatchObject({ strikePick: 0, showToolhead: true, layerLo: 1, layerHi: 3, moveCut: 0.55, toolChange: null })
    // Two layers of 10 s and the middle of the third layer's sixth move.
    expect(s.strikeJump?.timeS).toBeCloseTo(25.5, 6)
    expect(collisionTime(s, hit)).toBeCloseTo(25.5, 6)
    jumpToCollision(0)
    expect(get().strikeJump?.seq).toBeGreaterThan(s.strikeJump!.seq)
  })

  it('applies a new order and print by layer with one click, then slices again; the rest only explain', async () => {
    const slice = vi.fn(async () => result([]))
    const host = { kind: 'web', capabilities: { threads: 1 }, slicer: { slice, loadParts: async () => ({ id: 'm' }), getPreview: async () => new ArrayBuffer(0) } } as unknown as Host
    set({ plate: [entry('tall', 'Tall'), entry('low', 'Low')], plates: [{ id: 'p1', name: 'Plate 1', objects: [], settings: { sequence: 'by-object' } }] as never, activePlate: 'p1', slice: { status: 'done', result: result([hit], [reorder, byLayer, spread]), stale: false } })
    await applyCollisionFix(host, reorder).catch(() => {})
    expect(get().plate.map((p) => (p as { id: string }).id)).toEqual(['low', 'tall'])
    expect(slice).toHaveBeenCalledTimes(1)
    await applyCollisionFix(host, byLayer).catch(() => {})
    expect(get().plates[0]!.settings.sequence).toBe('by-layer')
    expect(slice).toHaveBeenCalledTimes(2)
    await applyCollisionFix(host, spread)
    expect(slice).toHaveBeenCalledTimes(2)
  })

  it('puts hits among the Print sheet errors and close calls among its warnings', () => {
    const r = preflight({
      printer: { id: 'p', name: 'Bay', vendor: 'Bambu Lab', model: 'A1', plugin: 'bambu-lan', host: '192.0.2.1', nozzleCount: 1 },
      status: null,
      config: {},
      plateBounds: null,
      plateBed: { widthMm: 256, depthMm: 256, heightMm: 256 },
      file: { name: 'x.gcode', sha256: 'ab'.repeat(32), layers: 4, timeS: 40, grams: 1 },
      collisions: [hit, close],
    })
    expect(r.errors).toContain('The gantry hits Tall, layer 3. Tall is 48.0 mm tall. Fix it in Preview and slice again.')
    expect(r.warnings).toContain('The toolhead passes close to Tall. Inside the margin.')
  })

  it('lists the strikes with when and how deep, a jump for each, and the fixes with their cost', () => {
    set({ plate: [entry('tall', 'Tall'), entry('low', 'Low')], slice: { status: 'done', result: result([hit, close], [reorder, byLayer, spread]), stale: false }, preview: preview(4, 10), strikePick: null })
    const el = document.createElement('div')
    document.body.append(el)
    const root = createRoot(el)
    flushSync(() => root.render(createElement(HostContext.Provider, { value: {} as Host }, createElement(CollisionList))))
    expect(el.querySelector('.strike-tag')?.textContent).toBe('1 strike on this plate')
    const items = [...el.querySelectorAll('.strikes li')]
    expect(items).toHaveLength(2)
    expect(items[0]!.textContent).toContain('The gantry hits Tall')
    expect(items[0]!.querySelector('.strike-when')?.textContent).toBe('Gantry, from 0:25, layers 3 to 4, 7.4 mm deep')
    expect(items[1]!.querySelector('.strike-when')?.textContent).toContain('inside the margin')
    const fixes = [...el.querySelectorAll('.strike-fixes li')]
    expect(fixes.map((f) => f.querySelector('b')?.textContent)).toEqual(['Print Tall last', 'Print by layer', 'Space the objects 22 mm wider'])
    expect(fixes[1]!.textContent).toContain('+14 min')
    // Only the safe fixes have a button.
    expect(fixes.map((f) => f.querySelector('button') !== null)).toEqual([true, true, false])
    flushSync(() => (items[0]!.querySelector('button') as HTMLButtonElement).click())
    expect(get().strikePick).toBe(0)
    flushSync(() => root.unmount())
    el.remove()
  })
})
