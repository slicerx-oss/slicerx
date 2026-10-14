// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Show me on the Slice footer's blocks: a strike in the sliced plate goes to its moment and spot, and a slice the
// safety check refused turns the view to the spot its message names. A block with no spot gets no Show me.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Collision, SliceResult } from '@slicerx/contracts'
import { HostContext } from '../src/host'
import { firstHit, refusalMark, refusalSpot, showRefusal } from '../src/plate/preflight-show'
import { setCameraBus } from '../src/plate/tools'
import { get, set } from '../src/state/store'
import { SliceBlock } from '../src/workspaces/prepare/prepare-panes'

const host = { kind: 'web', capabilities: { threads: 4 } } as never
const before = get()
const roots: Root[] = []

afterEach(() => {
  for (const r of roots.splice(0)) flushSync(() => r.unmount())
  setCameraBus(null)
  set({ slice: before.slice, plate: before.plate, overrides: before.overrides, selection: before.selection, selectedIds: before.selectedIds, preview: before.preview, strikePick: null, refusalSpot: null })
})

function footer(): HTMLElement {
  const el = document.createElement('div')
  document.body.append(el)
  const root = createRoot(el)
  roots.push(root)
  flushSync(() => root.render(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(HostContext.Provider, { value: host }, createElement(SliceBlock, { compact: true })))))
  return el
}

const box = (id: string, name: string) => ({ id, name, parts: [], colors: [], transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] })

// The engine's refusals, as the slice error carries them.
const OFF_BED = 'blocked by the safety preflight: toolpaths lie outside the printable area from layer 3 (X-4.2 Y120.0, brim of "Layered X"), 40 points in layers 1 to 27; move "Layered X" onto the bed or arrange the plate'
const ZONE = 'blocked by the safety preflight: toolpaths enter an excluded bed area from layer 1 (X12.5 Y8.0, outer wall of "Cube"), 3 moves in layer 1; move "Cube" out of it or arrange the plate'
const REACH = 'blocked by the safety preflight: toolpaths of filament 2 lie outside the reach of extruder 1 from layer 12 (X300.0 Y20.5, sparse infill of "Cube"), 9 points in layer 12; map the filament to the other extruder or move "Cube"'
const TALL = 'blocked by the safety preflight: layers reach above the printable height (with z-hop) from layer 1201 (Z256.20 mm, "Cube"), 3 layers in layers 1 to 1203'

const hit: Collision = { kind: 'gantry', severity: 'hit', part: 'gantry', objectId: 'low', hitId: 'tall', layer: 2, segment: 5, timeS: 25, lastLayer: 3, at: [50, 50, 0.6], point: [20, 40, 40.6], worstLayer: 2, worstPoint: [21, 41, 40.6], depthMm: 7.4, hitHeightMm: 48, limitMm: 40 }
const close: Collision = { ...hit, kind: 'hotend', severity: 'close', worstPoint: [30, 30, 3] }
const result = (collisions: Collision[]) => ({ id: 'r', engine: 'sx', layerCount: 4, layerZ: new Float32Array([0.2, 0.4, 0.6, 0.8]), layerTimeS: new Float32Array(4).fill(10), stats: { timeS: 40, filamentMm: [1], filamentG: [1], cost: 0, toolChanges: 0 }, stageMicros: {}, wallMs: 1, warnings: [], collisions }) as SliceResult

