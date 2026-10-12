// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The design tools over the app link: an agent's design.new and geom.extrude land on the plate as history steps,
// undo takes them back, bad input and unknown designs are refused, and no reply carries a mesh. Runs against the
// geometry engine (live wasm when built, recorded replies otherwise).
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
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

  it('refuse bad input and a design that is not there', async () => {
    expect(await code(runCall('geom.extrude', { design: 'x', distance_mm: -1 }))).toBe('invalid_input')
    expect(await code(runCall('design.steps', { design: 'obj_nope' }))).toBe('not_found')
    expect(await code(runCall('design.save', { design: 'obj_nope', path: '/tmp/x.3mf' }))).toBe('not_found')
  })
})
