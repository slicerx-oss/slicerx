// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The collision highlight: a picked strike outlines the part it hits and fills the region struck, the row says which
// part is hit, the viewport chip steps through the strikes, and the camera turns to the strike on the plate the person
// sees, whatever corner the printer counts from.
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Collision, Host, SliceResult } from '@slicerx/contracts'
import { HostContext } from '../src/host'
import { collisionHighlight, damagedOf } from '../src/plate/heimdall'
import { jumpTo, pickCollision } from '../src/plate/heimdall-jump'
import { wordsOf } from '../src/plate/heimdall-words'
import { setCameraBus } from '../src/plate/tools'
import { get, set } from '../src/state/store'
import { CollisionChip } from '../src/workspaces/preview/collision-chip'
import { CollisionList } from '../src/workspaces/preview/collision-list'

/** A 20 mm box as a plate entry, its footprint's corner at `x`, `y`. */
function entry(id: string, name: string, x = 0, y = 0) {
  const p = [0, 0, 0, 20, 0, 0, 20, 20, 0, 0, 20, 0, 0, 0, 20, 20, 0, 20, 20, 20, 20, 0, 20, 20]
  const i = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 2, 3, 7, 2, 7, 6, 1, 2, 6, 1, 6, 5, 3, 0, 4, 3, 4, 7]
  const handle = { id, hash: id, name, triangles: 12, bboxMm: [20, 20, 20], openEdges: 0, parts: [{ name: 'box', slot: 1, triangles: 12 }] }
  return { id, name, handle, parts: [{ name: 'box', slot: 1, positions: new Float32Array(p), indices: new Uint32Array(i) }], colors: [], transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, 0, 1] } as never
}

// Housing's toolhead hits Bracket, which printed first: Bracket is the part hit, the region on its side.
const strike: Collision = { kind: 'hotend', severity: 'hit', part: 'toolhead', objectId: 'b', hitId: 'a', damagedId: 'a', layer: 2, segment: 5, timeS: 25, lastLayer: 3, at: [50, 50, 0.6], point: [20, 40, 4], worstLayer: 2, worstPoint: [21, 41, 4], depthMm: 2, hitHeightMm: 20, contactMin: [26, 10, 12], contactMax: [30, 30, 20] }
const crossing: Collision = { ...strike, kind: 'path_conflict', part: 'nozzle', objectId: 'c', hitId: 'b', damagedId: 'c', contactMin: [40, 10, 0.2], contactMax: [44, 18, 2] }
const { contactMin: _min, contactMax: _max, ...bare } = strike
const close: Collision = { ...bare, severity: 'close', damagedId: 'a' }
const result = (collisions: Collision[]) => ({ id: 'r', engine: 'sx', layerCount: 4, layerZ: new Float32Array([0.2, 0.4, 0.6, 0.8]), layerTimeS: new Float32Array([10, 10, 10, 10]), stats: { timeS: 40, filamentMm: [1], filamentG: [1], cost: 0, toolChanges: 0 }, stageMicros: {}, wallMs: 1, warnings: [], collisions, collisionFixes: [] }) as SliceResult

const camera = { showSelection: vi.fn(() => true), focusBedPoint: vi.fn() }

beforeEach(() => {
  camera.showSelection.mockClear()
  camera.focusBedPoint.mockClear()
  setCameraBus(camera)
  set({ workspace: 'prepare', modelMode: 'slice', overrides: {}, plate: [entry('a', 'Bracket', 10, 10), entry('b', 'Housing', 40, 10), entry('c', 'Clip', 150, 150)], selection: null, selectedIds: [], pickRing: null, strikePick: null, slice: { status: 'done', result: result([strike, crossing, close]), stale: false }, preview: null })
})
afterEach(() => setCameraBus(null))

function mount(component: () => unknown) {
  const el = document.createElement('div')
  document.body.append(el)
  const root = createRoot(el)
  flushSync(() => root.render(createElement(HostContext.Provider, { value: {} as Host }, createElement(component as never))))
  return { el, done: () => (flushSync(() => root.unmount()), el.remove()) }
}

describe('the struck part', () => {
  it('is the part the engine names, or for an older engine the one met, the later of two crossing, the one in a zone', () => {
    const s = get()
    expect(damagedOf(s, strike)).toBe('a')
    expect(damagedOf(s, crossing)).toBe('c')
    const old = (c: Collision): Collision => {
      const { damagedId, ...rest } = c
      expect(damagedId).toBeDefined()
      return rest
    }
    expect(damagedOf(s, old(strike))).toBe('a')
    expect(damagedOf(s, old(crossing))).toBe('c')
    expect(damagedOf(s, { ...old(strike), kind: 'keep_out', objectId: 'c', hitId: 'exclusion-area' })).toBe('c')
    // Nothing on the plate to name.
    expect(damagedOf(s, { ...strike, damagedId: 'gone', hitId: 'gone' })).toBeNull()
  })
})

