// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { MeshPart, Plate } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { evalKb } from '../evals/harness'
import { runScenario } from '../evals/runner'
import { FUNCTION_SCENARIOS, SCENARIOS, sampleGcode } from '../evals/skills/b'
import { EXPECTED_REFUSALS, runFunctionScenario } from '../evals/functions'
import { rotatedBox } from '../src/memory-project'
import { verdict } from '../skills/compare_setups/index'
import { assessFit, faceGrowth } from '../skills/fit_check/index'
import { gcodeRisks } from '../skills/gcode_inspect/index'
import { arcLength, diffGcode, parseDuration, parseGcode } from '../skills/gcode_inspect/parse'
import { goalBounds } from '../skills/optimize_to_target/index'
import { checkChanges, configRisks, plateStrength, strengthProxy, type ProxyInput } from '../skills/optimize_to_target/proxy'
import { compareMetrics, layerHeights, searchSpace, spread, violation, type Metrics } from '../skills/optimize_to_target/search'
import { scoreOrientations } from '../skills/orient/index'
import {
  AXIS_ORIENTATIONS,
  applyRot,
  composeRotation,
  faceExposure,
  openEdges,
  overhangStats,
  rot3,
  rotateItems,
  scoreRotation,
  setItemRotation,
  transformParts,
  unrotateBox,
  type Rot,
} from '../skills/orientation_search/geometry'
import { facePenalty, rankOrientations, type OrientationCandidate } from '../skills/orientation_search/index'
import { assessRisks, engineRisks, warpTendency, type RiskInput } from '../skills/risk_report/index'
import { planSupports, supportFacts, thresholdForLayer } from '../skills/supports/index'
import { layerPlan } from '../skills/smart_layer/plan'
import { modeBand, modeFromRequest } from '../skills/smart_layer/index'

const kb = evalKb()

function part(v: number[], idx: number[]): MeshPart {
  return { name: 'body', slot: 1, positions: new Float32Array(v), indices: new Uint32Array(idx) }
}

/** Closed boxes, outward normals. */
function boxes(list: [number, number, number, number, number, number][]): MeshPart {
  const v: number[] = []
  const idx: number[] = []
  for (const [x0, y0, z0, x1, y1, z1] of list) {
    const b = v.length / 3
    for (const [px, py, pz] of [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]] as const) v.push(px, py, pz)
    for (const t of [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]]) idx.push(b + (t[0] ?? 0), b + (t[1] ?? 0), b + (t[2] ?? 0))
  }
  return part(v, idx)
}

/** The harness shape: a block on a narrow foot, so the underside of the block overhangs. */
const onFoot = (x: number, y: number, z: number): MeshPart => boxes([[0, 0, 0, x * 0.3, y, z * 0.6], [0, 0, z * 0.6, x, y, z]])

/** A square pyramid with its base at z0, closed underneath. */
function pyramid(half: number, z0: number, h: number): MeshPart {
  const v = [-half, -half, z0, half, -half, z0, half, half, z0, -half, half, z0, 0, 0, z0 + h]
  return part(v, [0, 1, 4, 1, 2, 4, 2, 3, 4, 3, 0, 4, 0, 2, 1, 0, 3, 2])
}

const near = (a: number[], b: number[], tol = 1e-6): boolean => a.length === b.length && a.every((x, i) => Math.abs(x - (b[i] ?? NaN)) < tol)

