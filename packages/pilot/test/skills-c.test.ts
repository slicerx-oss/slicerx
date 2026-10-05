// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { MeshPart, PilotMachine } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { evalGeom } from '../evals/geom'
import { createEvalEnv, createEvalSlicer, evalKb } from '../evals/harness'
import { runScenario } from '../evals/runner'
import { FUNCTION_SCENARIOS, GEOM_SCENARIOS, SCENARIOS } from '../evals/skills/c'
import { EXPECTED_REFUSALS, runFunctionScenario } from '../evals/functions'
import { createMemoryProject } from '../src/memory-project'
import { createScriptedClient } from '../src/provider/scripted'
import type { PilotTool, ToolContext, ToolHost } from '../src/tool'
import { create as batchC } from '../skills/batch-c'
import { calibrationNotes } from '../skills/calibrate/index'
import { connectorSpec } from '../skills/cut/index'
import { checkText } from '../skills/emboss/index'
import { boxFacePoint, holeSolid, meshVolume, partFromGeom, reachAlong, toGeomMesh, unrotate } from '../skills/geom_common/index'
import { hollowSaving } from '../skills/hollow/index'
import { changed, fixesOf } from '../skills/mesh_repair/index'
import { createOrient, rotationName } from '../skills/orient/index'
import { dropToBed } from '../skills/resume_from_layer/index'
import { scaleCase, scaleParts } from '../skills/scale_with_tolerance/index'
import { planHoles, primMesh, primitives } from '../skills/text_to_part/solids'
import { holeFor, metric, type PrintBasis } from '../skills/threads_and_fits/sizes'
import { createShared } from '../src/shared'

const geom = evalGeom()
const NO_GEOM = 'sx-geom is not built (cargo build -p sx-geom), so geometry cases are skipped'
if (!geom) console.warn(NO_GEOM)

const MACHINE: PilotMachine = { printer: 'bambu_p1s', material: 'pla', nozzle: 0.4 }
const cube = (s: number): MeshPart => primMesh(primitives([{ type: 'box', sizeMm: [s, s, s] }]), 'cube')

function toolsWith(parts: MeshPart[] | null, withGeom: boolean) {
  const kb = evalKb()
  const project = createMemoryProject('t', MACHINE, [{ id: 'part', name: 'Test part', bboxMm: [20, 20, 20], ...(parts ? { mesh: async () => parts } : {}) }], kb)
  const env = createEvalEnv({ client: createScriptedClient([]), machine: MACHINE, objects: [] })
  const host: ToolHost = { printers: env.sim, slicer: createEvalSlicer(() => project) }
  if (withGeom && geom) host.geom = geom
  const ctx: ToolContext = { host, sessionId: 's', callId: 'c', signal: new AbortController().signal, context: { machine: MACHINE }, today: '2026-09-30', project, kb, progress: () => undefined }
  const tools = new Map([...batchC(createShared()), createOrient() as unknown as PilotTool<never>].map((t) => [t.name, t as unknown as PilotTool<Record<string, unknown>>]))
  const run = async (name: string, input: Record<string, unknown>) => {
    const t = tools.get(name)
    if (!t) throw new Error(`no tool ${name}`)
    return t.run(t.input.parse(input), ctx)
  }
  return { project, run }
}

// Hollowing and cutting run the sx-geom binary; on a loaded build machine one call can pass the 5 s default.
const GEOM_TIMEOUT_MS = 30_000

