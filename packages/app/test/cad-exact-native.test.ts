// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { afterEach, expect, it, vi } from 'vitest'
import { clearReplayCache } from '@slicerx/cad-history'
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { geomEngine } from '../../mcp/src/geom'
import { applyExtrude, BED_FRAME } from '../src/cad/cad-ops'
import { setGeomProvider } from '../src/geom/client'
import { get, set } from '../src/state/store'
import { createHistory } from '../src/plate/history'
import { applyHistory } from '../src/cad/history/ops'
import { cutSelected } from '../src/plate/geom-ops'
import { applyHole, applyShell } from '../src/cad/holes'
import { bounds } from '../src/plate/transform'

const bin = process.env['SLICERX_SX_GEOM_BIN']
let undo: ReturnType<typeof createHistory> | undefined
afterEach(() => {
  undo?.dispose()
  undo = undefined
  vi.unstubAllEnvs()
  setGeomProvider(null)
  clearReplayCache()
  localStorage.removeItem('sx.exactSolids')
  set({ plate: [], selection: null, selectedIds: [], settingsMode: 'simple' })
})

it.skipIf(!bin)('creates and cuts a native exact body through the ordinary extrusion command', async () => {
  set({ plate: [], selection: null, selectedIds: [], settingsMode: 'developer' })
  localStorage.setItem('sx.exactSolids', '1')
  vi.stubEnv('SX_BREP_DEV', '1')
  undo = createHistory()
  const calls: string[] = []
  const native = geomEngine(bin!, 20000)
  setGeomProvider({ async call<T>(op: string, request: unknown): Promise<T> { calls.push(op); return await native(op, request) as T } })
  const loader = { loadParts: async (name: string, parts: MeshPart[]): Promise<MeshHandle> => ({ id: name, hash: name, name, triangles: parts.reduce((n, p) => n + p.indices.length / 3, 0), bboxMm: [30, 10, 3], openEdges: 0, parts: [] }) }
  await applyExtrude(loader, { name: 'Exact plate', frame: BED_FRAME, shape: { type: 'rectangle', widthMm: 30, heightMm: 10 }, placement: { center: [15, 5] }, spec: { distanceMm: 3, operation: 'new' } })
  const body = get().plate[0]!
  expect(body.history?.exact).toBe(true)
  await applyExtrude(loader, { name: 'Hole', target: { objectId: body.id, partIndex: 0 }, frame: { ...BED_FRAME, origin: [0, 0, 3] }, shape: { type: 'circle', diameterMm: 3 }, placement: { center: [5, 5] }, spec: { distanceMm: 3, operation: 'cut' } })
  expect(get().plate[0]!.history?.steps).toHaveLength(2)
  await applyHole(loader, body.id, 0, { op: 'hole.apply', hole: { entry: [5, 5, 3], axis: [0, 0, 1], diameterMm: 3, depthMm: 3, through: true }, spec: { diameterMm: 4 }, label: 'Hole 4 mm' })
  expect(calls).toContain('brep.hole')
  expect(calls).not.toContain('hole.apply')
  expect(calls).toContain('brep.extrude')
  expect(calls).not.toContain('shape.extrude')
  const before = get().plate[0]!
  const saved = before.history!
  const changed = { ...saved, steps: saved.steps.map((s, i) => i === 2 && s.params.op === 'hole.apply' ? { ...s, params: { ...s.params, spec: { diameterMm: 6 }, label: 'Hole 6 mm' } } : s) }
  await applyHistory(loader, body.id, changed)
  const after = get().plate[0]!
  expect(after.parts[0]!.positions).not.toEqual(before.parts[0]!.positions)
  expect(undo.undo()).toBe(true)
  expect(get().plate[0]!.history).toEqual(saved)
  expect(get().plate[0]!.parts).toBe(before.parts)
  expect(undo.redo()).toBe(true)
  expect(get().plate[0]!.parts).toBe(after.parts)
  expect(get().plate[0]!.history?.exact).toBe(true)
  await cutSelected(loader, { axis: 'z', atMm: 2, keep: 'below' })
  const cut = get().plate[0]!
  expect(bounds(cut.parts, cut.transform)?.max[2]).toBeCloseTo(2, 5)
  expect(cut.history?.steps).toHaveLength(4)
  expect(calls).toContain('brep.cut')
  await expect(cutSelected(loader, { axis: 'z', atMm: 1, keep: 'both' })).rejects.toThrow(/exact cut supports/)
  await expect(applyShell(loader, body.id, 0, { op: 'shell', open: [], wallMm: 1 })).rejects.toThrow(/Exact replay/)
  expect(get().plate[0]).toBe(cut)
  expect(calls).not.toContain('cut')
  expect(calls).not.toContain('shell')
}, 40000)