describe('orientation geometry', () => {
  it('names each axis orientation by the face that ends up down', () => {
    const faces: Record<string, [number, number, number]> = { 'bottom down (as modeled)': [0, 0, -1], 'top down': [0, 0, 1], 'front down': [0, -1, 0], 'back down': [0, 1, 0], 'left down': [-1, 0, 0], 'right down': [1, 0, 0] }
    for (const o of AXIS_ORIENTATIONS) {
      const d = applyRot(rot3(o.rotate), faces[o.name] ?? [0, 0, 0])
      expect(near(d, [0, 0, -1]), o.name).toBe(true)
    }
  })

  it('scores axis rotations the same way scoreOrientations does', () => {
    const mesh = [onFoot(40, 20, 60)]
    const byName = new Map(scoreOrientations(mesh, 45).map((s) => [s.name, s]))
    for (const o of AXIS_ORIENTATIONS) {
      const ref = byName.get(o.orientName ?? '')
      const mine = scoreRotation(mesh, o.rotate, 45)
      expect(mine.overhangCm2).toBeCloseTo(ref?.overhangCm2 ?? NaN, 1)
      expect(mine.contactCm2).toBeCloseTo(ref?.contactCm2 ?? NaN, 1)
    }
  })

  it('composes rotations and inverts boxes', () => {
    expect(near(rot3(composeRotation([90, 0, 0], [90, 0, 0])).flat(), rot3([180, 0, 0]).flat())).toBe(true)
    expect(near(rot3(composeRotation([0, 0, 0], [0, 90, 0])).flat(), rot3([0, 90, 0]).flat())).toBe(true)
    const r: Rot = [90, 0, 90]
    expect(unrotateBox(rotatedBox([10, 20, 30], r), r)).toEqual([10, 20, 30])
  })

  it('rotates plate items without touching translation or other objects', () => {
    const t = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 50, 60, 0, 1]
    const plate: Plate = { bed: { widthMm: 256, depthMm: 256, heightMm: 256 }, objects: [{ id: 'a#1', name: 'a', mesh: 'a', transform: t }, { id: 'b#1', name: 'b', mesh: 'b', transform: t }] }
    const r = rotateItems(plate, [0, 0, 90], 'a')
    expect(r.objects[0]?.transform.slice(12)).toEqual([50, 60, 0, 1])
    expect(r.objects[0]?.transform[1]).toBeCloseTo(1)
    expect(r.objects[1]?.transform).toEqual(t)
    expect(plate.objects[0]?.transform).toEqual(t)
    const s = setItemRotation(plate, 'b', [180, 0, 0])
    expect(s.objects[1]?.transform[10]).toBeCloseTo(-1)
  })

  it('counts open edges', () => {
    const closed = boxes([[0, 0, 0, 10, 10, 10]])
    expect(openEdges([closed])).toBe(0)
    const holed = part(Array.from(closed.positions), Array.from(closed.indices).slice(0, -3))
    expect(openEdges([holed])).toBe(3)
  })

  it('measures overhangs, contact and faces', () => {
    const s = overhangStats([onFoot(60, 30, 40)], 60)
    expect(s.overhangCm2).toBeCloseTo(18, 0)
    expect(s.flatShare).toBe(1)
    expect(s.contactCm2).toBeCloseTo(5.4, 1)
    const up = faceExposure([onFoot(60, 30, 40)], [0, 0, 0], 'top')
    expect(up.facing).toBe('up')
    const down = faceExposure([onFoot(60, 30, 40)], [180, 0, 0], 'top')
    expect(down.facing).toBe('down')
    expect(down.onBedCm2).toBeGreaterThan(0)
    expect(faceExposure(null, [90, 0, 0], 'front').facing).toBe('down')
  })
})

describe('strength proxy and setting checks', () => {
  const p: ProxyInput = { wallLoops: 2, lineWidth: 0.42, density: 15, pattern: 'grid', layerHeight: 0.2, nozzle: 0.4, topLayers: 5, bottomLayers: 3 }
  const box: [number, number, number] = [100, 50, 30]
  it('grows with walls and infill, and weighs lightning low', () => {
    expect(strengthProxy(box, { ...p, wallLoops: 4 })).toBeGreaterThan(strengthProxy(box, p))
    expect(strengthProxy(box, { ...p, density: 40 })).toBeGreaterThan(strengthProxy(box, p))
    expect(strengthProxy(box, { ...p, pattern: 'lightning' })).toBeLessThan(strengthProxy(box, { ...p, pattern: 'gyroid' }))
    expect(strengthProxy(box, { ...p, layerHeight: 0.3 })).toBeLessThan(strengthProxy(box, p))
    expect(plateStrength([box, box], { wall_loops: 2 })).toBeCloseTo(2 * plateStrength([box], { wall_loops: 2 }))
  })

  it('caps walls on thin parts', () => {
    expect(strengthProxy([4, 4, 10], { ...p, wallLoops: 20 })).toBeCloseTo(strengthProxy([4, 4, 10], { ...p, wallLoops: 10 }), 6)
  })

  it('checks changes against the settings catalog', () => {
    const c = checkChanges(kb, { wall_loops: 40, sparse_infill_density: '25%', sparse_infill_pattern: 'wiggly', support_type: 'tree(auto)', nozzle_temperature: 250, made_up_key: 1 })
    expect(c.rejected.some((r) => r.startsWith('wall_loops'))).toBe(true)
    expect(c.rejected.some((r) => r.startsWith('sparse_infill_pattern'))).toBe(true)
    expect(c.accepted['sparse_infill_density']).toBe(25)
    expect(c.accepted['support_type']).toBe('tree(auto)')
    expect(c.guarded).toContain('nozzle_temperature')
    expect(c.unknown).toEqual(['made_up_key'])
  })

  it('notes risky configs', () => {
    expect(configRisks({ layer_height: 0.36, wall_loops: 1, sparse_infill_pattern: 'lightning', nozzle_diameter: [0.4] }, 0.4)).toHaveLength(3)
    expect(configRisks({ layer_height: 0.2, wall_loops: 3, sparse_infill_density: 20, top_shell_layers: 5 }, 0.4)).toEqual([])
  })
})

