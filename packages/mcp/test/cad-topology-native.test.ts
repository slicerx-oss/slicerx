// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { afterEach, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { clearReplayCache } from '@slicerx/cad-history'
import type { TopologyManifest } from '@slicerx/cad-history/topology-manifest'
import { geomEngine } from '../src/geom'
import { connect, data, text } from './helpers'

const bin = process.env['SLICERX_SX_GEOM_BIN']
afterEach(() => { clearReplayCache(); vi.unstubAllEnvs() })

it.skipIf(!bin)('verifies an exact scoped hole edit and refuses old revisions after undo and reopen', async () => {
  vi.stubEnv('SX_BREP_DEV', '1')
  const calls: string[] = []
  const native = geomEngine(bin!, 20000)
  const h = await connect({ geomEngine: async (op, request) => { calls.push(op); return native(op, request) } })
  try {
    const catalog = await h.client.listTools()
    expect(catalog.tools.some(tool => tool.name === 'slicerx_geom_faces')).toBe(true)
    const ok = async <T,>(name: string, args: Record<string, unknown>): Promise<T> => {
      const r = await h.call(name, args)
      expect(r.isError, `${name}: ${text(r)}`).toBeFalsy()
      return data<{ output: T }>(r).output
    }
    type Summary = { design: string; exact: boolean; parts: { sizeMm: number[]; volumeMm3: number }[] }
    const design = (await ok<Summary>('slicerx_design_new', { name: 'Scoped exact bracket', exact: true })).design
    const rectangle = (widthMm: number, heightMm: number, center: number[], distance_mm: number) => ok<Summary>('slicerx_geom_extrude', { design, shape: { type: 'rectangle', widthMm, heightMm }, placement: { center }, distance_mm })
    await rectangle(30, 10, [15, 5], 3)
    await ok('slicerx_geom_extrude', { design, shape: { type: 'circle', diameterMm: 3 }, frame: { origin: [0, 0, 3], normal: [0, 0, 1] }, placement: { center: [5, 5] }, distance_mm: 3, operation: 'cut' })
    const before = await rectangle(6, 8, [50, 5], 4)
    const topology = async (id: string) => (await ok<{ topology: TopologyManifest }>('slicerx_geom_faces', { design: id, format: 'topology' })).topology
    const inspected = await topology(design)
    expect(inspected).toMatchObject({ representation: 'exact', capabilities: { meshFallback: false, revisionGuard: true, scopedEdits: true } })
    const candidates = inspected.faces.filter(face => face.part === 0 && face.surfaceType === 'cylinder' && face.ambiguity === 'none' && Math.abs((face.dimensions.diameterMm ?? 0) - 3) < 0.02)
    expect(candidates).toHaveLength(1)
    expect(candidates[0]!.faceKey).not.toBeNull()
    const reference = { bodyId: design, revision: inspected.revision, part: 0, faceKey: candidates[0]!.faceKey }
    const edited = await ok<Summary & { after: { diameterMm: number }; topology: TopologyManifest; operationResult: { status: string; verification: { status: string } } }>('slicerx_geom_hole', { design, face: { topology: reference }, diameter_mm: 4 })
    expect(edited.operationResult).toMatchObject({ status: 'applied', verification: { status: 'verified' } })
    expect(edited.after.diameterMm).toBeCloseTo(4, 2)
    expect(edited.exact).toBe(true)
    expect(edited.parts.map(p => p.sizeMm)).toEqual(before.parts.map(p => p.sizeMm))
    expect(edited.parts[1]).toEqual(before.parts[1])
    expect(edited.topology.revision).not.toBe(inspected.revision)
    expect(calls).toContain('brep.hole')
    expect(calls).not.toContain('shape.extrude')
    expect(calls).not.toContain('hole.apply')
    const stale = async (id: string) => {
      const count = calls.length
      const result = await h.call('slicerx_geom_hole', { design: id, face: { topology: reference }, diameter_mm: 5 })
      expect(result.isError, text(result)).toBe(true)
      expect(result.structuredContent).toMatchObject({ error: { code: 'stale_body', details: { operationResult: { status: 'refused' } } } })
      expect(calls).toHaveLength(count)
    }
    await stale(design)
    await ok('slicerx_design_undo', { design })
    const undone = await topology(design)
    expect(undone.revision).not.toBe(inspected.revision)
    expect(undone.revision).not.toBe(edited.topology.revision)
    await stale(design)
    const saved = await ok<{ path: string }>('slicerx_design_save', { design })
    clearReplayCache()
    const opened = await ok<{ designs: Summary[] }>('slicerx_design_open', { path: saved.path })
    expect(opened.designs).toHaveLength(1)
    expect(opened.designs[0]!.exact).toBe(true)
    const reopened = await topology(opened.designs[0]!.design)
    expect(reopened.bodyId).not.toBe(inspected.bodyId)
    expect(reopened.revision).not.toBe(inspected.revision)
    await stale(reopened.bodyId)
  } finally { await h.client.close(); rmSync(h.dir, { recursive: true, force: true }) }
}, 60000)
