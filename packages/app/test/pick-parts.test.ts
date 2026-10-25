// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// One click on a collision or a warning picks the parts it names: they become the selection, a ring marks each on the
// bed while they stay selected, and the view frames them only when some of them are off screen. The read-back names
// the same parts by id, for a client to select them as the click does.
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Collision, Host, SliceResult, SliceWarning } from '@slicerx/contracts'
import { collisionsReadback } from '../src/app-link/ui'
import { HostContext } from '../src/host'
import { jumpToWarning } from '../src/lib/warning-actions'
import { collisionParts, strikeMarks } from '../src/plate/heimdall'
import { jumpTo, pickCollision } from '../src/plate/heimdall-jump'
import { isPicked, pickParts, pickRingsOf } from '../src/plate/pick-parts'
import { showRefusal, showSpot } from '../src/plate/preflight-show'
import { cancelSlice, slicePlate } from '../src/state/actions'
import { setCameraBus } from '../src/plate/tools'
import { get, set } from '../src/state/store'
import { CollisionList } from '../src/workspaces/preview/collision-list'

/** A 20 mm box as a plate entry, its footprint's corner at `x`, `y`. */
function entry(id: string, name: string, x = 0, y = 0) {
  const p = [0, 0, 0, 20, 0, 0, 20, 20, 0, 0, 20, 0, 0, 0, 20, 20, 0, 20, 20, 20, 20, 0, 20, 20]
  const i = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 2, 3, 7, 2, 7, 6, 1, 2, 6, 1, 6, 5, 3, 0, 4, 3, 4, 7]
  const handle = { id, hash: id, name, triangles: 12, bboxMm: [20, 20, 20], openEdges: 0, parts: [{ name: 'box', slot: 1, triangles: 12 }] }
  return { id, name, handle, parts: [{ name: 'box', slot: 1, positions: new Float32Array(p), indices: new Uint32Array(i) }], colors: [], transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, 0, 1] } as never
}

const strike: Collision = { kind: 'hotend', severity: 'hit', part: 'toolhead', objectId: 'b', hitId: 'a', layer: 2, segment: 5, timeS: 25, lastLayer: 3, at: [50, 50, 0.6], point: [20, 40, 4], worstLayer: 2, worstPoint: [21, 41, 4], depthMm: 2, hitHeightMm: 20 }
const keepOut: Collision = { ...strike, kind: 'keep_out', part: 'nozzle', objectId: 'c', hitId: 'exclusion-area', layer: 0, lastLayer: 4 }
const tower: Collision = { ...strike, kind: 'path_conflict', part: 'nozzle', objectId: 'prime-tower', hitId: 'gone' }
const result = (collisions: Collision[]) => ({ id: 'r', engine: 'sx', layerCount: 4, layerZ: new Float32Array([0.2, 0.4, 0.6, 0.8]), layerTimeS: new Float32Array([10, 10, 10, 10]), stats: { timeS: 40, filamentMm: [1], filamentG: [1], cost: 0, toolChanges: 0 }, stageMicros: {}, wallMs: 1, warnings: [], collisions, collisionFixes: [] }) as SliceResult

const camera = { showSelection: vi.fn(() => true), focusBedPoint: vi.fn() }

beforeEach(() => {
  camera.showSelection.mockClear()
  camera.focusBedPoint.mockClear()
  setCameraBus(camera)
  set({ workspace: 'prepare', modelMode: 'slice', overrides: {}, plate: [entry('a', 'Bracket', 10, 10), entry('b', 'Housing', 40, 10), entry('c', 'Clip', 150, 150)], selection: null, selectedIds: [], pickRing: null, strikePick: null, slice: { status: 'done', result: result([strike, keepOut, tower]), stale: false }, preview: null })
})
afterEach(() => setCameraBus(null))