describe('optimize_to_target search', () => {
  it('builds layer heights from 25 to 75 percent of the nozzle', () => {
    expect(layerHeights(0.4)).toEqual([0.12, 0.16, 0.2, 0.24, 0.28])
    expect(layerHeights(0.6)).toEqual([0.18, 0.24, 0.3, 0.36, 0.42])
    expect(layerHeights(0.4, { min: 0.2 })).toEqual([0.2, 0.24, 0.28])
    expect(spread(9, 3)).toEqual([0, 4, 8])
    expect(spread(2, 3)).toEqual([0, 1])
  })

  it('ranks results that fit first, then by the objective', () => {
    const t = { maxTimeS: 100, objective: 'strength' as const }
    const a: Metrics = { timeS: 90, grams: 1, cost: 1, strength: 5 }
    const b: Metrics = { timeS: 120, grams: 1, cost: 1, strength: 50 }
    const c: Metrics = { timeS: 80, grams: 1, cost: 1, strength: 9 }
    expect(violation(b, t)).toBeCloseTo(0.2)
    expect([a, b, c].sort((x, y) => compareMetrics(x, y, t))).toEqual([c, a, b])
    expect([a, c].sort((x, y) => compareMetrics(x, y, { objective: 'time' }))).toEqual([c, a])
  })

  it('finds the strongest candidate under a limit within the budget', async () => {
    // Strength and time both grow with walls and infill; the best that fits is walls 5, infill 50.
    const dims = [
      { key: 'wall_loops', values: [1, 2, 3, 4, 5, 6, 7, 8] },
      { key: 'sparse_infill_density', values: [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100] },
      { key: 'sparse_infill_pattern', values: ['grid', 'gyroid'] },
    ]
    const model = (w: number, d: number, pattern: string): Metrics => ({ timeS: w * 10 + d, grams: 0, cost: 0, strength: 30 * Math.sqrt(w) + d + (pattern === 'gyroid' ? 1 : 0) })
    let calls = 0
    const res = await searchSpace({
      dims,
      target: { maxTimeS: 100, objective: 'strength' },
      maxCandidates: 120,
      stop: () => false,
      evaluate: async (v) => {
        calls++
        return model(Number(v[0]), Number(v[1]), String(v[2]))
      },
    })
    // The exhaustive answer over all 176 combinations.
    let best: Metrics | null = null
    for (const w of dims[0]?.values ?? []) for (const d of dims[1]?.values ?? []) for (const p of dims[2]?.values ?? []) {
      const m = model(Number(w), Number(d), String(p))
      if (m.timeS <= 100 && (!best || m.strength > best.strength)) best = m
    }
    expect(calls).toBeLessThanOrEqual(120)
    expect(res.evaluated[0]?.metrics.timeS).toBeLessThanOrEqual(100)
    expect(res.evaluated[0]?.metrics.strength).toBeCloseTo(best?.strength ?? NaN)
  })

  it('stops at the budget and at the time cap', async () => {
    const dims = [{ key: 'a', values: Array.from({ length: 30 }, (_, i) => i) }, { key: 'b', values: Array.from({ length: 30 }, (_, i) => i) }]
    const evaluate = async (v: (number | string)[]): Promise<Metrics> => ({ timeS: Number(v[0]), grams: 0, cost: 0, strength: Number(v[1]) })
    const budget = await searchSpace({ dims, target: { objective: 'strength' }, maxCandidates: 25, stop: () => false, evaluate })
    expect(budget.evaluated.length).toBe(25)
    expect(budget.stoppedBy).toBe('budget')
    let n = 0
    const timed = await searchSpace({ dims, target: { objective: 'strength' }, maxCandidates: 500, stop: () => ++n > 5, evaluate })
    expect(timed.stoppedBy).toBe('time')
  })

  it('reads goal floors from the intent knowledge', () => {
    const g = goalBounds(kb, [{ id: 'strength' }], '2026-09-30', { nozzle: 0.4, material: 'petg' }, { wall_loops: 2, bottom_shell_layers: 3, top_shell_layers: 5 })
    expect(g.floors['wall_loops']?.min).toBe(4)
    expect(g.floors['sparse_infill_density']?.min).toBe(25)
    expect(g.floors['sparse_infill_pattern']?.set).toBe('gyroid')
    expect(g.extras['bottom_shell_layers']).toBe(4)
    expect(g.extras['top_shell_layers']).toBeUndefined()
    expect(g.guarded.map((t) => t.key)).toContain('nozzle_temperature')
    expect(g.sources.length).toBeGreaterThan(0)
    expect(goalBounds(kb, [{ id: 'strength', level: 'max' }], '2026-09-30', { nozzle: 0.4 }, {}).floors['wall_loops']?.min).toBe(6)
  })
})

