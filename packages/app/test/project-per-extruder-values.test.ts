// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A project saved for a printer with two extruders keeps an object's own speeds as one value per extruder ("50,nil":
// 50 mm/s on the first, the second left to the profile). The app opens such a project and slices it through its own
// slice path on the real engine: the object's speeds go to sx as the file has them, and sx prints them on the first
// extruder's 50 mm/s instead of refusing the request. Runs where sx (cargo build -p sx-cli --release) is built.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { Host, MeshHandle, SliceRequest } from '@slicerx/contracts'
import { zip } from '../src/export/zip'
import { objectOverrides } from '../src/plate/object-settings'
import { openModelBytes, slicePlate } from '../src/state/actions'
import { profileReady } from '../src/state/profile-sync'
import { get, set } from '../src/state/store'

const sxBin = process.env['SLICERX_TEST_SX_BIN'] ?? resolve(__dirname, '../../../target/release/sx')
const dir = mkdtempSync(join(tmpdir(), 'project-per-extruder-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [60, 60, 6], openEdges: 0, parts: [] })
const buf = (b: Uint8Array): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer

// A 60 x 60 x 6 mm box centered on its origin, big enough that no layer slows down for cooling.
const LO = [-30, -30, 0]
const HI = [30, 30, 6]
const VERTS = Array.from({ length: 8 }, (_, i) => [i & 1 ? HI[0]! : LO[0]!, i & 2 ? HI[1]! : LO[1]!, i & 4 ? HI[2]! : LO[2]!])
const TRIS = [[0, 2, 1], [1, 2, 3], [4, 5, 6], [5, 7, 6], [0, 1, 4], [1, 5, 4], [2, 6, 3], [3, 6, 7], [0, 4, 2], [2, 4, 6], [1, 3, 5], [3, 7, 5]]

/** The box as an ASCII STL, the mesh the engine slices for the app's handle. */
function boxStl(): string {
  const facets = TRIS.map((t) => `facet normal 0 0 0\nouter loop\n${t.map((i) => `vertex ${VERTS[i]!.join(' ')}`).join('\n')}\nendloop\nendfacet`)
  return `solid box\n${facets.join('\n')}\nendsolid box\n`
}

const md = (k: string, v: string) => `<metadata key="${k}" value="${v}"/>`

/** The six speeds a two-extruder project keeps per object, as the first extruder's value and nil for the second. */
const PER_EXTRUDER = ['inner_wall_speed', 'top_surface_speed', 'sparse_infill_speed', 'internal_solid_infill_speed', 'gap_infill_speed', 'support_speed']

/** A Bambu Studio project for the P1S: the box, with the six speeds as its own settings ("50,nil"). */
function project(): ArrayBuffer {
  const mesh = `<mesh><vertices>${VERTS.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('')}</vertices><triangles>${TRIS.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('')}</triangles></mesh>`
  const model = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><metadata name="Application">BambuStudio-02.08.04.61</metadata><resources><object id="1" type="model">${mesh}</object></resources><build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 128 128 0"/></build></model>`
  const cfg = `<?xml version="1.0" encoding="UTF-8"?><config><object id="1">${md('name', 'body')}${md('extruder', '1')}${PER_EXTRUDER.map((k) => md(k, '50,nil')).join('')}</object><plate>${md('plater_id', '1')}<model_instance>${md('object_id', '1')}</model_instance></plate></config>`
  const settings = { printer_settings_id: 'Bambu Lab P1S 0.4 nozzle', printer_model: 'Bambu Lab P1S', nozzle_diameter: ['0.4'], layer_height: '0.2', initial_layer_print_height: '0.2' }
  return buf(zip([{ name: '3D/3dmodel.model', data: model }, { name: 'Metadata/model_settings.config', data: cfg }, { name: 'Metadata/project_settings.config', data: JSON.stringify(settings) }]))
}

/** The feed rates (mm/min) of the inner wall extrusions above the first layer. */
function innerWallFeeds(gcode: string): number[] {
  let here = false
  let layer = 0
  let feed = 0
  const out: number[] = []
  for (const l of gcode.split('\n')) {
    if (l.startsWith(';LAYER_CHANGE') || l.startsWith('; CHANGE_LAYER')) layer++
    else if (l.startsWith('; FEATURE: ') || l.startsWith(';TYPE:')) here = l.replace(/^; FEATURE: |^;TYPE:/, '').trim() === 'Inner wall'
    else if (/^G[123] /.test(l)) {
      const f = /\bF([\d.]+)/.exec(l)
      if (f) feed = Number(f[1])
      if (here && layer > 1 && / E/.test(l) && /[XY]/.test(l)) out.push(feed)
    }
  }
  return out
}

beforeEach(async () => {
  set((s) => ({ plate: [], plates: [{ ...s.plates[0]!, id: 'plate-1', name: 'Plate 1', objects: [], settings: {} }], activePlate: 'plate-1', objectSettings: {}, overrides: {}, projectSettings: null, projectPrinter: null, projectOpenAsk: null, slice: { status: 'idle' }, toast: null, unsavedPrompt: null }))
  await profileReady()
})

describe.skipIf(!existsSync(sxBin))("a project object's per-extruder speeds", () => {
  it('slice on the real engine with the first extruder value, nothing dropped', async () => {
    const stl = join(dir, 'box.stl')
    writeFileSync(stl, boxStl())
    const runs: { request: SliceRequest; status: number | null; stderr: string; gcode: string }[] = []
    // The app's slice goes to sx as a request file, the meshes it names being the box. A refusal comes back as the
    // engine's message, as the desktop host passes it on; a slice that went through ends the run here.
    const slice = async (r: SliceRequest) => {
      const out = join(dir, `run-${runs.length}`)
      const path = join(dir, `request-${runs.length}.json`)
      const meshes = Object.fromEntries(r.plate.objects.map((o) => [String(o.mesh), stl]))
      writeFileSync(path, JSON.stringify({ schemaVersion: 1, ...r, meshes }))
      const p = spawnSync(sxBin, ['slice', '--request', path, '--out-dir', out], { encoding: 'utf8' })
      const gcode = p.status === 0 ? readFileSync(join(out, 'slice.gcode'), 'utf8') : ''
      runs.push({ request: r, status: p.status, stderr: p.stderr, gcode })
      throw new Error(p.status === 0 ? 'stop' : (p.stderr.trim().split('\n').pop() ?? 'failed'))
    }
    const host = { kind: 'web', capabilities: { threads: 1 }, slicer: { slice, loadParts: async (name: string) => handle(name) } } as unknown as Host
    await openModelBytes(host, 'two-extruders.3mf', project(), undefined, { fresh: true })
    const body = () => get().plate.find((e) => e.name === 'body')!
    // The object brings its six speeds.
    expect(Object.keys(objectOverrides(get(), body())).filter((k) => PER_EXTRUDER.includes(k)).sort()).toEqual([...PER_EXTRUDER].sort())
    await slicePlate(host, { auto: true })
    // One request, sliced: no exit code 3, no setting dropped for a retry.
    expect(runs.map((r) => [r.status, r.stderr.includes('unexpected value')])).toEqual([[0, false]])
    expect(get().toast?.text ?? '').not.toMatch(/Setting not imported/)
    expect(Object.keys(objectOverrides(get(), body())).filter((k) => PER_EXTRUDER.includes(k)).sort()).toEqual([...PER_EXTRUDER].sort())
    // The box's inner walls print at 50 mm/s.
    const feeds = innerWallFeeds(runs[0]!.gcode)
    expect(feeds.length).toBeGreaterThan(0)
    expect(Math.max(...feeds)).toBe(3000)
  }, 120_000)
})
