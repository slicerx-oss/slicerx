// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// CAD history through a whole project file: written with the project, read back and attached by
// object id. SX_HISTORY_SAMPLE=<path> also writes the sample project for driving the app.
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import type { History, StepParams } from '../src/cad/history/model'
import { runReplay } from '../src/cad/history/ops'
import { withStep } from '../src/cad/history/record'
import { readProject } from '../src/export/import3mf'
import { writeProject } from '../src/export/threemf'
import { boxMesh } from '../src/plate/mesh-ops'
import { compose } from '../src/plate/transform'
import type { PlateEntry } from '../src/state/store'
import { useGeomEngine } from './geom-engine'

useGeomEngine('cad-history-file-replies')

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [1, 1, 1], openEdges: 0, parts: [] })
const T = compose({ position: [128, 128, 0], rotation: [0, 0, 0], scale: [1, 1, 1] })
const top = (z: number) => ({ origin: [128, 128, z] as [number, number, number], normal: [0, 0, 1] as [number, number, number], u: [1, 0, 0] as [number, number, number], v: [0, 1, 0] as [number, number, number] })

function bracket(): History {
  let e: { parts: MeshPart[]; transform: number[]; history?: History } = { parts: [boxMesh(40, 20, 5)], transform: T }
  const steps: StepParams[] = [
    { op: 'face.push', at: [128, 128, 5], normal: [0, 0, 1], distanceMm: 5 },
    { op: 'shape.extrude', frame: top(10), shape: { type: 'circle', diameterMm: 6 }, placement: {}, spec: { distanceMm: 4, operation: 'join' } },
    { op: 'shape.extrude', frame: top(10), shape: { type: 'circle', diameterMm: 4 }, placement: { center: [12, 0] }, spec: { distanceMm: 3, operation: 'cut' } },
    { op: 'hollow', wallMm: 1.5 },
  ]
  for (const p of steps) e = { ...e, history: withStep(e, p.op === 'hollow' ? -1 : 0, p) }
  // The hollow starts suppressed, so it shows in the list without making the mesh dense.
  return { ...e.history!, steps: e.history!.steps.map((s, i) => (i === 3 ? { ...s, suppressed: true } : s)) }
}

describe('history in a project', () => {
  it('a whole project keeps the history; a project without it opens as before', async () => {
    const h = bracket()
    const r = await runReplay({ history: h })
    const e: PlateEntry = { id: 'obj_a', name: 'Bracket', handle: handle('a'), parts: r.parts as MeshPart[], colors: ['#bd93f9'], transform: T, history: h }
    const bed = { widthMm: 256, depthMm: 256 }
    const bytes = writeProject({ plates: [{ id: 'p1', name: 'Plate 1', objects: [e], settings: { sequence: 'by-layer' } }], bed, settings: {} })
    const p = await readProject(bytes, bed)
    const back = p.histories.get(p.plates[0]!.objects[0]!.fileId)!
    expect(back.steps.map((s) => s.id)).toEqual(h.steps.map((s) => s.id))
    expect(back.steps[3]!.suppressed).toBe(true)
    expect(back.base[0]!.indices.length).toBe(36)
    const { history: _h, ...plain } = e
    const without = await readProject(writeProject({ plates: [{ id: 'p1', name: 'Plate 1', objects: [plain], settings: { sequence: 'by-layer' } }], bed, settings: {} }), bed)
    expect(without.histories.size).toBe(0)
    const out = process.env['SX_HISTORY_SAMPLE']
    if (out) (await import('node:fs')).writeFileSync(out, bytes)
  })
})