describe('orientation_search ranking', () => {
  const cand = (name: string, over: Partial<OrientationCandidate>): OrientationCandidate => ({ name, rotate: [0, 0, 0], timeS: 100, grams: 10, overhangCm2: 0, contactCm2: 10, heightMm: 10, faces: [], ...over })
  it('prefers less support and keeps clean faces off supports', () => {
    const r = rankOrientations([cand('a', { overhangCm2: 10 }), cand('b', { overhangCm2: 0 })])
    expect(r[0]?.name).toBe('b')
    const faceDown = { face: 'front' as const, areaCm2: 4, onBedCm2: 0, supportedCm2: 4, facing: 'down' as const }
    const faceUp = { face: 'front' as const, areaCm2: 4, onBedCm2: 0, supportedCm2: 0, facing: 'up' as const }
    expect(facePenalty(faceDown)).toBe(1)
    expect(facePenalty(faceUp)).toBe(0)
    const s = rankOrientations([cand('scarred', { overhangCm2: 1, faces: [faceDown] }), cand('clean', { overhangCm2: 3, faces: [faceUp] })])
    expect(s[0]?.name).toBe('clean')
    expect(rankOrientations([cand('scarred', { overhangCm2: 1, faces: [faceDown] }), cand('clean', { overhangCm2: 3, faces: [faceUp] })], { time: 1, support: 1, contact: 0, surface: 0 })[0]?.name).toBe('scarred')
  })

  it('drops the support weight without a mesh', () => {
    const r = rankOrientations([cand('slow', { overhangCm2: null, timeS: 200 }), cand('fast', { overhangCm2: null, timeS: 100 })])
    expect(r[0]?.name).toBe('fast')
  })
})

describe('risk_report checks', () => {
  const src = { warp: ['w'], tall: ['t'], overhang: ['o'], firstLayer: ['f'] }
  const base: RiskInput = { object: { name: 'Enclosure lid', bboxMm: [200, 150, 20] }, warpTendency: 3, materialName: 'ABS', enclosed: false, printerName: 'A1', overhang: null, openEdges: null, supportsOn: false, brimOn: false, supportAngle: 30 }
  it('flags warping on large ABS footprints on open printers', () => {
    const r = assessRisks(base, src)
    expect(r[0]?.id).toBe('warp')
    expect(r[0]?.level).toBe('high')
    expect(r[0]?.sources).toEqual(['w'])
    expect(assessRisks({ ...base, warpTendency: 1, object: { name: 'Calibration cube', bboxMm: [20, 20, 20] } }, src)).toEqual([])
  })

  it('flags tall thin parts, overhangs, open edges and small contact', () => {
    const r = assessRisks(
      { ...base, warpTendency: 1, object: { name: 'Cable hook', bboxMm: [10, 12, 90] }, overhang: { overhangCm2: 6, flatShare: 1, overPartCm2: 0, contactCm2: 0.3, regions: 1, maxHeightMm: 40, heightMm: 90 }, openEdges: 12 },
      src,
    )
    expect(r.map((x) => x.id).sort()).toEqual(['first_layer', 'open_edges', 'overhang', 'tall_thin'])
    expect(r.find((x) => x.id === 'tall_thin')?.level).toBe('high')
    expect(r.find((x) => x.id === 'overhang')?.level).toBe('high')
  })

  it("turns the engine's thin wall, floating island and long bridge warnings into risks with a place and a fix", () => {
    const warnings = [
      { code: 'thin_wall' as const, message: 'A feature thinner than 0.42 mm on layers 3 to 9 near X 12.5 Y 40.0 mm is too thin for the walls and will not print. Switch the wall generator to Arachne, which prints features down to a quarter of the nozzle, or scale the part up.', layer: 2 },
      { code: 'floating_region' as const, message: 'A region starts in mid-air on layer 16 (from Z 3.00 mm) near X 22.5 Y 2.5 mm, with nothing under it. Turn on supports or paint support there.', layer: 15 },
      { code: 'floating_region' as const, message: 'An overhang on layer 26 near X 30.0 Y 5.0 mm reaches 12.0 mm past what holds it. Turn on supports or paint support there.', layer: 25 },
      { code: 'long_bridge' as const, message: 'A bridge on layer 26 near X 30.0 Y 5.0 mm spans 40.0 mm, longer than the 10 mm max bridge length, and can sag. Turn on supports, or slow bridges down and give them more fan.', layer: 25 },
      { code: 'floating_region' as const, message: '3 more regions need support. Turn on supports or paint support there.' },
    ]
    const r = engineRisks(warnings, { name: 'Arch', id: 'o1' }, src)
    expect(r.map((x) => x.id)).toEqual(['thin_wall', 'floating', 'long_bridge'])
    expect(r[0]).toMatchObject({ object: 'Arch', objectId: 'o1', at: [12.5, 40], level: 'medium', settings: { wall_generator: 'arachne' } })
    expect(r[0]?.detail).toMatch(/^A feature thinner than 0.42 mm .* will not print\.$/)
    expect(r[0]?.fix).toMatch(/^Switch the wall generator to Arachne/)
    expect(r[1]).toMatchObject({ level: 'high', settings: { enable_support: true }, at: [22.5, 2.5] })
    expect(r[2]).toMatchObject({ level: 'high', settings: { enable_support: true } })
    // Without one object to name, a finding belongs to the plate and keeps its place.
    expect(engineRisks(warnings.slice(0, 1), null, src)[0]).toMatchObject({ object: 'the plate', at: [12.5, 40] })
    expect(engineRisks(warnings.slice(0, 1), null, src)[0]?.objectId).toBeUndefined()
  })

  it('reads warp tendency from the filament enclosure need', () => {
    expect(warpTendency(kb.get('filament', 'abs'))).toBe(3)
    expect(warpTendency(kb.get('filament', 'pla'))).toBe(1)
  })
})

