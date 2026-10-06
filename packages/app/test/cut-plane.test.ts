// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { MeshHandle } from '@slicerx/contracts'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { HostContext } from '../src/host'
import { canonical, connectorRings, cutStore, NO_CONNECTORS, normalOf, offsetOf, offsetRange, planeAt, tiltsOf, toggleConnector } from '../src/plate/cut-plane'
import { setCameraBus } from '../src/plate/tools'
import { identity } from '../src/plate/transform'
import { set, type PlateEntry } from '../src/state/store'
import { CutPanel } from '../src/workspaces/prepare/cut-panel'

const close = (a: readonly number[], b: readonly number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i] ?? NaN, 6))

/** A 20 x 10 x 30 mm box standing on the bed at x 50, y 40. */
function entry(id: string): PlateEntry {
  const p: number[] = []
  for (const x of [40, 60]) for (const y of [35, 45]) for (const z of [0, 30]) p.push(x, y, z)
  const handle = { id, hash: id, name: id, triangles: 12, bboxMm: [20, 10, 30], openEdges: 0, parts: [] } as MeshHandle
  return { id, name: id, handle, parts: [{ name: 'p', slot: 1, positions: new Float32Array(p), indices: new Uint32Array() }], colors: ['#bd93f9'], transform: identity() }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('cut plane math', () => {
  it('turns tilts into a normal and back', () => {
    close(normalOf(0, 0), [0, 0, 1])
    close(normalOf(0, 90), [1, 0, 0])
    close(normalOf(-90, 0), [0, 1, 0])
    for (const t of [[0, 0], [20, -35], [-60, 120], [89, 10]] as const) close(tiltsOf(normalOf(t[0], t[1])), t)
  })

  it('measures the plane from the center and keeps it through its nearest point', () => {
    const c: [number, number, number] = [50, 40, 15]
    const p = planeAt('a', c, [0, 0, 2], 5)
    close(p.point, [50, 40, 20])
    close(p.normal, [0, 0, 1])
    expect(offsetOf(p, c)).toBeCloseTo(5)
    // A plane reported from somewhere else on it comes back to the point above the center.
    close(canonical({ objectId: 'a', point: [70, 10, 20], normal: [0, 0, 1] }, c).point, [50, 40, 20])
    close(offsetRange({ min: [40, 35, 0], max: [60, 45, 30] }, c, [0, 0, 1]), [-15, 15])
  })
})

describe('cut panel', () => {
  afterEach(() => cutStore.setState({ plane: null, keep: 'both' }))

  it('takes the connector tolerance from the fit clearance and says where it came from', async () => {
    set({ plate: [entry('a')], selection: 'a', objectTool: 'cut', userPresets: [] })
    cutStore.setState({ connectors: { ...cutStore.getState().connectors, kind: 'pin', toleranceSet: false } })
    const el = document.createElement('div')
    const root = createRoot(el)
    flushSync(() => root.render(createElement(HostContext.Provider, { value: { kind: 'web', capabilities: {} } as never }, createElement(CutPanel))))
    await tick()
    flushSync(() => undefined)
    const tol = el.querySelector<HTMLInputElement>('#cut-conn-tol')!
    const source = el.querySelector('[data-testid="cut-conn-tol-source"]')!
    // No hole test here: half the nozzle, and a way to print the test.
    expect(Number(tol.value)).toBeCloseTo(0.2)
    expect(source.textContent).toMatch(/half the 0\.4 mm nozzle/)
    expect(source.textContent).toMatch(/Print the test/)
    // A typed tolerance stays, and the clearance can be taken back.
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    flushSync(() => {
      setValue.call(tol, '0.3')
      tol.dispatchEvent(new Event('input', { bubbles: true }))
    })
    flushSync(() => tol.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    await tick()
    expect(cutStore.getState().connectors).toMatchObject({ toleranceMm: 0.3, toleranceSet: true })
    expect(source.textContent).toMatch(/^Typed\. The fit clearance is 0\.20 mm a side/)
    root.unmount()
    cutStore.setState({ connectors: { ...cutStore.getState().connectors, kind: 'none', toleranceSet: false } })
  })

  it('starts level through the middle, and its fields and the view share the plane both ways', async () => {
    set({ plate: [entry('a')], selection: 'a', objectTool: 'cut' })
    const el = document.createElement('div')
    const root = createRoot(el)
    const host = { kind: 'web', capabilities: {} } as never
    flushSync(() => root.render(createElement(HostContext.Provider, { value: host }, createElement(CutPanel))))
    await tick()
    flushSync(() => undefined)
    const plane = cutStore.getState().plane!
    close(plane.point, [50, 40, 15])
    close(plane.normal, [0, 0, 1])
    // A drag in the view reports its plane on release: the fields show it.
    flushSync(() => cutStore.setState({ plane: { objectId: 'a', point: [0, 0, 21], normal: [0, 0, 1] } }))
    await tick()
    expect(el.querySelector<HTMLInputElement>('#cut-offset')?.value).toBe('6')
    flushSync(() => cutStore.setState({ plane: { objectId: 'a', point: [50, 40, 15], normal: normalOf(0, 90) } }))
    await tick()
    expect(el.querySelector<HTMLInputElement>('#cut-tilt-y')?.value).toBe('90')
    expect(el.querySelector('[aria-checked="true"]')?.textContent).toBe('Across X')
    // A field edit moves the plane for the view, clamped to the object.
    const off = el.querySelector<HTMLInputElement>('#cut-offset')!
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    flushSync(() => {
      setValue.call(off, '40')
      off.dispatchEvent(new Event('input', { bubbles: true }))
    })
    flushSync(() => off.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    const moved = cutStore.getState().plane!
    close(moved.point, [60, 40, 15])
    root.unmount()
    expect(cutStore.getState().plane).toBeNull()
  })
})

describe('connectors placed in the view', () => {
  afterEach(() => cutStore.setState({ plane: null, keep: 'both', connectors: NO_CONNECTORS }))

  it('a click adds a pin on the plane and a click on it takes it away; they follow the plane', () => {
    cutStore.setState({ plane: { objectId: 'a', point: [50, 40, 15], normal: [0, 0, 1] }, connectors: { ...NO_CONNECTORS, kind: 'pin', placing: true } })
    toggleConnector([45, 40, 15.2])
    toggleConnector([55, 40, 15])
    expect(cutStore.getState().connectors.points).toEqual([[45, 40, 15], [55, 40, 15]])
    // Within the radius of one takes it away.
    toggleConnector([55.5, 41, 15])
    expect(cutStore.getState().connectors.points).toEqual([[45, 40, 15]])
    // The plane moves up 5 mm: the pin goes with it.
    cutStore.setState({ plane: { objectId: 'a', point: [50, 40, 20], normal: [0, 0, 1] } })
    close(cutStore.getState().connectors.points[0]!, [45, 40, 20])
    // Another object starts with none.
    cutStore.setState({ plane: { objectId: 'b', point: [0, 0, 5], normal: [0, 0, 1] } })
    expect(cutStore.getState().connectors.points).toEqual([])
    // A dovetail has no placement.
    cutStore.setState({ connectors: { ...NO_CONNECTORS, kind: 'dovetail', placing: true } })
    toggleConnector([1, 1, 5])
    expect(cutStore.getState().connectors.points).toEqual([])
  })

  it('draws each connector as a circle of its diameter on the plane', () => {
    const [ring] = connectorRings({ normal: [1, 0, 0] }, { points: [[10, 20, 30]], diameterMm: 6 })
    expect(ring).toHaveLength(24)
    for (const p of ring!) {
      expect(p[0]).toBeCloseTo(10)
      expect(Math.hypot(p[1] - 20, p[2] - 30)).toBeCloseTo(3)
    }
  })

  it('the panel offers size, depth, tolerance and placement, and shows placed pins in the view', async () => {
    const drawn: { loops?: readonly unknown[]; points?: readonly unknown[] }[] = []
    setCameraBus({ guides: (g: { loops?: readonly unknown[]; points?: readonly unknown[] }) => drawn.push(g) } as never)
    set({ plate: [entry('a')], selection: 'a', objectTool: 'cut' })
    const el = document.createElement('div')
    const root = createRoot(el)
    flushSync(() => root.render(createElement(HostContext.Provider, { value: { kind: 'web', capabilities: {} } as never }, createElement(CutPanel))))
    await tick()
    flushSync(() => cutStore.setState({ connectors: { ...NO_CONNECTORS, kind: 'dowel', placing: true } }))
    await tick()
    expect(el.querySelector('#cut-conn-d')).not.toBeNull()
    expect(el.querySelector('#cut-conn-depth')).not.toBeNull()
    expect(el.querySelector('#cut-conn-tol')).not.toBeNull()
    expect(el.textContent).toContain('Click the cut face to add a connector there')
    flushSync(() => toggleConnector([50, 40, 15]))
    await tick()
    expect(el.textContent).toContain('1 connector placed.')
    const last = drawn[drawn.length - 1]!
    expect(last.points).toHaveLength(1)
    expect(last.loops!.length).toBeGreaterThanOrEqual(1)
    root.unmount()
    setCameraBus(null)
  })
})