describe('Show me on a refused slice', () => {
  it("reads the first spot from the engine's refusal, and none from a print over the height", () => {
    expect(refusalSpot(OFF_BED)).toEqual({ layer: 2, x: -4.2, y: 120, object: 'Layered X' })
    expect(refusalSpot(ZONE)).toEqual({ layer: 0, x: 12.5, y: 8, object: 'Cube', excluded: true })
    expect(refusalSpot(REACH)).toEqual({ layer: 11, x: 300, y: 20.5, object: 'Cube' })
    expect(refusalSpot(TALL)).toBeNull()
    expect(refusalSpot('The slicer stopped: Box has no walls.')).toBeNull()
    // Two refusals in one message: the first one that names a spot.
    expect(refusalSpot(`${TALL}; ${ZONE.replace('blocked by the safety preflight: ', '')}`)).toMatchObject({ x: 12.5, y: 8 })
  })

  it("turns the camera to the spot on the plate, from the printer's origin, and picks the object", () => {
    const calls: unknown[][] = []
    setCameraBus({ focusBedPoint: (...a) => void calls.push(a) })
    // A bed whose printable area starts at -5, -5 on the machine.
    set({ plate: [box('a', 'Other'), box('c', 'Cube')] as never, overrides: { ...get().overrides, printable_area: ['-5x-5', '251x-5', '251x251', '-5x251'], layer_height: 0.2, initial_layer_print_height: 0.3 } })
    showRefusal(refusalSpot(ZONE)!)
    expect(calls).toEqual([[17.5, 13, 0, { animate: true }]])
    expect(get().selectedIds).toEqual(['c'])
    showRefusal(refusalSpot(REACH)!)
    expect(calls[1]).toEqual([305, 25.5, expect.closeTo(0.3 + 11 * 0.2, 5), { animate: true }])
  })

  it('marks the spot on the plate, and outlines the excluded area a refusal enters', () => {
    setCameraBus({ focusBedPoint: () => undefined })
    // Printable area from -5, -5; two excluded patches, the second holds the spot (machine 12.5, 8.0).
    const area = ['-5x-5', '251x-5', '251x251', '-5x251']
    const zones = ['100x100', '120x100', '120x120', '100x120', '10x0', '20x0', '20x10', '10x10']
    set({ plate: [box('c', 'Cube')] as never, slice: { status: 'error', message: ZONE }, overrides: { ...get().overrides, printable_area: area, bed_exclude_area: zones } })
    showRefusal(refusalSpot(ZONE)!)
    const r = get().refusalSpot!
    expect([r.x, r.y, r.z]).toEqual([17.5, 13, 0])
    // The patch the spot lies in, on the plate (minus the printable area's corner), not the other one.
    expect(r.area).toEqual([[15, 5], [25, 5], [25, 15], [15, 15]])
    expect(r.slice).toBe(get().slice)
    // A refusal that is not for an excluded area gets the spot only.
    expect(refusalMark(refusalSpot(OFF_BED)!, { printable_area: area, bed_exclude_area: zones })).toEqual({ x: -4.2 + 5, y: 125, area: null })
    // Nothing excluded on this printer: the spot only.
    expect(refusalMark(refusalSpot(ZONE)!, { printable_area: area }).area).toBeNull()
  })

  it('puts Show me on the refusal line only when the refusal names a spot', () => {
    const calls: unknown[][] = []
    setCameraBus({ focusBedPoint: (...a) => void calls.push(a) })
    set({ plate: [box('c', 'Cube')] as never, slice: { status: 'error', message: ZONE } })
    const el = footer()
    const show = el.querySelector<HTMLButtonElement>('[data-testid="slice-error-show"]')
    expect(show?.textContent).toBe('Show me')
    flushSync(() => show!.click())
    expect(calls).toHaveLength(1)
    flushSync(() => set({ slice: { status: 'error', message: TALL } }))
    expect(el.querySelector('[data-testid="slice-error-show"]')).toBeNull()
    expect(el.querySelector('[data-testid="slice-estimate-error"]')?.textContent).toBe(TALL)
  })
})

describe('Show me on a strike that holds Print back', () => {
  it('finds the first hit, past any close call before it', () => {
    expect(firstHit({ slice: { status: 'done', result: result([close, hit]), stale: false } })).toBe(1)
    expect(firstHit({ slice: { status: 'done', result: result([close]), stale: false } })).toBeNull()
    expect(firstHit({ slice: { status: 'idle' } })).toBeNull()
  })

  it("goes to the strike's layer and moment from the footer's block line", async () => {
    set({ plate: [box('tall', 'Tall'), box('low', 'Low')] as never, slice: { status: 'done', result: result([close, hit]), stale: false }, strikePick: null })
    const el = footer()
    const show = el.querySelector<HTMLButtonElement>('[data-testid="slice-block-show"]')
    expect(show?.closest('.app-err')?.textContent).toContain('heimdall found a collision')
    flushSync(() => show!.click())
    // the jump loads heimdall-jump on first use, which can take over a second on a cold module graph
    await vi.waitFor(() => expect(get().strikePick).toBe(1), { timeout: 5000 })
    expect(get().layerHi).toBe(hit.layer + 1)
    expect(get().sliceLook).toBe('toolpaths')
  })
})
