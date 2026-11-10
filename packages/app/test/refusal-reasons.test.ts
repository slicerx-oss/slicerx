// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A design step whose shape no longer meets the part says how far short of it the shape stops, on the real engine.
// A pin placed on a plate's old top after the plate was made thinner, and an arm started on a back plate's old face.
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import type { StepParams } from '@slicerx/cad-history'
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import { appDesignHost } from '../src/cad/design-host'
import { setGeomProvider } from '../src/geom/client'
import { set } from '../src/state/store'
import { liveEngine, wasmGeom } from './geom-engine'

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [1, 1, 1], openEdges: 0, parts: [] })
const loader = { loadParts: async (name: string, _parts: MeshPart[]) => handle(name) }

const UP = { normal: [0, 0, 1] as [number, number, number], u: [1, 0, 0] as [number, number, number], v: [0, 1, 0] as [number, number, number] }
// the back plate's frame as the engine builds in it: v is the normal across u, so up the wall is v < 0
const BACK = { normal: [0, 1, 0] as [number, number, number], u: [1, 0, 0] as [number, number, number], v: [0, 0, -1] as [number, number, number] }

beforeAll(async () => {
  if (liveEngine) setGeomProvider(await wasmGeom())
})
afterAll(() => setGeomProvider(null))
beforeEach(() => set({ plate: [], selection: null, selectedIds: [], historyEdit: null, bed: { widthMm: 256, depthMm: 256, heightMm: 256 } }))

it.skipIf(!liveEngine)('says how far short of the part a join stops, in one sentence before the design is unchanged', async () => {
  const host = appDesignHost(loader)
  const gears = await host.create('Gear pair', [])
  // the plate was 4 mm thick and the pin still starts at z = 4
  await host.add(gears, 0, { op: 'shape.extrude', frame: { origin: [0, 0, 0], ...UP }, shape: { type: 'rectangle', widthMm: 120, heightMm: 75 }, placement: { center: [60, 37.5] }, spec: { distanceMm: 2.8, operation: 'new' } } as StepParams)
  const pin = { op: 'shape.extrude', frame: { origin: [0, 0, 4], ...UP }, shape: { type: 'circle', diameterMm: 5 }, placement: { center: [30, 37.5] }, spec: { distanceMm: 10, operation: 'join' } } as StepParams
  await expect(host.add(gears, 0, pin)).rejects.toThrow(/^The step did not go through: The shape stops 1\.2 mm short of the part\. The design is unchanged\.$/)
  const hook = await host.create('Coat hook', [])
  // the back plate was 5 mm thick and the arm still starts at y = 5
  await host.add(hook, 0, { op: 'shape.extrude', frame: { origin: [0, 0, 0], ...BACK }, shape: { type: 'rectangle', widthMm: 25, heightMm: 70 }, placement: { center: [0, -35] }, spec: { distanceMm: 3.5, operation: 'new' } } as StepParams)
  const arm = { op: 'shape.extrude', frame: { origin: [0, 5, 40], ...BACK }, shape: { type: 'circle', diameterMm: 12 }, placement: {}, spec: { distanceMm: 45, operation: 'join' } } as StepParams
  await expect(host.add(hook, 0, arm)).rejects.toThrow(/^The step did not go through: The shape stops 1\.5 mm short of the part\. The design is unchanged\.$/)
})