describe('supports planning', () => {
  const facts = supportFacts(kb.get('workflow', 'supports'))
  const stats = { overhangCm2: 18, flatShare: 1, overPartCm2: 0, contactCm2: 5, regions: 2, maxHeightMm: 24, heightMm: 40 }
  it('interpolates the threshold from the layer height', () => {
    expect(thresholdForLayer(0.08)).toBe(15)
    expect(thresholdForLayer(0.2)).toBe(30)
    expect(thresholdForLayer(0.28)).toBe(40)
    expect(thresholdForLayer(0.12)).toBe(20)
    expect(thresholdForLayer(0.4)).toBe(40)
    expect(facts.type.length).toBeGreaterThan(0)
  })

  it('picks normal for flat ceilings and tree for spread overhangs, with Orca values', () => {
    const flat = planSupports({ stats, threshold: 30, material: 'pla', protect: [] }, facts)
    expect(flat.changes).toMatchObject({ enable_support: true, support_type: 'normal(auto)', support_on_build_plate_only: true })
    const spreadOut = planSupports({ stats: { ...stats, flatShare: 0.2, regions: 7, overPartCm2: 9 }, threshold: 30, material: 'petg', protect: [] }, facts)
    expect(spreadOut.changes).toMatchObject({ support_type: 'tree(auto)', support_style: 'organic', support_on_build_plate_only: false, support_top_z_distance: 0.25 })
    expect(spreadOut.removalRisk).toBe('high')
    for (const plan of [flat, spreadOut]) expect(checkChanges(kb, plan.changes).rejected).toEqual([])
    expect(planSupports({ stats: { ...stats, overhangCm2: 0.2 }, threshold: 30, material: 'pla', protect: [] }, facts).changes).toEqual({ enable_support: false })
  })

  it('protects an upward face with build plate only and says when a face needs blockers', () => {
    const up = planSupports({ stats: { ...stats, overPartCm2: 12 }, threshold: 30, material: 'pla', protect: [{ face: 'top', areaCm2: 5, onBedCm2: 0, supportedCm2: 0, facing: 'up' }] }, facts)
    expect(up.changes['support_on_build_plate_only']).toBe(true)
    expect(up.changes['support_style']).toBe('snug')
    const down = planSupports({ stats, threshold: 30, material: 'pla', protect: [{ face: 'front', areaCm2: 5, onBedCm2: 0, supportedCm2: 5, facing: 'down' }] }, facts)
    expect(down.notes.join(' ')).toMatch(/paint support in the core/)
  })
})

describe('fit_check', () => {
  const base = { gapMm: 0.3, feature: 'print_in_place' as const, direction: 'xy' as const, layerHeight: 0.2, lineWidth: 0.42, nozzle: 0.4, material: 'pla' }
  it('judges XY gaps for print in place, slide and press', () => {
    expect(assessFit(base).outcome).toBe('slides')
    expect(assessFit({ ...base, gapMm: 0.2 })).toMatchObject({ outcome: 'binds', suggestedGapMm: 0.3 })
    expect(assessFit({ ...base, gapMm: 0.1 }).outcome).toBe('fuses')
    expect(assessFit({ ...base, feature: 'slide', gapMm: 0.2 }).outcome).toBe('slides')
    expect(assessFit({ ...base, feature: 'press', gapMm: 0.05 }).outcome).toBe('press fit')
    expect(assessFit({ ...base, feature: 'press', gapMm: 0.3 }).outcome).toBe('slides')
  })

  it('grows more for PETG, wide lines and near the bed, and uses a measured value when given', () => {
    expect(faceGrowth({ ...base, material: 'petg' }).growth).toBeCloseTo(0.08)
    expect(faceGrowth({ ...base, lineWidth: 0.6 }).growth).toBeGreaterThan(0.05)
    expect(faceGrowth({ ...base, nearBed: true }).growth).toBeCloseTo(0.15)
    expect(faceGrowth({ ...base, nearBed: true, elephantFootCompensation: 0.15 }).growth).toBeCloseTo(0.05)
    expect(faceGrowth({ ...base, measuredGrowthMm: 0.12 }).growth).toBe(0.12)
  })

  it('rounds vertical gaps to layers and allows for sag', () => {
    expect(assessFit({ ...base, direction: 'z', gapMm: 0.2 }).outcome).toBe('fuses')
    const r = assessFit({ ...base, direction: 'z', gapMm: 0.3 })
    expect(r.outcome).toBe('fuses')
    expect(r.suggestedGapMm).toBe(0.4)
    expect(assessFit({ ...base, direction: 'z', gapMm: 0.4 }).outcome).toBe('slides')
    expect(assessFit({ ...base, direction: 'z', gapMm: 0.4, material: 'petg' }).outcome).toBe('binds')
    expect(assessFit({ ...base, direction: 'z', gapMm: 0.4, material: 'petg' }).suggestedGapMm).toBe(0.6)
  })
})

