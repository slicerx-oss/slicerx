// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The creative prompt set's checks on synthetic geometry built here: a cube, an open box, a thin plate, a hollow
// cube, overlapping boxes and two gear pairs whose gap is set exactly. None of it is model output.
import { readdirSync } from 'node:fs'
import type { MeshPart } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { bedFit, bodyCount, closure, minWall, movingGaps } from '../evals/creative/mesh-checks'
import { CREATIVE_PROMPTS, type CreativePrompt } from '../evals/creative/prompts'
import { loadRecording, parseRecording, RECORDINGS_DIR } from '../evals/creative/recordings'
import { buildVolumeOf, clearanceNeed, runPrompt, scoreParts, wallLimitMm } from '../evals/creative/run'

type Pt = [number, number]

/** A closed prism over a star shaped outline (counterclockwise), capped with fans from (cx, cy). */
function prism(outline: Pt[], z0: number, z1: number, center: Pt = [0, 0], opts: { open?: boolean; inward?: boolean } = {}): MeshPart {
  const n = outline.length
  const pos: number[] = [center[0], center[1], z0, center[0], center[1], z1]
  for (const [x, y] of outline) pos.push(x, y, z0)
  for (const [x, y] of outline) pos.push(x, y, z1)
  const b = (i: number): number => 2 + (i % n)
  const t = (i: number): number => 2 + n + (i % n)
  const idx: number[] = []
  for (let i = 0; i < n; i++) {
    idx.push(0, b(i + 1), b(i))
    if (!opts.open) idx.push(1, t(i), t(i + 1))
    idx.push(b(i), b(i + 1), t(i + 1), b(i), t(i + 1), t(i))
  }
  if (opts.inward) for (let k = 0; k < idx.length; k += 3) [idx[k + 1], idx[k + 2]] = [idx[k + 2] ?? 0, idx[k + 1] ?? 0]
  return { name: 'fixture', slot: 1, positions: new Float32Array(pos), indices: new Uint32Array(idx) }
}

const rect = (x0: number, y0: number, x1: number, y1: number): Pt[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, opts?: { open?: boolean; inward?: boolean }): MeshPart =>
  prism(rect(x0, y0, x1, y1), z0, z1, [(x0 + x1) / 2, (y0 + y1) / 2], opts)

/** Joins parts into one mesh part, as a tool that returns several shells in one part does. */
function join(parts: MeshPart[]): MeshPart {
  const pos: number[] = []
  const idx: number[] = []
  for (const p of parts) {
    const base = pos.length / 3
    pos.push(...p.positions)
    for (const i of p.indices) idx.push(base + i)
  }
  return { name: 'joined', slot: 1, positions: new Float32Array(pos), indices: new Uint32Array(idx) }
}

/** A 12 tooth gear outline: tips and roots alternating, turned by `phase`, centered on (cx, 0). */
function gearOutline(cx: number, phase: number): Pt[] {
  const teeth = 12
  const out: Pt[] = []
  for (let k = 0; k < teeth * 2; k++) {
    const a = phase + (k * Math.PI) / teeth
    const r = k % 2 === 0 ? 12 : 9
    out.push([cx + r * Math.cos(a), r * Math.sin(a)])
  }
  return out
}

/** Smallest distance between two closed 2D outlines, point to segment both ways (the fixture's own measure). */
function outlineGap(a: Pt[], b: Pt[]): number {
  const seg = (p: Pt, s: Pt, e: Pt): number => {
    const dx = e[0] - s[0]
    const dy = e[1] - s[1]
    const u = Math.max(0, Math.min(1, ((p[0] - s[0]) * dx + (p[1] - s[1]) * dy) / (dx * dx + dy * dy)))
    return Math.hypot(p[0] - s[0] - u * dx, p[1] - s[1] - u * dy)
  }
  let best = Infinity
  for (const [from, to] of [[a, b], [b, a]] as const) for (const p of from) for (let i = 0; i < to.length; i++) best = Math.min(best, seg(p, to[i] ?? p, to[(i + 1) % to.length] ?? p))
  return best
}

/** Two meshing gears, 6 mm thick, spaced so the closest teeth are `gap` mm apart (found by bisection). */
function gearPair(gap: number): MeshPart[] {
  const a = gearOutline(0, 0)
  // The second gear turned half a tooth so its tip points into the first one's valley.
  const at = (cx: number): Pt[] => gearOutline(cx, Math.PI / 12)
  // At 21 mm a tip (radius 12) just touches the other gear's root (radius 9); by 25 mm the teeth are well apart.
  let lo = 21
  let hi = 25
  for (let k = 0; k < 60; k++) {
    const mid = (lo + hi) / 2
    if (outlineGap(a, at(mid)) < gap) lo = mid
    else hi = mid
  }
  const cx = (lo + hi) / 2
  return [prism(a, 0, 6, [0, 0]), prism(at(cx), 0, 6, [cx, 0])]
}

