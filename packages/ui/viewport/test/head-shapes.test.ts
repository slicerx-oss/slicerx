// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// heimdall's collision check (packages/core/src/collide.rs) tests the same heads, racks and docks Preview draws. This
// builds data/head-shapes.json from them: every head as boxes around its active nozzle, and every tool change as the
// stops changeSequence makes. The engine reads the file at build time, so the drawing stays the one source.
// SX_WRITE_HEAD_SHAPES=1 rewrites it; otherwise the test fails when the file is stale.
import { describe, expect, it } from 'vitest'
import { Box3, type Mesh, type Object3D } from 'three'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { changeSequence, toolChangerSpec, type ToolChangerSpec } from '../src/toolchanger'
import { ToolheadRig } from '../src/toolhead'
import { HEAD_MODELS, headFor } from '../src/heads'

type Settings = Record<string, unknown>
/** x0, x1, y0, y1, z0, z1 around the nozzle tip, mm: each box from its underside z0 to its top z1. */
type Column = [number, number, number, number, number, number]

/**
 * Heads drawn from product photos alone, not measured (docs/toolchanger-sim.md, "A1 head sources"): heimdall gets
 * only their nozzle, up to the profile's `nozzle_height` (4.76 mm on the A1 and A1 mini, Bambu Studio's machine
 * profiles), so a guessed body never blocks a print. The profile's clearance radius still warns around them, and the
 * gantry and lid rules still hold.
 */
const ESTIMATED = new Map([['bambu-a1', 4.76]])