describe('gcode parsing', () => {
  const a = sampleGcode({ layer: 0.2, speed: 60, nozzle: 245, bed: 70, retract: 0.8 })
  const b = sampleGcode({ layer: 0.28, speed: 250, nozzle: 250, bed: 70, retract: 0.8 })
  it('keeps start G-code probing and wipe temperatures out of the printing temperatures', () => {
    const start = ['M83', 'M104 S140', 'G28', 'M109 S250', 'G1 E5 F300', 'M104 S75', 'M104 T1 S260', 'M109 S220', 'G1 X10 Y10 E1 F1200', 'T1', 'G1 X20 Y10 E1', 'M104 T0 S0'].join('\n')
    const s = parseGcode(start)
    expect(s.temps.nozzle).toEqual([140, 250, 75, 260, 220])
    expect(s.temps.nozzlePrinting).toEqual([220, 260])
  })
  it('reads layers, temperatures, speeds, retraction, fan and features', () => {
    const s = parseGcode(a)
    expect(s.layers).toBe(40)
    expect(s.maxZMm).toBe(8)
    expect(s.temps).toEqual({ nozzle: [245], bed: [70], chamber: [], nozzlePrinting: [245] })
    expect(s.feed.typicalPrintMmS).toBe(60)
    expect(s.feed.maxPrintMmS).toBe(60)
    expect(s.feed.maxTravelMmS).toBe(200)
    expect(s.retractions).toMatchObject({ count: 40, typicalMm: 0.8 })
    expect(s.fan.maxPct).toBe(100)
    expect(s.extrusion.relative).toBe(true)
    expect(s.timeByFeature.map((f) => f.feature)).toEqual(expect.arrayContaining(['outer wall', 'sparse infill', 'travel']))
    expect(s.flow.p95Mm3s).toBeCloseTo(0.2 * 0.42 * 60, 0)
    expect(s.generator).toBe('generated by SlicerX')
  })

  it('handles absolute extrusion, G92, arcs, wipes and slicer time comments', () => {
    const text = [
      '; estimated printing time (normal mode) = 1h 2m 3s',
      'M82',
      'G92 E0',
      'G1 Z0.2 F600',
      ';TYPE:External perimeter',
      'G1 X10 Y0 E1 F1800',
      'G1 X10 Y10 E2',
      'G1 X5 Y10 E1.6 F2400',
      'G1 X2 Y10 E1.2',
      'G1 E2 F2400',
      'G2 X20 Y10 I5 J0 E3 F1800',
      'G92 E0',
      'G1 X30 Y10 E0.5',
      'M106 P1 S128',
      'M107',
      'G1X40Y10E1.0F1200',
    ].join('\n')
    const s = parseGcode(text)
    expect(s.slicerTimeS).toBe(3723)
    expect(s.extrusion.relative).toBe(false)
    expect(s.retractions.count).toBe(1)
    expect(s.retractions.totalMm).toBeCloseTo(0.8, 5)
    expect(s.fan).toEqual({ maxPct: 50, changes: 2 })
    expect(s.timeByFeature[0]?.feature).toBe('outer wall')
    expect(s.feed.maxPrintMmS).toBe(30)
    expect(parseDuration('2d 3h')).toBe(183600)
    expect(parseDuration('nothing')).toBeNull()
    expect(parseGcode(';TIME:5400\nG1 X1 E1 F600\n').slicerTimeS).toBe(5400)
    expect(parseGcode('; model printing time: 1h 2m; total estimated time: 1h 10m 3s\nG1 X1 E1 F600\n').slicerTimeS).toBe(4203)
  })

  it('diffs two files and flags flow past the filament limit', () => {
    const sa = parseGcode(a)
    const sb = parseGcode(b)
    const rows = diffGcode(sa, sb)
    const matters = rows.filter((r) => r.matters).map((r) => r.metric)
    expect(matters).toEqual(expect.arrayContaining(['time', 'layers', 'typical print speed', 'peak flow', 'nozzle temps']))
    expect(rows.find((r) => r.metric === 'bed temps')?.matters).toBeUndefined()
    const risks = gcodeRisks(sb, kb.get('filament', 'petg'))
    expect(risks.some((r) => /over the 15 mm3\/s/.test(r.text))).toBe(true)
    expect(risks[0]?.sources.length).toBeGreaterThan(0)
    expect(gcodeRisks(sa, kb.get('filament', 'petg'))).toEqual([])
  })

  it('does not warn on brief flow peaks over the limit, only on sustained flow', () => {
    const petg = kb.get('filament', 'petg')
    const base = parseGcode(a)
    const brief = { ...base, flow: { peakMm3s: 40, p95Mm3s: 10 } }
    expect(gcodeRisks(brief, petg).filter((r) => r.fact.kind === 'flow')).toEqual([])
    const sustained = { ...base, flow: { peakMm3s: 40, p95Mm3s: 30 } }
    expect(gcodeRisks(sustained, petg).find((r) => r.fact.kind === 'flow')?.fact).toMatchObject({ kind: 'flow', mm3s: 30, limit: 15 })
  })

  it('measures arcs along the arc, so a tight arc does not read as a flow spike', () => {
    const P = (o: Record<string, number>) => new Map(Object.entries(o))
    // A half circle of radius 5, both ways round, and the long and short arcs of R.
    expect(arcLength(0, 0, 10, 0, 0, true, P({ I: 5, J: 0 }))).toBeCloseTo(5 * Math.PI, 6)
    expect(arcLength(0, 0, 10, 0, 0, false, P({ I: 5, J: 0 }))).toBeCloseTo(5 * Math.PI, 6)
    expect(arcLength(0, 0, 10, 0, 0, true, P({ R: 5 }))).toBeCloseTo(5 * Math.PI, 6)
    expect(arcLength(0, 0, 5, 5, 0, true, P({ R: -5 }))).toBeCloseTo(7.5 * Math.PI, 6)
    // Start and end at the same point is a full circle; P adds circles, Z makes a helix.
    expect(arcLength(0, 0, 0, 0, 0, false, P({ I: 1, J: 0 }))).toBeCloseTo(2 * Math.PI, 6)
    expect(arcLength(0, 0, 0, 0, 0, false, P({ I: 1, J: 0, P: 1 }))).toBeCloseTo(4 * Math.PI, 6)
    expect(arcLength(0, 0, 0, 0, 0.4, false, P({ I: 1, J: 0 }))).toBeCloseTo(Math.hypot(2 * Math.PI, 0.4), 6)
    // Most of a circle of radius 2 around a hole, ending 0.4 mm from its start, at 20 mm3/s on a 0.42 x 0.2 bead.
    const sweep = 2 * Math.PI - 0.2
    const e = (2 * sweep * 0.42 * 0.2) / (Math.PI * 0.875 ** 2)
    const feed = (20 / (0.42 * 0.2)) * 60
    const x1 = 2 + 2 * Math.cos(Math.PI + sweep)
    const y1 = 2 * Math.sin(Math.PI + sweep)
    const s = parseGcode(['M83', 'G1 X0 Y0 F12000', `G3 X${x1.toFixed(4)} Y${y1.toFixed(4)} I2 J0 E${e.toFixed(5)} F${feed.toFixed(0)}`].join('\n'))
    expect(s.flow.peakMm3s).toBeCloseTo(20, 0)
    expect(s.flow.p95Mm3s).toBeCloseTo(20, 0)
  })

  it('checks flow against the profile the file was sliced with, which the slicer already held it to', () => {
    const pla = kb.get('filament', 'pla')
    const base = parseGcode(a)
    // An H2D PLA profile allows 25 mm3/s; the material's generic standard hotend figure is lower.
    const atCap = { ...base, flow: { peakMm3s: 24.6, p95Mm3s: 24.5 } }
    expect(gcodeRisks(atCap, pla, 25).filter((r) => r.fact.kind === 'flow')).toEqual([])
    expect(gcodeRisks({ ...atCap, profileMaxFlowMm3s: 25 }, pla).filter((r) => r.fact.kind === 'flow')).toEqual([])
    expect(parseGcode('; filament_max_volumetric_speed = 25,12\nG1 X1 E0.1 F600\n').profileMaxFlowMm3s).toBe(25)
    // A file that goes past its own profile's limit was edited or sliced without it.
    const over = { ...base, flow: { peakMm3s: 40, p95Mm3s: 32 } }
    expect(gcodeRisks(over, pla, 25).find((r) => r.fact.kind === 'flow')?.fact).toMatchObject({ basis: 'profile', mm3s: 32, limit: 25 })
  })

  it('labels findings A and B only when comparing two files', async () => {
    const { runAppFunction } = await import('../src/functions')
    const hot = sampleGcode({ layer: 0.28, speed: 250, nozzle: 250, bed: 70, retract: 0.8 })
    const one = await runAppFunction('gcode_inspect', { text: hot, material: 'petg' }, { host: { printers: { list: async () => [], status: async () => null } } as never })
    const risks = (one.output as { risks: string[] }).risks
    expect(risks.length).toBeGreaterThan(0)
    for (const r of risks) expect(r).not.toMatch(/^[AB]: /)
    const two = await runAppFunction('gcode_inspect', { text: hot, compareText: a, material: 'petg' }, { host: { printers: { list: async () => [], status: async () => null } } as never })
    expect((two.output as { risks: string[] }).risks[0]).toMatch(/^A: /)
  })

  it('reads a large file quickly', () => {
    const big = sampleGcode({ layer: 0.1, speed: 100, nozzle: 220, bed: 60, retract: 0.5, heightMm: 300 })
    const t0 = performance.now()
    const s = parseGcode(big)
    expect(s.layers).toBe(3000)
    expect(performance.now() - t0).toBeLessThan(3000)
  })
})