const P1S = { printer: 'bambu_p1s', material: 'pla', nozzle: 0.4 }
const prompt = (over: Partial<CreativePrompt>): CreativePrompt => ({ id: 'fixture', title: 'Fixture', prompt: 'fixture', machine: P1S, bodies: [1, 1], ...over })
const passing = { pass: true, detail: 'fixture' }

describe('mesh checks on synthetic geometry', () => {
  it('a 20 mm cube is closed, one body, 20 mm walls, and fits the bed', () => {
    const cube = [box(0, 0, 0, 20, 20, 20)]
    expect(closure(cube)).toEqual({ watertight: true, openEdges: 0, nonManifoldEdges: 0, flippedEdges: 0 })
    expect(bodyCount(cube)).toBe(1)
    expect(minWall(cube).minWallMm).toBeCloseTo(20, 3)
    expect(bedFit(cube, { shape: 'rectangular', x: 256, y: 256, z: 256 })).toEqual({ fits: true, sizeMm: [20, 20, 20] })
    expect(scoreParts(prompt({}), passing, cube).pass).toBe(true)
  })

  it('a box with no lid has open edges', () => {
    const c = closure([box(0, 0, 0, 20, 20, 20, { open: true })])
    expect(c.watertight).toBe(false)
    expect(c.openEdges).toBe(4)
    expect(scoreParts(prompt({}), passing, [box(0, 0, 0, 20, 20, 20, { open: true })]).watertight?.pass).toBe(false)
  })

  it('a part with one triangle turned the wrong way reads as flipped, not closed', () => {
    const p = box(0, 0, 0, 10, 10, 10)
    const idx = Uint32Array.from(p.indices)
    ;[idx[1], idx[2]] = [idx[2] ?? 0, idx[1] ?? 0]
    expect(closure([{ ...p, indices: idx }])).toMatchObject({ watertight: false, flippedEdges: 3 })
  })

  it('a 0.5 mm plate is thinner than two 0.4 mm lines', () => {
    const plate = [box(0, 0, 0, 40, 40, 0.5)]
    expect(minWall(plate).minWallMm).toBeCloseTo(0.5, 3)
    const s = scoreParts(prompt({}), passing, plate)
    expect(s.minWall).toMatchObject({ pass: false })
    expect(s.pass).toBe(false)
    expect(wallLimitMm(P1S)).toBe(0.8)
  })

  it('a hollow cube is one body, and its wall is the shell between the faces', () => {
    const hollow = [join([box(0, 0, 0, 20, 20, 20), box(2, 2, 2, 18, 18, 18, { inward: true })])]
    expect(closure(hollow).watertight).toBe(true)
    expect(bodyCount(hollow)).toBe(1)
    expect(minWall(hollow).minWallMm).toBeCloseTo(2, 3)
  })

  it('counts separate bodies inside one mesh part', () => {
    expect(bodyCount([join([box(0, 0, 0, 10, 10, 10), box(20, 0, 0, 30, 10, 10), box(40, 0, 0, 50, 10, 10)])])).toBe(3)
    const s = scoreParts(prompt({ bodies: [1, 2] }), passing, [join([box(0, 0, 0, 10, 10, 10), box(20, 0, 0, 30, 10, 10), box(40, 0, 0, 50, 10, 10)])])
    expect(s.bodies).toMatchObject({ pass: false })
  })

  it('bed fit uses the printer catalog volume and allows a quarter turn', () => {
    expect(buildVolumeOf({ printer: 'bambu_a1_mini', material: 'pla', nozzle: 0.4 })).toEqual({ shape: 'rectangular', x: 180, y: 180, z: 180 })
    const bar = [box(0, 0, 0, 200, 10, 10)]
    expect(bedFit(bar, buildVolumeOf({ printer: 'bambu_a1_mini', material: 'pla', nozzle: 0.4 })).fits).toBe(false)
    expect(bedFit(bar, buildVolumeOf(P1S)).fits).toBe(true)
    expect(bedFit([box(0, 0, 0, 10, 240, 10)], { shape: 'rectangular', x: 250, y: 210, z: 220 }).fits).toBe(true)
    expect(bedFit([box(0, 0, 0, 10, 10, 300)], buildVolumeOf(P1S)).fits).toBe(false)
    expect(bedFit([box(0, 0, 0, 100, 100, 10)], { shape: 'circular', diameter: 130, z: 300 }).fits).toBe(false)
  })

  it('every prompt machine has a build volume in the catalog', () => {
    for (const p of CREATIVE_PROMPTS) expect(() => buildVolumeOf(p.machine), p.id).not.toThrow()
  })
})

