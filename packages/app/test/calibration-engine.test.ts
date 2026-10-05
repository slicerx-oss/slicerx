// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The new spool plate through the real engine: sx-geom builds the three models, sx slices the plate by object,
// and the G-code shows each object with its own flow, the tower with its own pressure advance and the
// temperature tower with its own temperatures, with the engine's by-object clearance check passing.
// Skipped unless SX_BIN and SX_GEOM_BIN name built binaries (cargo build -p sx-cli -p sx-geom).
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { defaultValues } from '../src/calibration/actions'
import { addCombinedPlate, combinedValues } from '../src/calibration/combined'
import { setGeomProvider } from '../src/geom/client'
import { get, set } from '../src/state/store'

const sx = process.env['SX_BIN'] ?? ''
const geomBin = process.env['SX_GEOM_BIN'] ?? ''
const built = sx !== '' && geomBin !== '' && existsSync(sx) && existsSync(geomBin)
const dir = built ? mkdtempSync(join(tmpdir(), 'app6-calib-')) : ''
afterAll(() => dir && rmSync(dir, { recursive: true, force: true }))

beforeEach(() => {
  set({ plate: [], plates: [{ id: 'plate-1', name: 'Plate 1', objects: [], settings: { sequence: 'by-layer' } }], activePlate: 'plate-1', overrides: {}, objectSettings: {}, calibration: {}, slice: { status: 'idle' } })
})

function stl(p: MeshPart): Buffer {
  const n = p.indices.length / 3
  const b = Buffer.alloc(84 + n * 50)
  b.writeUInt32LE(n, 80)
  for (let t = 0; t < n; t++) {
    const o = 84 + t * 50
    for (let v = 0; v < 3; v++) for (let c = 0; c < 3; c++) b.writeFloatLE(p.positions[p.indices[t * 3 + v]! * 3 + c]!, o + 12 + v * 12 + c * 4)
  }
  return b
}

describe.skipIf(!built)('new spool plate, real engine', () => {
  it('slices by object with each object keeping its own flow, pressure advance and temperature', async () => {
    setGeomProvider({ call: async (op, request) => JSON.parse(execFileSync(geomBin, [op], { input: JSON.stringify(request), maxBuffer: 1 << 28 }).toString()) })
    const parts = new Map<string, MeshPart>()
    const loader = {
      loadParts: async (name: string, ps: MeshPart[]): Promise<MeshHandle> => {
        parts.set(name, ps[0]!)
        return { id: name, hash: name, name, triangles: ps[0]!.indices.length / 3, bboxMm: [1, 1, 1], openEdges: 0, parts: [{ name, slot: 1, triangles: 1 }] }
      },
    }
    const values = combinedValues(defaultValues)
    const id = await addCombinedPlate(loader, ['flow', 'pressure-advance', 'temp-tower'], values, 1)
    const s = get()
    const run = s.calibration[id]!
    const meshes: Record<string, string> = {}
    for (const e of s.plate) {
      const f = join(dir, `${e.id}.stl`)
      writeFileSync(f, stl(parts.get(e.name)!))
      meshes[e.id] = f
    }
    const request = {
      plate: { objects: s.plate.map((e) => ({ id: e.id, name: e.name, mesh: e.id, transform: e.transform, settings: s.objectSettings[e.id] ?? {} })) },
      config: { print_sequence: 'by object', gcode_flavor: 'klipper', brim_width: 0, skirt_loops: 0, extruder_clearance_radius: 40, extruder_clearance_height_to_rod: 40, printable_area: ['0x0', '256x0', '256x256', '0x256'] },
      options: { heightRanges: run.ranges },
      meshes,
    }
    const reqFile = join(dir, 'req.json')
    writeFileSync(reqFile, JSON.stringify(request))
    const out = execFileSync(sx, ['slice', '--request', reqFile, '--out-dir', dir], { maxBuffer: 1 << 28 }).toString()
    expect(JSON.parse(out)).toBeTruthy()
    const gcode = readFileSync(join(dir, 'slice.gcode'), 'utf8')
    if (process.env['SX_KEEP']) writeFileSync(process.env['SX_KEEP'], gcode)
    // Flow pads: identical pads, so the filament each one takes is in the ratio of its own flow ratio.
    const pads = s.plate.filter((e) => s.objectSettings[e.id]?.['filament_flow_ratio'] !== undefined).map((e) => {
      const pos = parts.get(e.name)!.positions
      const box = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity }
      for (let i = 0; i < pos.length; i += 3) {
        box.x0 = Math.min(box.x0, pos[i]! + e.transform[12]!)
        box.x1 = Math.max(box.x1, pos[i]! + e.transform[12]!)
        box.y0 = Math.min(box.y0, pos[i + 1]! + e.transform[13]!)
        box.y1 = Math.max(box.y1, pos[i + 1]! + e.transform[13]!)
      }
      return { ratio: s.objectSettings[e.id]!['filament_flow_ratio'] as number, box, e: 0 }
    })
    expect(pads.length).toBeGreaterThanOrEqual(4)
    for (const line of gcode.split('\n')) {
      const m = /^G1 X([\d.-]+) Y([\d.-]+) E([\d.]+)/.exec(line)
      if (!m) continue
      const [x, y] = [Number(m[1]), Number(m[2])]
      const pad = pads.find((q) => x >= q.box.x0 - 1 && x <= q.box.x1 + 1 && y >= q.box.y0 - 1 && y <= q.box.y1 + 1)
      if (pad) pad.e += Number(m[3])
    }
    for (const pad of pads) expect(pad.e / pads[0]!.e / (pad.ratio / pads[0]!.ratio), `flow ${pad.ratio}`).toBeCloseTo(1, 1)
    // Temperature tower: every band's temperature is set.
    const temps = new Set([...gcode.matchAll(/^M10[49] S(\d+)/gm)].map((m) => Number(m[1])))
    for (const t of run.combined!.find((p) => p.test === 'temp-tower')!.values) expect(temps.has(t), `temperature ${t}`).toBe(true)
    // Pressure advance tower: each value is set (Klipper spelling).
    const pa = new Set([...gcode.matchAll(/SET_PRESSURE_ADVANCE ADVANCE=([0-9.]+)/g)].map((m) => Number(m[1])))
    for (const v of run.combined!.find((p) => p.test === 'pressure-advance')!.values) expect([...pa].some((x) => Math.abs(x - v) < 1e-9), `pressure advance ${v}`).toBe(true)
    writeFileSync(join(dir, 'summary.txt'), `${temps.size} temperatures, ${pa.size} pressure advance values`)
  })
})