describe('variable layer planning', () => {
  const heights = layerHeights(0.4)
  it('keeps thick layers on vertical walls and flats', () => {
    const plan = layerPlan([boxes([[0, 0, 0, 20, 20, 20]])], heights, 'standard', 0.4)
    expect(plan.segments).toEqual([{ fromMm: 0, toMm: 20, heightMm: 0.28, slopeDeg: null }])
    expect(plan.layers).toBe(71)
  })

  it('uses thin layers on shallow slopes only', () => {
    const plan = layerPlan([boxes([[-20, -20, 0, 20, 20, 10]]), pyramid(20, 10, 5)], heights, 'standard', 0.4)
    const low = plan.segments.find((s) => s.fromMm === 0)
    const roof = plan.segments[plan.segments.length - 1]
    expect(low?.heightMm).toBe(0.28)
    expect(roof?.heightMm).toBe(0.12)
    expect(roof?.toMm).toBe(15)
    expect(roof?.slopeDeg).toBe(14)
    const steep = layerPlan([pyramid(10, 0, 20)], heights, 'standard', 0.4)
    expect(steep.segments.every((s) => s.heightMm === 0.2)).toBe(true)
    const draft = layerPlan([pyramid(10, 0, 20)], heights, 'draft', 0.4)
    expect(draft.segments.every((s) => s.heightMm >= 0.28)).toBe(true)
  })

  it('plans on the part as placed', () => {
    const lying = transformParts([pyramid(10, 0, 20)], [180, 0, 0])
    expect(layerPlan(lying, heights, 'standard', 0.4).heightMm).toBe(20)
  })
})

