// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The design tools over the app link: an agent's design.new and geom.extrude land on the plate as history steps,
// undo takes them back, bad input and unknown designs are refused, and no reply carries a mesh. Runs against the
// geometry engine (live wasm when built, recorded replies otherwise).
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { replaying } from '../src/cad/history/ops'
import { LinkError, runCall, useDesignHost } from '../src/app-link/methods'
import { get, set } from '../src/state/store'
import { useGeomEngine } from './geom-engine'

useGeomEngine('app-link-design-replies')

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [1, 1, 1], openEdges: 0, parts: [] })
const loader = { loadParts: async (name: string, _parts: MeshPart[]) => handle(name) }

beforeAll(() => useDesignHost(loader))
beforeEach(() => set({ plate: [], selection: null, selectedIds: [], historyEdit: null }))

const code = async (p: Promise<unknown>) => ((await p.catch((e: unknown) => e)) as LinkError).code

describe('design tools over the app link', () => {
  it('start a design and extrude on the plate, as history steps undo takes back', async () => {
    const started = (await runCall('design.new', { name: 'Clip' })) as { output: { design: string } }
    const design = started.output.design
    expect(get().plate).toHaveLength(0)
    const out = await runCall('geom.extrude', { design, shape: { type: 'rectangle', widthMm: 20, heightMm: 10 }, distance_mm: 3, name: 'Clip' })
    expect(JSON.stringify(out)).not.toMatch(/positions|indices/)
    expect(out).toMatchObject({ output: { design, steps: 1, sizeMm: [20, 10, 3] } })
    expect(get().plate.find((e) => e.id === design)?.history?.steps).toHaveLength(1)
    await runCall('design.undo', { design })
    expect(get().plate).toHaveLength(0)
  })

  it('make a hole another size on the plate, as the hole step the hole tool records', async () => {
    const design = ((await runCall('design.new', { name: 'Plate' })) as { output: { design: string } }).output.design
    await runCall('geom.extrude', { design, shape: { type: 'rectangle', widthMm: 20, heightMm: 10 }, distance_mm: 3 })
    await runCall('geom.extrude', { design, operation: 'cut', frame: { origin: [0, 0, 3], normal: [0, 0, 1] }, shape: { type: 'circle', diameterMm: 4 }, distance_mm: 3 })
    const out = await runCall('geom.hole', { design, center: [0, 0, 3], axis: [0, 0, 1], diameter_mm: 3, label: 'M2.5 clearance' })
    expect(JSON.stringify(out)).not.toMatch(/positions|indices/)
    expect(out).toMatchObject({
      output: { steps: 3, before: { center: [0, 0, 3], diameterMm: 4, depthMm: 3, kind: 'through' }, after: { diameterMm: 3, depthMm: 3, kind: 'through', head: 'none' } },
    })
    const step = get().plate.find((e) => e.id === design)?.history?.steps.at(-1)
    expect(step?.params).toMatchObject({ op: 'hole.apply', hole: { diameterMm: expect.closeTo(4, 5), through: true }, spec: { diameterMm: 3 }, label: 'M2.5 clearance' })
    expect(await code(runCall('geom.hole', { design, center: [8, 3, 3], axis: [0, 0, 1], diameter_mm: 3 }))).toBe('invalid_input')
  })

  it('wait for the person: busy while they edit a step of that object', async () => {
    const started = (await runCall('design.new', { name: 'Box' })) as { output: { design: string } }
    const design = started.output.design
    set({ historyEdit: { objectId: design } as never })
    expect(await code(runCall('geom.extrude', { design, shape: { type: 'rectangle', widthMm: 20, heightMm: 10 }, distance_mm: 3 }))).toBe('busy')
    // Reading is fine meanwhile.
    expect(await runCall('design.steps', { design })).toBeTruthy()
    set({ historyEdit: null })
  })

  it('wait for the person: busy while that object replays', async () => {
    const started = (await runCall('design.new', { name: 'Slow' })) as { output: { design: string } }
    const design = started.output.design
    await runCall('geom.extrude', { design, shape: { type: 'rectangle', widthMm: 20, heightMm: 10 }, distance_mm: 3 })
    // A loader that waits keeps the next step's replay running.
    let finish = () => undefined as void
    await useDesignHost({ loadParts: (name: string) => new Promise<MeshHandle>((r) => (finish = () => r(handle(name)))) })
    try {
      const hole = { design, operation: 'cut', frame: { origin: [0, 0, 3], normal: [0, 0, 1] }, shape: { type: 'circle', diameterMm: 4 }, distance_mm: 3 }
      const second = runCall('geom.extrude', hole)
      await vi.waitFor(() => expect(replaying(design)).toBe(true))
      expect(await code(runCall('geom.extrude', hole))).toBe('busy')
      finish()
      await second
      expect(replaying(design)).toBe(false)
    } finally {
      await useDesignHost(loader)
    }
  })

  it('refuse bad input and a design that is not there', async () => {
    expect(await code(runCall('geom.extrude', { design: 'x', distance_mm: -1 }))).toBe('invalid_input')
    expect(await code(runCall('design.steps', { design: 'obj_nope' }))).toBe('not_found')
    expect(await code(runCall('design.save', { design: 'obj_nope', path: '/tmp/x.3mf' }))).toBe('not_found')
  })
})