describe('mesh helpers', () => {
  it('merges parts and reads meshes back', () => {
    const m = toGeomMesh([cube(10), cube(5)])
    expect(m.positions.length).toBe(48)
    expect(Math.max(...m.indices)).toBe(15)
    const p = partFromGeom(m, 'x', 2)
    expect(p?.slot).toBe(2)
    expect(partFromGeom({ positions: [0, 0], indices: [0] }, 'x', 1)).toBeNull()
  })
  it('measures closed shells', () => {
    expect(meshVolume([cube(10)])).toBeCloseTo(1000, 3)
    const cyl = primMesh(primitives([{ type: 'cylinder', diameterMm: 20, heightMm: 10, axis: 'x' }]), 'c')
    expect(meshVolume([cyl])).toBeGreaterThan(Math.PI * 100 * 10 * 0.99)
    expect(meshVolume([cyl])).toBeLessThan(Math.PI * 100 * 10)
  })
  it('finds face points, reach and inverse rotations', () => {
    expect(boxFacePoint([0, 0, 0], [10, 20, 30], [0, 0, 1])).toEqual([5, 10, 30])
    expect(boxFacePoint([0, 0, 0], [10, 20, 30], [0, -1, 0])).toEqual([5, 0, 15])
    expect(reachAlong([0, 0, 0], [10, 10, 10], [5, 5, 10], [0, 0, -1])).toBe(10)
    expect(unrotate([90, 0, 0], [0, 0, 1])).toEqual([0, 1, 0])
  })
  it('starts plain hole cutters outside the surface', () => {
    const s = holeSolid([5, 5, 10], [0, 0, -2], 3, 6)
    expect(s).toEqual({ type: 'cylinder', origin: [5, 5, 11], axis: [0, 0, -1], diameterMm: 3, heightMm: 7 })
    expect(holeSolid([5, 5, 10], [0, 0, -1], 3.4, 6, { headMm: 7 })).toMatchObject({ type: 'countersink', origin: [5, 5, 10], shaftDiameterMm: 3.4, headDiameterMm: 7, angleDeg: 90 })
  })
})

describe('text_to_part solids', () => {
  it('builds an L bracket from two plates that touch', () => {
    const p = primitives([{ type: 'l_bracket', legAMm: 40, legBMm: 30, widthMm: 20, thicknessMm: 3 }])
    expect(p).toEqual([
      { kind: 'box', min: [0, 0, 0], max: [40, 20, 3] },
      { kind: 'box', min: [0, 0, 3], max: [3, 20, 30] },
    ])
    expect(meshVolume([primMesh(p, 'l')])).toBeCloseTo(40 * 20 * 3 + 3 * 20 * 27, 3)
  })
  it('plans through holes and skips ones that miss', () => {
    const prims = primitives([{ type: 'plate', sizeMm: [40, 20, 3] }])
    const [hit, miss] = planHoles(prims, [
      { diameterMm: 3.4, atMm: [10, 10, 0], axis: 'z' },
      { diameterMm: 3.4, atMm: [60, 10, 0], axis: 'z' },
    ])
    expect(hit?.lengthMm).toBe(3)
    expect(hit?.solid).toMatchObject({ type: 'cylinder', origin: [10, 10, 4], axis: [0, 0, -1], heightMm: 5 })
    expect(miss?.solid).toBeNull()
  })
})

describe('hole sizing', () => {
  const basis: PrintBasis = { material: 'pla', lineWidth: 0.42, layerHeight: 0.2, nozzle: 0.4, holeCompensation: 0 }
  it('uses published insert holes as modeled, with depth for the insert', () => {
    expect(holeFor('insert', basis, { size: 'M3' })).toMatchObject({ modeledMm: 4, depthMm: 6.7 })
  })
  it('opens machining sizes for printed-hole shrink, less compensation already set', () => {
    const plain = holeFor('clearance', basis, { size: 'm3' })
    const comp = holeFor('clearance', { ...basis, holeCompensation: 0.05 }, { size: 'M3' })
    expect('error' in plain ? 0 : plain.modeledMm).toBeCloseTo(3.5, 5)
    expect('error' in comp ? 0 : comp.modeledMm).toBeCloseTo(3.4, 5)
    const petg = holeFor('tap', { ...basis, material: 'petg' }, { size: 'M4' })
    expect('error' in petg ? 0 : petg.modeledMm).toBeCloseTo(3.46, 5)
  })
  it('adds a countersink and handles fits and bad sizes', () => {
    const cs = holeFor('countersunk', basis, { size: 'M4' })
    expect('error' in cs ? null : cs.countersink?.headMm).toBeCloseTo(9.46, 5)
    const press = holeFor('press_fit', basis, { diameterMm: 5 })
    const slip = holeFor('slip_fit', basis, { diameterMm: 5 })
    expect('error' in press || 'error' in slip ? 0 : slip.modeledMm - press.modeledMm).toBeGreaterThan(0.1)
    expect(holeFor('press_fit', basis, {})).toHaveProperty('error')
    expect(holeFor('tap', basis, { size: 'M12' })).toHaveProperty('error')
    expect(metric('M2.5x8')?.name).toBe('M2.5')
  })
})