describe('compare_setups verdict', () => {
  it('says which setup is faster, lighter and stronger', () => {
    const a = { name: 'A', timeS: 100, grams: 10, cost: 1, strength: 100, layers: 10, risks: [], rejected: [] }
    const v = verdict(a, { ...a, name: 'B', timeS: 80, strength: 130, risks: ['x'] })
    expect(v).toMatch(/B is 20% faster/)
    expect(v).toMatch(/B is about 30% stronger/)
    expect(v).toMatch(/A has fewer risk notes/)
    expect(verdict(a, { ...a, name: 'B' })).toBe('The two setups come out about the same.')
  })
})

describe('batch b scenarios replay', () => {
  it.each(SCENARIOS.map((s) => [s.id, s] as const))('%s passes', async (_id, s) => {
    const rec = await runScenario(s, { mode: 'replay', model: 'scripted', run: 1 })
    expect({ pass: rec.score.pass, notes: rec.score.notes }).toMatchObject({ pass: true })
  })
})

describe('smart_layer', () => {
  it('picks Strength for functional parts and Quality for looks', () => {
    expect(modeFromRequest('12 strong PETG brackets', kb, '2026-09-30')).toBe('strength')
    expect(modeFromRequest('a smooth display figure', kb, '2026-09-30')).toBe('quality')
    expect(modeFromRequest('print this', kb, '2026-09-30')).toBeNull()
  })

  it('reads the mode band from the sleipnir guide', () => {
    const s = modeBand(kb, 'strength', 'pla')
    expect(s.floor).toBe(0.3)
    expect(s.ceiling).toBe(0.5)
  })
})

describe('batch b app functions', () => {
  it.each(FUNCTION_SCENARIOS.map((s) => [s.id, s] as const))('%s runs as a plain function', async (_id, s) => {
    const runs = await runFunctionScenario(s)
    expect(runs.length).toBeGreaterThan(0)
    for (const r of runs) expect({ id: s.id, name: r.name, ok: r.result.ok, summary: r.result.summary }).toMatchObject({ ok: !EXPECTED_REFUSALS.has(s.id) })
  })
})
