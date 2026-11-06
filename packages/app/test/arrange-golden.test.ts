// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The app's Arrange lands on the engine's layouts (packages/settings/fixtures/arrange-golden.json, written by
// packages/core/tests/arrange_golden.rs from the engine's arrange, the call sx arrange --request and the MCP server's
// slicerx_arrange_file make). Where the host has the engine's arrange (the desktop), Arrange sends the plate to it as
// the golden file's request and takes its layout as it comes: the host here answers with the file's layout, or with
// the real sx when SX_CLI_BIN names it. Where it has none (the CAD-only studio), Arrange nests in the geometry worker:
// on the same plates it fits the same objects clear of the same zones. Runs the real geometry engine when it is built,
// else replies recorded from it.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MeshHandle, MeshPart, PlateArrangement, SettingValue, SliceRequest, SlicerHost } from '@slicerx/contracts'
import { readPlateArrangement } from '@slicerx/contracts'
import { keepOutBoxes } from '@slicerx/settings/arrange-room'
import { setAvoidAreas } from '../src/plate/arrange'
import { areaOrigin } from '../src/plate/bed-origin'
import { arrangePlate, setArrangeOptions } from '../src/plate/edit'
import { setArrangeEngine } from '../src/plate/engine-arrange'
import { encodePaintedParts } from '../src/plate/raw-parts'
import { installPrintMargins } from '../src/plate/footprint'
import { history } from '../src/plate/history'
import { get, set, type PlateEntry } from '../src/state/store'
import { useGeomEngine } from './geom-engine'

vi.mock('../src/state/profile-sync', async (load) => ({ ...(await load<typeof import('../src/state/profile-sync')>()), profileReady: async () => {} }))

useGeomEngine('arrange-golden-web')

interface GoldenObject {
  id: string
  name: string
  mesh: string
  transform: number[]
  slotOverrides?: Record<string, number>
}

interface GoldenCase {
  name: string
  request: { plate: { bed: { widthMm: number; depthMm: number; heightMm: number; round?: boolean }; arrange: Record<string, unknown>; objects: GoldenObject[] }; config: Record<string, SettingValue> }
  layout: PlateArrangement & { sureStrikes?: number }
}

const golden = JSON.parse(readFileSync(join(__dirname, '..', '..', 'settings', 'fixtures', 'arrange-golden.json'), 'utf8')) as { meshes: Record<string, { positions: number[]; indices: number[] }>; cases: GoldenCase[] }
/** Where the case's printable area starts on the machine: the plate counts from there. */
const originOf = (c: GoldenCase) => areaOrigin(c.request.config['printable_area'])
/** A machine transform on the case's plate, or back. */
const shift = (t: readonly number[], o: readonly [number, number], k: number) => t.map((v, i) => (i === 12 ? v + k * o[0] : i === 13 ? v + k * o[1] : v))
const sx = process.env['SX_CLI_BIN']

const slotOf = (o: GoldenObject) => o.slotOverrides?.[o.mesh] ?? 1

function partOf(mesh: string, slot: number): MeshPart {
  const m = golden.meshes[mesh]!
  return { name: mesh, slot, positions: new Float32Array(m.positions), indices: new Uint32Array(m.indices) }
}

/** The case's plate as the app holds it: each object's mesh, its slot and its transform on the plate. */
function entries(c: GoldenCase): PlateEntry[] {
  const origin = originOf(c)
  return c.request.plate.objects.map((o) => {
    const part = partOf(o.mesh, slotOf(o))
    const id = `${o.mesh}-${slotOf(o)}`
    const handle = { id, hash: id, name: o.mesh, triangles: part.indices.length / 3, bboxMm: [0, 0, 0], openEdges: 0, parts: [{ name: o.mesh, slot: part.slot, triangles: part.indices.length / 3 }] } as MeshHandle
    return { id: o.id, name: o.name, handle, parts: [part], colors: ['#bd93f9', '#50fa7b'], transform: shift(o.transform, origin, -1) }
  })
}