describe('picking the parts a collision names', () => {
  it('names the plate objects of a collision, never a zone or the prime tower', () => {
    expect(collisionParts(get(), strike)).toEqual(['b', 'a'])
    expect(collisionParts(get(), keepOut)).toEqual(['c'])
    expect(collisionParts(get(), tower)).toEqual([])
    expect(collisionParts(get(), { objectId: 'a', hitId: 'a' })).toEqual(['a'])
  })

  it('selects them from the row, rings them, and asks the view to frame them when they are off screen', () => {
    expect(pickCollision(0)).toEqual(['b', 'a'])
    expect(get()).toMatchObject({ selection: 'b', selectedIds: ['b', 'a'], pickRing: ['b', 'a'], strikePick: 0, towerSelected: false })
    expect(camera.showSelection).toHaveBeenCalledTimes(1)
    expect(camera.showSelection).toHaveBeenCalledWith({ animate: true })
    expect(camera.focusBedPoint).not.toHaveBeenCalled()
    // The sliders stay where they are.
    expect(get().strikeJump).toBeNull()
    pickCollision(1)
    expect(get()).toMatchObject({ selectedIds: ['c'], pickRing: ['c'], strikePick: 1 })
    // Nothing on the plate to pick: the selection stays.
    expect(pickCollision(2)).toEqual([])
    expect(get().selectedIds).toEqual(['c'])
  })

  it('selects them on a jump too, and turns the camera to the strike instead of framing them', () => {
    jumpTo(0)
    expect(get()).toMatchObject({ selectedIds: ['b', 'a'], pickRing: ['b', 'a'], strikePick: 0 })
    expect(camera.showSelection).not.toHaveBeenCalled()
    expect(camera.focusBedPoint).toHaveBeenCalledWith(21, 41, 4, { animate: true })
  })

  it('rings each picked footprint on the bed while the parts are the selection, in Slice', () => {
    pickCollision(0)
    const rings = pickRingsOf(get())!
    expect(rings.map((r) => r.id)).toEqual(['b', 'a'])
    const xs = rings[1]!.hull.map((p) => p[0])
    expect([Math.min(...xs), Math.max(...xs)]).toEqual([10, 30])
    expect(rings[1]!.transform).toEqual(get().plate[0]!.transform)
    // In either order, and gone once the person selects something else or opens Model.
    set({ selection: 'a', selectedIds: ['a', 'b'] })
    expect(pickRingsOf(get())).not.toBeNull()
    set({ selection: 'a', selectedIds: ['a'] })
    expect(pickRingsOf(get())).toBeNull()
    set({ selection: 'b', selectedIds: ['b', 'a'], modelMode: 'design' })
    expect(pickRingsOf(get())).toBeNull()
  })

  it('draws the strike of picked parts smaller, so the ringed parts lead', () => {
    set({ layerHi: 99 })
    expect(strikeMarks(get()).some((m) => m.yield)).toBe(false)
    pickCollision(0)
    // both strikes name parts that are now the ringed selection; the keep-out one names Clip only
    expect(strikeMarks(get()).map((m) => m.yield === true)).toEqual([true, false, false])
    set({ selection: 'a', selectedIds: ['a'] })
    expect(strikeMarks(get()).some((m) => m.yield)).toBe(false)
  })

  it('leaves the ring to the clearance zones a by-object plate draws before it is sliced again', () => {
    set({ overrides: { print_sequence: 'by object', extruder_clearance_radius: 40, extruder_clearance_height_to_rod: 25, extruder_clearance_dist_to_rod: 56.5, extruder_clearance_height_to_lid: 256, skirt_loops: 0 } as never })
    pickCollision(0)
    expect(pickRingsOf(get())).not.toBeNull()
    set({ slice: { ...get().slice, stale: true } as never })
    expect(pickRingsOf(get())).toBeNull()
  })

  it('keeps ids off the plate out, and skips the ring when asked', () => {
    expect(pickParts(['gone', 'c', 'c', null])).toEqual(['c'])
    expect(get().pickRing).toEqual(['c'])
    expect(pickParts(['a', 'b'], { ring: false })).toEqual(['a', 'b'])
    expect(get().pickRing).toBeNull()
    expect(pickParts(['gone'])).toEqual([])
    expect(get().selectedIds).toEqual(['a', 'b'])
    expect(isPicked(get(), ['b', 'a'])).toBe(true)
    expect(isPicked(get(), ['a'])).toBe(false)
    expect(isPicked(get(), [])).toBe(false)
  })
})