const OUT = fileURLToPath(new URL('../data/head-shapes.json', import.meta.url))
const profiles = (path: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../../profiles/${path}`, import.meta.url)), 'utf8')) as { models: Record<string, { machine: Settings }> }

const up = (v: number) => Math.ceil(v * 10 - 1e-6) / 10
const down = (v: number) => Math.floor(v * 10 + 1e-6) / 10

/**
 * The head's solid parts as columns: decals skipped, parts that stand inside another's column dropped. The A1's cable
 * chain is left out: it bends away from what it meets, and its shape is estimated.
 */
function columns(rig: ToolheadRig): Column[] {
  rig.root.updateMatrixWorld(true)
  const head = rig.root.getObjectByName('nozzle')!
  const shown = (o: Object3D) => {
    for (let p: Object3D | null = o; p && p !== rig.root; p = p.parent) if (!p.visible) return false
    return true
  }
  const all: Column[] = []
  head.traverse((o) => {
    const m = o as Mesh
    if (!m.isMesh || !m.name || m.name === 'shadow' || m.name === 'cable chain' || !shown(m)) return
    const b = new Box3().setFromObject(m)
    all.push([down(b.min.x), up(b.max.x), down(b.min.y), up(b.max.y), down(b.min.z - 0.05), up(b.max.z)])
  })
  const inside = (a: Column, b: Column) => a[0] >= b[0] - 0.5 && a[1] <= b[1] + 0.5 && a[2] >= b[2] - 0.5 && a[3] <= b[3] + 0.5 && a[4] >= b[4] - 0.01 && a[5] <= b[5] + 0.01
  const kept = all.filter((a, i) => !all.some((b, j) => j !== i && inside(a, b) && (!inside(b, a) || j < i)))
  return kept.sort((a, b) => a[4] - b[4] || a[0] - b[0] || a[2] - b[2])
}

function bedOf(machine: Settings): { widthMm: number; depthMm: number; heightMm: number } {
  const pts = (Array.isArray(machine['printable_area']) ? machine['printable_area'] : []).map((p) => String(p).split('x').map(Number))
  return { widthMm: Math.max(...pts.map((p) => p[0] ?? 0)), depthMm: Math.max(...pts.map((p) => p[1] ?? 0)), heightMm: Number(machine['printable_height']) || 250 }
}

/** The stops of every change between two tools, without the lift at the start and the return at the end. */
function routes(spec: ToolChangerSpec): Record<string, [number, number, number, number][]> {
  const out: Record<string, [number, number, number, number][]> = {}
  const tools = spec.kind === 'filament-swap' || spec.kind === 'dual-nozzle' ? 2 : spec.tools
  const at: [number, number, number] = [spec.bed.widthMm / 2, spec.bed.depthMm / 2, 10]
  for (let from = 0; from < tools; from++)
    for (let to = 0; to < tools; to++) {
      if (from === to) continue
      const seq = changeSequence(spec, from, to, at, at, 20)
      const phases = seq.phases.filter((p) => p.move > 0)
      if (phases[0]?.name === 'lift') phases.shift()
      while (phases.length && ['return', 'lower'].includes(phases[phases.length - 1]!.name)) phases.pop()
      // Stops at the rack, dock or switch bay are the station; the moves between are the trip there and back.
      const station = new Set(['dock', 'seat', 'push in', 'release', 'back out', 'grab', 'settle', 'pull out', 'unlatch', 'leave', 'engage', 'to slot', 'along', 'approach', 'unlock', 'park', 'pull back', 'insert', 'lock', 'clear', 'extract', 'into bay', 'switch', 'out of bay'])
      const stops: [number, number, number, number][] = phases.map((p) => [Math.round(p.to[0] * 10) / 10, Math.round(p.to[1] * 10) / 10, Math.round((p.to[2] - at[2]) * 100) / 100, station.has(p.name) ? 1 : 0])
      // A change that goes the same way whichever tools it swaps is kept once, as 0-1.
      if (from > 0 || to > 1) if (JSON.stringify(stops) === JSON.stringify(out['0-1'])) continue
      out[`${from}-${to}`] = stops
    }
  return out
}

/** Keeps one copy of each value under the first key it was given, and returns that key. */
function pool<T>(into: Record<string, T>): (key: string, value: T) => string {
  const seen = new Map<string, string>()
  return (key, value) => {
    const text = JSON.stringify(value)
    const had = seen.get(text)
    if (had) return had
    seen.set(text, key)
    into[key] = value
    return key
  }
}

type Changer = { kind: string; liftMm: number; routes: Record<string, [number, number, number, number][]> }

/** The file's contents from the drawing and the profiles. */
function build() {
  const machine = profiles('machine.json').models
  const heads: Record<string, Column[]> = {}
  const changers: Record<string, Changer> = {}
  const head = pool(heads)
  const changer = pool(changers)
  const family = new Map<string, string>()
  for (const model of HEAD_MODELS) {
    const rig = new ToolheadRig()
    rig.setModel(model)
    rig.place(0, 0, 0, 0, null, null)
    const cols = columns(rig)
    const nozzleTop = ESTIMATED.get(model)
    family.set(model, head(model, nozzleTop === undefined ? cols : cols.filter((c) => c[4] < 0.5).map((c): Column => [c[0], c[1], c[2], c[3], c[4], nozzleTop])))
  }
  const single = (id: string) => family.get(headFor(id)) ?? 'generic'
  const printers: Record<string, { heads: string[]; changer?: string }> = {}
  for (const [id, m] of Object.entries(machine)) {
    const nozzles = Array.isArray(m.machine['nozzle_diameter']) ? m.machine['nozzle_diameter'].length : 1
    const rack = Array.isArray(m.machine['extruder_max_nozzle_count']) && m.machine['extruder_max_nozzle_count'].some((n) => Number(n) > 1)
    const tools = rack ? 6 : Math.max(2, nozzles)
    // Every extruder prints a tool of its own (the rack's the rest), so each one's head is drawn.
    const s = nozzles > 1 ? { ...m.machine, filament_map: Array.from({ length: tools }, (_, i) => String(Math.min(i, nozzles - 1) + 1)) } : m.machine
    const spec = toolChangerSpec(id, s, bedOf(s), tools)
    // Preview draws the H2D's head for every printer with two nozzles; the others (Snapmaker J1 and Artisan) carry two
    // heads side by side, each the family's own, and park them at the sides rather than at a chute.
    if (spec?.kind === 'dual-nozzle' && !id.startsWith('bambu-')) {
      printers[id] = { heads: Array.from({ length: nozzles }, () => single(id)) }
      continue
    }
    const ch = spec ? { changer: changer(id, { kind: spec.kind, liftMm: spec.liftMm, routes: routes(spec) }) } : {}
    if (!spec || spec.kind === 'filament-swap') {
      printers[id] = { heads: [single(id)], ...ch }
      continue
    }
    const keys: string[] = []
    for (let e = 0; e < nozzles; e++) {
      const rig = new ToolheadRig()
      rig.setSpec(spec)
      rig.place(0, 0, 0, Math.max(0, spec.extruderOf.indexOf(e)), null, null)
      keys.push(head(`${id}:${e}`, columns(rig)))
    }
    printers[id] = { heads: keys, ...ch }
  }
  // printer_model as the profiles name it, for requests that do not say which profile they were sliced for.
  const models: Record<string, string> = {}
  for (const file of ['bambu-lab', 'creality', 'elegoo', 'prusa', 'qidi', 'snapmaker', 'sovol', 'voron']) {
    for (const [id, m] of Object.entries(profiles(`resolved/${file}.json`).models)) {
      const name = m.machine?.['printer_model']
      if (typeof name === 'string' && name && printers[id]) models[name] = id
    }
  }
  return {
    estimated: [...ESTIMATED.keys()].filter((k) => k in heads).sort(),
    comment: 'Generated by packages/ui/viewport/test/head-shapes.test.ts from the heads Preview draws (heads.ts, toolhead.ts) and toolchanger.ts. Do not edit by hand: SX_WRITE_HEAD_SHAPES=1 rewrites it.',
    heads,
    changers,
    printers,
    models: Object.fromEntries(Object.entries(models).sort(([a], [b]) => a.localeCompare(b))),
  }
}

describe('head-shapes.json', () => {
  it('matches the heads, racks and docks Preview draws', () => {
    const text = JSON.stringify(build()) + '\n'
    if (process.env['SX_WRITE_HEAD_SHAPES'] === '1') writeFileSync(OUT, text)
    expect(readFileSync(OUT, 'utf8')).toBe(text)
  })

  it('gives every head a nozzle column at the tip and a body above it', () => {
    const { heads } = build()
    for (const [key, cols] of Object.entries(heads)) {
      expect(cols.length, key).toBeGreaterThan(ESTIMATED.has(key) ? 0 : 1)
      expect(cols.some((c) => c[4] <= 0.01 && c[0] <= 0 && c[1] >= 0 && c[2] <= 0 && c[3] >= 0), key).toBe(true)
      // every box has a top above its underside
      expect(cols.every((c) => c[5] > c[4]), key).toBe(true)
      if (ESTIMATED.has(key)) expect(cols).toEqual([[-1.6, 1.6, -1.6, 1.6, 0, ESTIMATED.get(key)]])
      else expect(Math.max(...cols.map((c) => c[1] - c[0])), key).toBeGreaterThan(20)
    }
  })
})
