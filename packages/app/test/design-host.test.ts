// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The app's design host: an empty design waits off the plate until its first step makes a body; each step lands in
// the object's history like a person's edit; a step that fails leaves the design as it was; undone steps come back.
// Runs against the geometry engine (live wasm when built, recorded replies otherwise).
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import type { HistoryMesh, StepParams } from '@slicerx/cad-history'
import { beforeEach, describe, expect, it } from 'vitest'
import { appDesignHost, DesignNotFound } from '../src/cad/design-host'
import { get, set } from '../src/state/store'
import { useGeomEngine } from './geom-engine'

useGeomEngine('design-host-replies')

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [1, 1, 1], openEdges: 0, parts: [] })
const loader = { loadParts: async (name: string, _parts: MeshPart[]) => handle(name) }

const BED = { normal: [0, 0, 1] as [number, number, number], u: [1, 0, 0] as [number, number, number], v: [0, 1, 0] as [number, number, number] }
/** The backplate: a 150.4 by 110.4 mm plate, 3 mm thick, on the bed at (128, 128). */
const plate: StepParams = { op: 'shape.extrude', frame: { origin: [128, 128, 0], ...BED }, shape: { type: 'rectangle', widthMm: 150.4, heightMm: 110.4 }, placement: {}, spec: { distanceMm: 3, operation: 'new' }, name: 'Backplate' }
/** A hole through it, `d` mm across, at (x, y) on the plate. */
const hole = (d: number, x = 0, y = 0): StepParams => ({ op: 'shape.extrude', frame: { origin: [128, 128, 3], ...BED }, shape: { type: 'circle', diameterMm: d }, placement: { center: [x, y] }, spec: { distanceMm: 3, operation: 'cut' } })

function volume(parts: readonly Pick<HistoryMesh, 'positions' | 'indices'>[]): number {
  let v = 0
  for (const m of parts) {
    const p = m.positions
    for (let k = 0; k + 2 < m.indices.length; k += 3) {
      const [a, b, c] = [3 * m.indices[k]!, 3 * m.indices[k + 1]!, 3 * m.indices[k + 2]!]
      v += (p[a]! * (p[b + 1]! * p[c + 2]! - p[b + 2]! * p[c + 1]!) - p[a + 1]! * (p[b]! * p[c + 2]! - p[b + 2]! * p[c]!) + p[a + 2]! * (p[b]! * p[c + 1]! - p[b + 1]! * p[c]!)) / 6
    }
  }
  return Math.abs(v)
}

beforeEach(() => set({ plate: [], selection: null, selectedIds: [], historyEdit: null }))

describe('the app design host', () => {
  it('keeps an empty design off the plate until its first step makes a body', async () => {
    const host = appDesignHost(loader)
    const d = await host.create('Backplate', [])
    expect(get().plate).toHaveLength(0)
    expect(host.list().map((x) => x.id)).toEqual([d.id])
    await host.add(d, 0, plate)
    const e = get().plate.find((p) => p.id === d.id)!
    expect(e.history?.steps).toHaveLength(1)
    expect(volume(e.parts)).toBeCloseTo(150.4 * 110.4 * 3, -1)
    expect(d.history.steps).toHaveLength(1)
  })

  it('lands each step in the object\'s history, as a person\'s edit does', async () => {
    const host = appDesignHost(loader)
    const d = await host.create('Backplate', [])
    await host.add(d, 0, plate)
    await host.add(d, 0, hole(30))
    await host.add(d, 0, hole(4.5, 0, 30))
    await host.add(d, 0, hole(4.5, 0, -30))
    const e = get().plate.find((p) => p.id === d.id)!
    expect(e.history?.steps.map((s) => s.params.op)).toEqual(['shape.extrude', 'shape.extrude', 'shape.extrude', 'shape.extrude'])
    const holes = Math.PI * (15 * 15 + 2 * 2.25 * 2.25) * 3
    expect(volume(e.parts)).toBeCloseTo(150.4 * 110.4 * 3 - holes, -2)
  })

  it('leaves the design as it was when a step fails, and says why', async () => {
    const host = appDesignHost(loader)
    const d = await host.create('Backplate', [])
    await host.add(d, 0, plate)
    const before = volume(get().plate[0]!.parts)
    // a hole far off the plate cuts nothing
    await expect(host.add(d, 0, hole(10, 400, 400))).rejects.toThrow(/did not go through|nothing/i)
    expect(get().plate[0]!.history?.steps).toHaveLength(1)
    expect(volume(get().plate[0]!.parts)).toBeCloseTo(before, 3)
  })

  it('undoes and redoes through the history, and undoing every step takes the body off the plate', async () => {
    const host = appDesignHost(loader)
    const d = await host.create('Backplate', [])
    await host.add(d, 0, plate)
    await host.add(d, 0, hole(30))
    const last = d.history.steps.at(-1)!
    d.history = { ...d.history, steps: d.history.steps.slice(0, -1) }
    d.redo = [...d.redo, last]
    await host.replay(d)
    expect(get().plate[0]!.history?.steps).toHaveLength(1)
    expect(host.get(d.id).redo.map((s) => s.id)).toEqual([last.id])
    d.history = { ...d.history, steps: [] }
    await host.replay(d)
    expect(get().plate).toHaveLength(0)
    expect(host.get(d.id).parts).toEqual([])
  })

  it('says a design id names nothing', () => {
    expect(() => appDesignHost(loader).get('obj_nope')).toThrow(DesignNotFound)
  })
})