function load(c: GoldenCase): void {
  const byObject = c.request.config['print_sequence'] === 'by object'
  set({
    bed: c.request.plate.bed,
    plates: [{ id: 'p1', name: 'Plate 1', objects: [], settings: { sequence: byObject ? 'by-object' : 'by-layer' } }] as never,
    activePlate: 'p1',
    plate: entries(c),
    overrides: { ...c.request.config },
    profile: { printerId: 'bambu-a1' } as never,
    selection: null,
    selectedIds: [],
    toast: null,
    calibration: {},
    layerMarks: {},
    slice: { status: 'idle' },
  })
  history().clear()
}

/** The app's arrange options for the case's `plate.arrange`, and the ids it keeps (selected are the others). */
function optionsOf(c: GoldenCase) {
  const a = c.request.plate.arrange as { spacingMm?: number; rotate?: boolean; stepDeg?: number; effort?: 'quick' | 'normal' | 'thorough'; keep?: string[] }
  return { opts: { gapMm: a.spacingMm ?? 6, rotate: a.rotate ?? true, stepDeg: a.stepDeg ?? 10, effort: a.effort ?? 'normal' }, keep: a.keep ?? [] }
}

/** The spec with the engine's defaults filled in, so the app's and the file's compare as the engine reads them. */
const specOf = (a: Record<string, unknown> | undefined) => ({ spacingMm: 6, rotate: true, stepDeg: 10, effort: 'normal', keep: [], ...(a ?? {}) })