describe('skill logic', () => {
  it('warns about text too small for the nozzle', () => {
    expect(checkText({ sizeMm: 8, depthMm: 0.6, lineWidth: 0.42, layerHeight: 0.2, mode: 'deboss', vertical: false }).warnings).toEqual([])
    const small = checkText({ sizeMm: 3, depthMm: 0.2, lineWidth: 0.42, layerHeight: 0.2, mode: 'emboss', vertical: true })
    expect(small.warnings.length).toBe(2)
    expect(small.minSizeMm).toBe(5.3)
  })
  it('counts grams saved solid and at infill', () => {
    expect(hollowSaving(10000, 4000, 1.24, 15)).toEqual({ removedMm3: 6000, solidGrams: 7.4, atInfillGrams: 1.1 })
  })
  it('reports repair fixes in plain words', () => {
    const c = { verticesMerged: 0, degenerateRemoved: 0, duplicatesRemoved: 0, trianglesFlipped: 2, holesFilled: 1, holesLeftOpen: 0 }
    expect(fixesOf(c)).toEqual(['filled 1 hole', 'flipped 2 triangles to face outward'])
    const info = { triangles: 12, volumeMm3: 1, areaMm2: 1, min: [0, 0, 0] as [number, number, number], max: [1, 1, 1] as [number, number, number], sizeMm: [1, 1, 1] as [number, number, number], openEdges: 0, nonManifoldEdges: 0, flippedEdges: 0, watertight: true, components: 1 }
    expect(changed(info, info, { ...c, trianglesFlipped: 0, holesFilled: 0 })).toBe(false)
  })
  it('knows what holding holes takes at a scale', () => {
    expect(scaleCase(0.8, 1)).toBe('open_up')
    expect(scaleCase(1.2, 1)).toBe('grows')
    expect(scaleCase(1.2, 0)).toBe('no_holes')
    expect(meshVolume(scaleParts([cube(10)], 2))).toBeCloseTo(8000, 2)
  })
  it('maps connectors, rotations, resume parts and calibration limits', () => {
    expect(connectorSpec('pins')).toEqual({ kind: 'pin' })
    expect(connectorSpec(undefined)).toEqual({ kind: 'dovetail' })
    expect(connectorSpec('none')).toBeNull()
    expect(rotationName([[1, 0, 0], [0, 1, 0], [0, 0, 1]])).toBe('bottom down (as modeled)')
    expect(rotationName([[1, 0, 0], [0, 0, -1], [0, 1, 0]])).toBe('front down')
    expect(Array.from(dropToBed(cube(10), 4).positions.slice(0, 3))).toEqual([0, 0, -4])
    expect(calibrationNotes('flow')[0]).toMatch(/separate jobs/)
    expect(calibrationNotes('max-volumetric')[0]).toMatch(/approximate/)
  })
})