describe('moving gaps on synthetic gear pairs', () => {
  it('measures the gap the fixture set, to the hundredth', () => {
    expect(movingGaps(gearPair(0.1)).minGapMm).toBeCloseTo(0.1, 2)
    expect(movingGaps(gearPair(0.4)).minGapMm).toBeCloseTo(0.4, 2)
  })

  it('a 0.1 mm gap fuses at 0.4 mm PLA; a 0.4 mm gap turns', () => {
    const mech = prompt({ bodies: [2, 2], mechanism: true })
    const tight = scoreParts(mech, passing, gearPair(0.1))
    expect(tight.clearance).toMatchObject({ pass: false })
    expect(tight.pass).toBe(false)
    const good = scoreParts(mech, passing, gearPair(0.4))
    expect(good.clearance).toMatchObject({ pass: true })
    expect(good.pass).toBe(true)
  })

  it('PETG needs a wider gap than PLA', () => {
    expect(clearanceNeed(P1S, 0.27).moves).toBe(true)
    expect(clearanceNeed({ ...P1S, material: 'petg' }, 0.27).moves).toBe(false)
  })

  it('overlapping bodies have a negative gap', () => {
    const g = movingGaps([box(0, 0, 0, 10, 10, 10), box(9, 0, 0, 19, 10, 10)])
    expect(g.minGapMm).not.toBeNull()
    expect(g.minGapMm!).toBeLessThan(0)
  })

  it('bodies far apart are not a joint, so a mechanism with nothing facing fails', () => {
    expect(movingGaps([box(0, 0, 0, 10, 10, 10), box(30, 0, 0, 40, 10, 10)])).toEqual({ pairs: 0, minGapMm: null })
    expect(scoreParts(prompt({ bodies: [2, 2], mechanism: true }), passing, [box(0, 0, 0, 10, 10, 10), box(30, 0, 0, 40, 10, 10)]).clearance?.pass).toBe(false)
  })
})

describe('the creative prompt set', () => {
  it('has about 20 prompts with unique ids and sane body ranges', () => {
    expect(CREATIVE_PROMPTS.length).toBeGreaterThanOrEqual(18)
    expect(new Set(CREATIVE_PROMPTS.map((p) => p.id)).size).toBe(CREATIVE_PROMPTS.length)
    for (const id of ['flexi-dragon', 'articulated-lizard', 'fidget-spinner', 'infinity-cube', 'hinge-box', 'gear-pair', 'planetary-gear', 'taco', 'mushroom', 'knit-vase', 'ship-hull', 'cable-organizer', 'phone-stand']) {
      expect(CREATIVE_PROMPTS.map((p) => p.id)).toContain(id)
    }
    for (const p of CREATIVE_PROMPTS) {
      expect(p.bodies[0], p.id).toBeGreaterThanOrEqual(1)
      expect(p.bodies[1], p.id).toBeGreaterThanOrEqual(p.bodies[0])
      if (p.mechanism) expect(p.bodies[1], p.id).toBeGreaterThanOrEqual(2)
    }
  })

  it('has one recording file per prompt, and each reads as captured or waiting', () => {
    const files = readdirSync(RECORDINGS_DIR).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort()
    expect(files).toEqual(CREATIVE_PROMPTS.map((p) => p.id).sort())
    for (const p of CREATIVE_PROMPTS) expect(['to-capture', 'recorded']).toContain(loadRecording(p.id).status)
  })

  it('refuses a recorded reply with no model, provider or capture time', () => {
    expect(() => parseRecording(JSON.stringify({ status: 'recorded', steps: [{ text: 'hi' }] }))).toThrow(/needs model/)
    expect(() => parseRecording(JSON.stringify({ status: 'recorded', model: 'm', provider: 'p', capturedAt: '2026-11-07T00:00:00Z', steps: [] }))).toThrow(/at least one step/)
    expect(parseRecording('{ "status": "to-capture" }')).toEqual({ status: 'to-capture' })
  })

  it('a run with no design tool call does not parse', async () => {
    const p = CREATIVE_PROMPTS[0]!
    const run = await runPrompt(p, { geom: undefined, steps: [{ text: 'Here is a dragon.' }] })
    expect(run.parsed).toEqual({ pass: false, detail: 'no design tool was called: none' })
    expect(scoreParts(p, run.parsed, run.parts)).toEqual({ parses: run.parsed, pass: false })
  })

  it('a design call without a geometry engine is reported in the tool\'s words', async () => {
    const p = CREATIVE_PROMPTS.find((x) => x.id === 'cable-organizer')!
    const run = await runPrompt(p, { geom: undefined, steps: [{ calls: [{ name: 'make_model', args: { name: 'Cable organizer', parts: [{ kind: 'box', name: 'base', sizeMm: [100, 30, 20] }] } }] }, { text: 'Done.' }] })
    expect(run.calls).toContain('make_model')
    expect(run.parsed.pass).toBe(false)
    expect(run.parsed.detail).toMatch(/^make_model: /)
  })
})