describe('the collision row', () => {
  it('is one button per strike that reads as pressed while its parts are the selection', () => {
    const el = document.createElement('div')
    document.body.append(el)
    const root = createRoot(el)
    flushSync(() => root.render(createElement(HostContext.Provider, { value: {} as Host }, createElement(CollisionList))))
    const rows = () => [...el.querySelectorAll<HTMLButtonElement>('[data-testid="collision-select"]')]
    expect(rows()).toHaveLength(3)
    expect(rows().map((r) => r.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'false'])
    // The strike against the prime tower names no part to pick.
    expect(rows().map((r) => r.disabled)).toEqual([false, false, true])
    expect(rows()[0]!.textContent).toContain('Housing')
    flushSync(() => rows()[0]!.click())
    expect(get().selectedIds).toEqual(['b', 'a'])
    expect(rows().map((r) => r.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false'])
    expect(el.querySelector('.strikes li')?.className).toBe('sel')
    flushSync(() => set({ selection: 'a', selectedIds: ['a', 'b'] }))
    expect(rows()[0]!.getAttribute('aria-pressed')).toBe('true')
    flushSync(() => set({ selection: 'a', selectedIds: ['a'] }))
    expect(rows()[0]!.getAttribute('aria-pressed')).toBe('false')
    // The jump stays its own button beside the row.
    expect(el.querySelectorAll('.strikes li')[0]!.querySelectorAll('button')).toHaveLength(2)
    flushSync(() => root.unmount())
    el.remove()
  })
})

describe('warnings and refusals', () => {
  const w = (over: Partial<SliceWarning>): SliceWarning => ({ code: 'outside_bed', message: 'Clip is outside the bed.', ...over })

  it('selects and rings the object a warning names, framing it when the warning names no spot', () => {
    jumpToWarning(w({ objectId: 'c' }))
    expect(get()).toMatchObject({ selectedIds: ['c'], pickRing: ['c'] })
    expect(camera.showSelection).toHaveBeenCalledTimes(1)
    expect(camera.focusBedPoint).not.toHaveBeenCalled()
    jumpToWarning(w({ objectId: 'a', message: 'near X 10 Y 20 mm' }))
    expect(get().selectedIds).toEqual(['a'])
    expect(camera.showSelection).toHaveBeenCalledTimes(1)
    expect(camera.focusBedPoint).toHaveBeenCalledTimes(1)
  })

  it('selects and rings the object a refused slice names, the camera on its spot', () => {
    showRefusal({ layer: 0, x: 155, y: 160, object: 'Clip' })
    expect(get()).toMatchObject({ selectedIds: ['c'], pickRing: ['c'] })
    expect(camera.showSelection).not.toHaveBeenCalled()
    expect(camera.focusBedPoint).toHaveBeenCalledTimes(1)
  })
})

/** A one-layer SXPV preview. */
function rawPreview(): ArrayBuffer {
  const b = new ArrayBuffer(48)
  const d = new DataView(b)
  d.setUint32(0, 0x56505853, true)
  d.setUint16(4, 1, true)
  d.setUint32(12, 1, true)
  d.setUint32(20, 1, true)
  d.setFloat32(24, 0.2, true)
  d.setFloat32(40, 0.2, true)
  return b
}

describe('Show me and the summary pane', () => {
  const shut = { left: false, right: false }

  it('Show me opens the summary pane at the collision list, then selects and frames the parts of the strike', async () => {
    set({ rails: { ...get().rails, preview: shut }, rightShut: 1, jobSeq: 1, preview: null })
    await showSpot({ kind: 'collision', index: 0 })
    const s = get()
    expect(Object.values(s.rails['preview'] ?? {})).toContain(true)
    expect(s.rightShut).toBeNull()
    expect(s).toMatchObject({ selectedIds: ['b', 'a'], pickRing: ['b', 'a'], strikePick: 0, sliceLook: 'toolpaths' })
    // framed when off screen, not turned to the strike's point
    expect(camera.showSelection).toHaveBeenCalledTimes(1)
    expect(camera.focusBedPoint).not.toHaveBeenCalled()
  })

  const sliceWith = async (slice: () => Promise<SliceResult>) => {
    set({ rails: { ...get().rails, preview: shut }, rightShut: null, slice: { status: 'idle' }, autoSlice: false, overrides: { smart_layer: 'off' } as never, plates: [{ id: 'plate-1', name: 'Plate 1', objects: [], settings: {} }] as never, activePlate: 'plate-1', calibration: {}, layerMarks: {}, resume: null })
    try {
      await slicePlate({ kind: 'web', capabilities: { threads: 1 }, slicer: { slice, getPreview: async () => rawPreview() } } as unknown as Host)
    } finally {
      cancelSlice({ quiet: true })
    }
    return get()
  }

  it('a slice never opens the pane by itself, one a strike holds back or one refused alike; Show me does', async () => {
    const struck = await sliceWith(async () => result([strike]))
    expect(struck.slice.status).toBe('done')
    expect(struck.rails['preview']).toEqual(shut)
    const refused = await sliceWith(async () => {
      throw new Error('toolpaths leave the bed from layer 1 (X-4.2 Y120.0, brim of "Clip")')
    })
    expect(refused.slice.status).toBe('error')
    expect(refused.rails['preview']).toEqual(shut)
    const clean = await sliceWith(async () => result([{ ...strike, severity: 'close' }]))
    expect(clean.rails['preview']).toEqual(shut)
  })
})

describe('the read-back', () => {
  it('names each collision\'s plate objects by id and name, a zone apart, layers from 1', () => {
    expect(collisionsReadback(get())).toEqual({
      stale: false,
      items: [
        { kind: 'hotend', severity: 'hit', part: 'toolhead', objects: [{ id: 'b', name: 'Housing' }, { id: 'a', name: 'Bracket' }], firstLayer: 3, lastLayer: 4 },
        { kind: 'keep_out', severity: 'hit', part: 'nozzle', objects: [{ id: 'c', name: 'Clip' }], zone: 'exclusion-area', firstLayer: 1, lastLayer: 5 },
        { kind: 'path_conflict', severity: 'hit', part: 'nozzle', objects: [], zone: 'gone', firstLayer: 3, lastLayer: 4 },
      ],
    })
    set({ slice: { status: 'idle' } as never })
    expect(collisionsReadback(get())).toBeNull()
  })
})