describe('tools without geometry', () => {
  it('say geometry is needed instead of guessing', async () => {
    const t = toolsWith([cube(20)], false)
    for (const [name, input] of [
      ['mesh_analyze', {}],
      ['mesh_repair', {}],
      ['hollow', {}],
      ['emboss', { text: 'A', sizeMm: 8 }],
      ['resume_from_layer', { measuredHeightMm: 5 }],
    ] as const) {
      const out = await t.run(name, input)
      expect(out.ok, name).toBe(false)
      expect(out.summary, name).toMatch(/needs geometry/)
    }
  })
  it('text_to_part meshes solids itself and says the holes are missing', async () => {
    const t = toolsWith(null, false)
    const out = await t.run('text_to_part', { name: 'Plate', solids: [{ type: 'plate', sizeMm: [40, 20, 3] }], holes: [{ diameterMm: 3.4, atMm: [10, 10, 0] }] })
    expect(out.ok).not.toBe(false)
    expect(JSON.stringify(out.output)).toMatch(/not cut/)
    expect(t.project.objects().some((o) => o.id === 'plate')).toBe(true)
  })
  it('threads_and_fits returns sizes with an honest note', async () => {
    const t = toolsWith([cube(20)], false)
    const out = await t.run('threads_and_fits', { features: [{ kind: 'insert', size: 'M3', atMm: [10, 10, 20] }] })
    expect(out.summary).toMatch(/not cut/)
    expect(out.citations?.length).toBeGreaterThan(0)
  })
  it('orient still scores and applies the axis rotations', async () => {
    const t = toolsWith([cube(20)], false)
    const out = await t.run('orient', { apply: true })
    expect(out.output).toMatchObject({ rotation: 'as modeled', applied: true })
  })
})

describe.skipIf(!geom)('tools with geometry', () => {
  it('mesh_repair fills a hole and swaps the geometry in place', async () => {
    const c = cube(20)
    const broken: MeshPart = { ...c, indices: c.indices.slice(3) }
    const t = toolsWith([broken], true)
    const before = t.project.plates()
    const out = await t.run('mesh_repair', {})
    expect(out.output).toMatchObject({ replaced: true, before: { watertight: false }, after: { watertight: true } })
    expect(t.project.plates()).toEqual(before)
  })
  it('text_to_part cuts holes with the geometry build', async () => {
    const t = toolsWith(null, true)
    const out = await t.run('text_to_part', { name: 'Plate', solids: [{ type: 'plate', sizeMm: [40, 20, 3] }], holes: [{ diameterMm: 3.4, atMm: [10, 10, 0] }] })
    expect(out.output).toMatchObject({ holesCut: true, watertight: true })
    expect(out.summary).toMatch(/1 hole/)
  })
})

describe('batch c scenarios replay', () => {
  const run = async (s: (typeof SCENARIOS)[number]) => {
    const rec = await runScenario(s, { mode: 'replay', model: 'scripted', run: 1 })
    expect({ pass: rec.score.pass, notes: rec.score.notes }).toMatchObject({ pass: true })
  }
  it.each(SCENARIOS.filter((s) => !GEOM_SCENARIOS.has(s.id)).map((s) => [s.id, s] as const))('%s passes', async (_id, s) => run(s))
  // Skipped with a warning (above) when sx-geom is not built.
  it.skipIf(!geom).each(SCENARIOS.filter((s) => GEOM_SCENARIOS.has(s.id)).map((s) => [s.id, s] as const))('%s passes with geometry', async (_id, s) => run(s), GEOM_TIMEOUT_MS)
})

describe('batch c app functions', () => {
  const run = async (s: (typeof FUNCTION_SCENARIOS)[number]) => {
    const runs = await runFunctionScenario(s)
    expect(runs.length).toBeGreaterThan(0)
    for (const r of runs) expect({ id: s.id, name: r.name, ok: r.result.ok, summary: r.result.summary }).toMatchObject({ ok: !EXPECTED_REFUSALS.has(s.id) })
  }
  it.each(FUNCTION_SCENARIOS.filter((s) => !GEOM_SCENARIOS.has(s.id)).map((s) => [s.id, s] as const))('%s runs as a plain function', async (_id, s) => run(s))
  it.skipIf(!geom).each(FUNCTION_SCENARIOS.filter((s) => GEOM_SCENARIOS.has(s.id)).map((s) => [s.id, s] as const))('%s runs as a plain function with geometry', async (_id, s) => run(s), GEOM_TIMEOUT_MS)
})