/** Runs `sx arrange --request` on a request the app made, with its meshes written out as the desktop holds them. */
function sxArrange(req: SliceRequest, meshes: Map<string, MeshPart[]>): PlateArrangement {
  const dir = mkdtempSync(join(tmpdir(), 'sx-arrange-golden-'))
  try {
    const paths: Record<string, string> = {}
    for (const o of req.plate.objects) {
      const path = join(dir, `${o.mesh}.sxmp`)
      writeFileSync(path, encodePaintedParts(meshes.get(o.mesh)!))
      paths[o.mesh] = path
    }
    const file = join(dir, 'request.json')
    writeFileSync(file, JSON.stringify({ ...req, meshes: paths, options: { ...req.options, configReport: false } }))
    let out: string
    try {
      out = execFileSync(sx!, ['arrange', '--request', file], { encoding: 'utf8' })
    } catch (e) {
      // exit code 3: some objects have no room; the layout is still printed
      out = String((e as { stdout?: string }).stdout ?? '')
    }
    return readPlateArrangement(JSON.parse(out))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Every object on every plate, the shown plate's from `plate`. */
const allObjects = () => get().plates.flatMap((p) => (p.id === get().activePlate ? get().plate : p.objects))

/** The new transforms of the case's objects on the plate, by id, to a thousandth. */
function laidOut(c: GoldenCase): Record<string, number[]> {
  const origin = originOf(c)
  const now = new Map(get().plate.map((p) => [p.id, shift(p.transform, origin, 1)]))
  return Object.fromEntries(c.request.plate.objects.map((o) => [o.id, (now.get(o.id) ?? []).map((v) => Math.round(v * 1000) / 1000)]))
}

/** The file's layout as transforms by id: the placed objects' new ones, the others where they were. */
function expected(c: GoldenCase): Record<string, number[]> {
  const placed = new Map(c.layout.objects.map((o) => [o.id, o.transform]))
  return Object.fromEntries(c.request.plate.objects.map((o) => [o.id, (placed.get(o.id) ?? o.transform).map((v) => Math.round(v * 1000) / 1000)]))
}

function expectSameLayout(c: GoldenCase, tol = 2e-3): void {
  const got = laidOut(c)
  const want = expected(c)
  for (const id of Object.keys(want)) {
    const g = got[id]!
    const w = want[id]!
    const off = Math.max(...w.map((v, i) => Math.abs(v - (g[i] ?? NaN))))
    expect(off, `${c.name}: ${id} at ${JSON.stringify(g)}, the engine put it at ${JSON.stringify(w)}`).toBeLessThanOrEqual(tol)
  }
}

beforeAll(async () => void (await Promise.all([import('../src/state/slice-plate'), import('../src/plate/layer-ranges'), import('../src/plate/layer-marks'), import('../src/plate/engine-check'), import('../src/plate/engine-arrange')])))

describe('Arrange in the engine sends the golden plate and lands on its layout', () => {
  let stop: (() => void) | null = null
  afterEach(() => {
    stop?.()
    stop = null
  })

  for (const c of golden.cases) {
    it(c.name, { timeout: 60_000 }, async () => {
      load(c)
      const { opts, keep } = optionsOf(c)
      const asked: SliceRequest[] = []
      const meshes = new Map(get().plate.map((p) => [p.handle.id, p.parts as MeshPart[]]))
      const arrangePlateCall = vi.fn(async (req: SliceRequest): Promise<PlateArrangement> => {
        asked.push(req)
        if (sx) return sxArrange(req, meshes)
        // The file holds the layout of the plate, its new plates included.
        return readPlateArrangement(c.layout)
      })
      const slicer = { loadModel: async () => ({}), loadParts: async () => ({}), arrangePlate: arrangePlateCall } as unknown as SlicerHost
      stop = setArrangeEngine(slicer)
      if (keep.length) set({ selection: get().plate.find((p) => !keep.includes(p.id))!.id, selectedIds: get().plate.filter((p) => !keep.includes(p.id)).map((p) => p.id) })
      await arrangePlate(keep.length ? 'selection' : 'all', opts)
      // The plate goes to the engine once, as the golden request: the same objects, transforms, settings and ask.
      expect(asked).toHaveLength(1)
      const req = asked[0]!
      expect(req.plate.placement).toBe('arrange')
      expect(specOf(req.plate.arrange as Record<string, unknown>)).toEqual(specOf(c.request.plate.arrange))
      expect(req.plate.objects.map((o) => o.id)).toEqual(c.request.plate.objects.map((o) => o.id))
      for (const [i, o] of req.plate.objects.entries()) {
        const g = c.request.plate.objects[i]!
        expect(o.transform.map((v) => Math.round(v * 1e5) / 1e5)).toEqual(g.transform.map((v) => Math.round(v * 1e5) / 1e5))
        expect(meshes.get(o.mesh)?.[0]?.slot ?? 1).toBe(slotOf(g))
        expect(meshes.get(o.mesh)?.[0]?.name).toBe(g.mesh)
      }
      // The filament settings are the app's own slots'; the arrange reads only how many filaments the plate prints.
      for (const [k, v] of Object.entries(c.request.config)) if (!k.startsWith('filament_')) expect(req.config[k as keyof typeof req.config], k).toEqual(v)
      // The plate ends up where the engine put it. An object with no room goes to a new plate (the real engine lays
      // those out too) or, when no new plate holds it, stays where it was; one larger than the bed stays.
      const shown = { ...c, request: { ...c.request, plate: { ...c.request.plate, objects: c.request.plate.objects.filter((o) => !c.layout.notFit.some((n) => n.id === o.id && n.reason === 'no_room')) } } }
      expectSameLayout(shown)
      // Printing by object the plate takes the print order the engine's layout takes, when it gives one.
      if (c.layout.order?.length) expect(get().plate.map((p) => p.id).filter((id) => c.layout.order!.includes(id))).toEqual(c.layout.order)
      // The objects with no room land on new plates where the engine laid them out, plate by plate.
      const origin = originOf(c)
      for (const [k, p] of (c.layout.plates ?? []).entries()) {
        const on = new Map(((get().plates[k + 1]?.objects ?? []) as PlateEntry[]).map((e) => [e.id, shift(e.transform, origin, 1)]))
        for (const o of p.objects) {
          const g = on.get(o.id)
          expect(g, `${c.name}: ${o.id} on plate ${k + 2}`).toBeDefined()
          const off = Math.max(...o.transform.map((v, i) => Math.abs(Math.round(v * 1000) / 1000 - (g![i] ?? NaN))))
          expect(off, `${c.name}: ${o.id} on plate ${k + 2}`).toBeLessThanOrEqual(2e-3)
        }
      }
      const every = allObjects()
      expect(every.map((p) => p.id).sort()).toEqual(c.request.plate.objects.map((o) => o.id).sort())
      const moved = new Set((c.layout.plates ?? []).flatMap((p) => p.objects.map((o) => o.id)))
      for (const n of c.layout.notFit) expect(get().plate.some((p) => p.id === n.id)).toBe(!moved.has(n.id))
    })
  }
})

/** The box an entry covers on the bed. */
function boxOf(e: PlateEntry): [number, number, number, number] {
  const t = e.transform
  const p = e.parts[0]!.positions
  let b: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity]
  for (let k = 0; k + 2 < p.length; k += 3) {
    const x = t[0]! * p[k]! + t[4]! * p[k + 1]! + t[8]! * p[k + 2]! + t[12]!
    const y = t[1]! * p[k]! + t[5]! * p[k + 1]! + t[9]! * p[k + 2]! + t[13]!
    b = [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)]
  }
  return b
}