describe('the highlight', () => {
  it('outlines the part hit and fills the region struck while the strike is picked, and follows the selection', () => {
    expect(collisionHighlight(get())).toBeNull()
    pickCollision(0)
    // The struck part's paths in the layers struck stay; every other path fades back.
    expect(collisionHighlight(get())).toEqual({ outline: ['a'], box: { min: [26, 10, 12], max: [30, 30, 20] }, focus: { object: 0, z: [12, 20] } })
    pickCollision(1)
    expect(collisionHighlight(get())).toEqual({ outline: ['c'], box: { min: [40, 10, 0.2], max: [44, 18, 2] }, focus: { object: 2, z: [0.2, 2] } })
    // Another selection, as an empty-bed click or Esc clears it, takes the highlight with it.
    set({ selection: 'a', selectedIds: ['a'] })
    expect(collisionHighlight(get())).toBeNull()
  })

  it('never makes a close call look like a hit', () => {
    pickCollision(2)
    expect(collisionHighlight(get())).toBeNull()
  })

  it('keeps the outline on a moved part but drops the region of a slice from before it moved', () => {
    pickCollision(0)
    set({ slice: { ...(get().slice as { status: 'done'; result: SliceResult }), stale: true } })
    // Nothing fades either: the paths on screen are from before the move.
    expect(collisionHighlight(get())).toEqual({ outline: ['a'], box: null, focus: null })
  })

  it('keeps the struck object by its place in the slice, which leaves out the parts not printed', () => {
    set({ plate: [{ ...(get().plate[0] as object), id: 'x', printable: false } as never, ...get().plate] })
    pickCollision(1)
    expect(collisionHighlight(get())?.focus).toEqual({ object: 2, z: [0.2, 2] })
  })

  it('keeps every layer of the struck part when the engine gave no region', () => {
    const { contactMin: _a, contactMax: _b, ...noBox } = strike
    set({ slice: { status: 'done', result: result([noBox]), stale: false } })
    pickCollision(0)
    expect(collisionHighlight(get())).toEqual({ outline: ['a'], box: null, focus: { object: 0, z: null } })
  })

  it('shows only in Slice', () => {
    pickCollision(0)
    set({ modelMode: 'design' })
    expect(collisionHighlight(get())).toBeNull()
  })
})

describe('the camera on a printer that counts from another corner', () => {
  it('turns to the strike on the plate the person sees', () => {
    // The printable area is centered on the machine's 0, 0: the plate's 0, 0 is the machine's -128, -128.
    set({ overrides: { printable_area: ['-128x-128', '128x-128', '128x128', '-128x128'] } as never })
    jumpTo(0)
    expect(camera.focusBedPoint).toHaveBeenCalledWith(21 + 128, 41 + 128, 4, { animate: true })
    set({ overrides: {} })
    jumpTo(0)
    expect(camera.focusBedPoint).toHaveBeenLastCalledWith(21, 41, 4, { animate: true })
  })
})

describe('the words', () => {
  it('number copies of one name by their place on the plate', () => {
    const { name } = wordsOf({ plate: [{ id: 'x', name: 'Cube' }, { id: 'y', name: 'Tower' }, { id: 'z', name: 'Cube' }], profile: null })
    expect([name('x'), name('y'), name('z')]).toEqual(['Cube 1', 'Tower', 'Cube 2'])
  })

  it('say on each row which part is hit', () => {
    const { el, done } = mount(CollisionList)
    const rows = [...el.querySelectorAll('[data-testid="collision-select"]')]
    expect(rows[0]!.querySelector('.strike-struck')?.textContent).toBe('Part hit: Bracket')
    expect(rows[1]!.querySelector('.strike-struck')?.textContent).toBe('Part hit: Clip')
    // A close call hits nothing.
    expect(rows[2]!.querySelector('.strike-struck')).toBeNull()
    done()
  })
})

describe('the viewport chip', () => {
  it('counts the strikes and steps through them, picking each as its row does', () => {
    const { el, done } = mount(CollisionChip)
    const chip = () => el.querySelector<HTMLButtonElement>('[data-testid="collision-chip"]')
    expect(chip()?.querySelector('[data-on]')?.textContent).toBe('2 collisions')
    flushSync(() => chip()!.click())
    expect(get()).toMatchObject({ strikePick: 0, selectedIds: ['b', 'a'] })
    expect(chip()?.querySelector('[data-on]')?.textContent).toBe('Collision 1 of 2')
    flushSync(() => chip()!.click())
    expect(get().strikePick).toBe(1)
    expect(chip()?.querySelector('[data-on]')?.textContent).toBe('Collision 2 of 2')
    // Close calls are not counted, so the next one is the first again.
    flushSync(() => chip()!.click())
    expect(get().strikePick).toBe(0)
    done()
  })

  it('stays away with only close calls, and before a slice', () => {
    set({ slice: { status: 'done', result: result([close]), stale: false } })
    const { el, done } = mount(CollisionChip)
    expect(el.querySelector('[data-testid="collision-chip"]')).toBeNull()
    flushSync(() => set({ slice: { status: 'idle' } as never }))
    expect(el.querySelector('[data-testid="collision-chip"]')).toBeNull()
    done()
  })

  it('reads one strike as one', () => {
    set({ slice: { status: 'done', result: result([strike]), stale: false } })
    const { el, done } = mount(CollisionChip)
    expect(el.querySelector('[data-testid="collision-chip"] [data-on]')?.textContent).toBe('1 collision')
    done()
  })
})