// The CAD-only studio has no engine and never slices, so its Arrange nests in the geometry worker. It does not hold the
// engine's layouts (the engine spaces a by-object plate again until heimdall's check is clear, and the browser has no
// heimdall), but on the golden plates it loses no object, keeps the ones asked to stay where they are and the ones
// larger than the bed where they were, and keeps every other one on the bed and out of the printer's keep-out zones.
describe('Arrange in the geometry worker, without the engine, keeps the golden plates on the bed and clear of the zones', () => {
  for (const c of golden.cases) {
    it(c.name, { timeout: 120_000 }, async () => {
      load(c)
      installPrintMargins(get)
      const zones = keepOutBoxes(c.request.config)
      setAvoidAreas(zones)
      const { opts, keep } = optionsOf(c)
      setArrangeOptions(opts)
      const before = new Map(get().plate.map((p) => [p.id, [...p.transform]]))
      if (keep.length) set({ selection: get().plate.find((p) => !keep.includes(p.id))!.id, selectedIds: get().plate.filter((p) => !keep.includes(p.id)).map((p) => p.id) })
      await arrangePlate(keep.length ? 'selection' : 'all', opts)
      expect(allObjects().map((p) => p.id).sort()).toEqual(c.request.plate.objects.map((o) => o.id).sort())
      for (const id of keep) expect(get().plate.find((p) => p.id === id)!.transform).toEqual(before.get(id))
      const tooLarge = new Set(c.layout.notFit.filter((n) => n.reason === 'too_large').map((n) => n.id))
      for (const id of tooLarge) expect(get().plate.find((p) => p.id === id)!.transform).toEqual(before.get(id))
      for (const e of allObjects().filter((p) => !tooLarge.has(p.id))) {
        const [x0, y0, x1, y1] = boxOf(e)
        expect(x0, e.id).toBeGreaterThanOrEqual(-1e-3)
        expect(y0, e.id).toBeGreaterThanOrEqual(-1e-3)
        expect(x1, e.id).toBeLessThanOrEqual(c.request.plate.bed.widthMm + 1e-3)
        expect(y1, e.id).toBeLessThanOrEqual(c.request.plate.bed.depthMm + 1e-3)
        for (const z of zones) expect(x1 <= z.x || x0 >= z.x + z.w || y1 <= z.y || y0 >= z.y + z.h, `${e.id} is clear of the zone at ${z.x}, ${z.y}`).toBe(true)
      }
    })
  }
})
