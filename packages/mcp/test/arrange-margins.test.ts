// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { SettingValue } from '@slicerx/contracts'
import { plateMargins } from '@slicerx/settings/arrange-room'
import { bedArea } from '../src/bed'
import { geomEngine } from '../src/geom'
import { boxFillCount, boxPlate, fillCount, nestPlate, type NestObject } from '../src/plate-nest'
import { bedOf, runSx, sxConfig } from '../src/sx'
import { boxStl, connect, data, noSx, noSxGeom, sxBin, sxGeomBin, sxTimeout } from './helpers'

it.skipIf(noSx()).each([
  // 39, not 40: the A1 keeps its nozzle wrap check corner clear.
  { name: 'skirt', changes: { skirt_loops: 1, skirt_distance: 6, brim_type: 'no_brim' }, refused: 45, accepted: 39 },
  { name: 'wide skirt', changes: { skirt_loops: 2, skirt_distance: 20, brim_type: 'no_brim' }, refused: 40, accepted: 24 },
  { name: 'shifted smaller bed skirt', changes: { skirt_loops: 1, skirt_distance: 6, brim_type: 'no_brim', printable_area: ['20x10', '220x10', '220x210', '20x210'] }, refused: 40, accepted: 20 },
  { name: 'brim', changes: { skirt_loops: 0, brim_type: 'outer_only', brim_width: 12 }, refused: 40, accepted: 12 },
])('keeps the $name inside the printable area', async ({ changes, refused: tooMany, accepted }) => {
  const h = await connect({ engine: 'sx', sxBin })
  try {
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = await h.call(name, args)
      const d = data(r)
      expect(r.isError, JSON.stringify(d)).not.toBe(true)
      expect(d['ok'], JSON.stringify(d)).not.toBe(false)
      return d
    }
    await call('slicerx_project_open', { printer: 'Bambu Lab A1', filament: 'Bambu PLA Basic' })
    writeFileSync(join(h.dir, 'box.stl'), boxStl(40, 23, 15))
    await call('slicerx_project_add_model', { model: join(h.dir, 'box.stl') })
    await call('slicerx_project_set_overrides', { changes: { ...changes, layer_height: 0.3 } })
    const refused = await h.call('slicerx_arrange', { count: tooMany })
    expect(refused.isError).toBe(true)
    await call('slicerx_arrange', { count: accepted })
    await call('slicerx_slice')
  } finally {
    await h.client.close()
  }
}, 240_000)

/** A stem 10 mm square and high under a `w` mm square cap 3 mm thick, as one binary STL. */
function mushroomStl(w: number): Buffer {
  const at = (b: Buffer, x: number, y: number, z: number) => {
    for (let t = 0; t < 12; t++) for (let k = 0; k < 3; k++) [x, y, z].forEach((v, j) => b.writeFloatLE(b.readFloatLE(84 + t * 50 + 12 + k * 12 + j * 4) + v, 84 + t * 50 + 12 + k * 12 + j * 4))
    return b
  }
  const stem = at(boxStl(10, 10, 10), w / 2 - 5, w / 2 - 5, 0)
  const cap = at(boxStl(w, w, 3), 0, 0, 10)
  const out = Buffer.concat([stem, cap.subarray(84)])
  out.writeUInt32LE(24, 80)
  return out
}

/** Every X and Y the G-code extrudes to in its features (not the printer's own start script), mm. */
function extrudedPoints(gcode: string): [number, number][] {
  const out: [number, number][] = []
  let x = 0
  let y = 0
  let feature = false
  for (const raw of gcode.split('\n')) {
    if (/^;\s*(FEATURE|TYPE):/.test(raw)) feature = true
    const line = raw.split(';')[0]!.trim()
    if (!feature || !/^G[0-3]\b/.test(line)) continue
    const word = (c: string) => line.match(new RegExp(String.raw`\b${c}(-?[\d.]+)`))?.[1]
    x = Number(word('X') ?? x)
    y = Number(word('Y') ?? y)
    if (Number(word('E') ?? 0) > 0) out.push([x, y])
  }
  return out
}

it.skipIf(noSx())('keeps a supported part and the skirt round its support on the bed', async () => {
  // The first layer of normal support fills whole grid cells past the overhang, and the skirt goes 6 mm round that.
  // Three of these caps fit a row of the P1S bed at its 10 mm edge, where the skirt round their support ran past the
  // bed (X 256.1) and the slice was refused.
  const h = await connect({ engine: 'sx', sxBin })
  try {
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = await h.call(name, args)
      const d = data(r)
      expect(r.isError, JSON.stringify(d)).not.toBe(true)
      expect(d['ok'], JSON.stringify(d)).not.toBe(false)
      return d
    }
    await call('slicerx_project_open', { printer: 'Bambu Lab P1S', filament: 'Bambu PLA Basic' })
    writeFileSync(join(h.dir, 'mushroom.stl'), mushroomStl(75.1))
    await call('slicerx_project_add_model', { model: join(h.dir, 'mushroom.stl') })
    await call('slicerx_project_set_overrides', { changes: { enable_support: true, support_type: 'normal(auto)', brim_type: 'no_brim', skirt_loops: 1, skirt_distance: 6 } })
    let placed = 0
    for (const count of [16, 12, 9, 6, 4]) {
      const r = await h.call('slicerx_arrange', { count })
      if (!r.isError && data(r)['ok'] !== false) {
        placed = count
        break
      }
    }
    expect(placed).toBeGreaterThan(0)
    await call('slicerx_slice')
    const plates = join(h.dir, 'out', 'plates')
    const files = existsSync(plates) ? readdirSync(plates).flatMap((id) => readdirSync(join(plates, id)).filter((f) => f.endsWith('.gcode')).map((f) => join(plates, id, f))) : []
    expect(files).toHaveLength(1)
    const points = extrudedPoints(readFileSync(files[0]!, 'utf8'))
    expect(points.length).toBeGreaterThan(1000)
    const box = points.reduce((b, [x, y]) => [Math.min(b[0]!, x), Math.min(b[1]!, y), Math.max(b[2]!, x), Math.max(b[3]!, y)], [Infinity, Infinity, -Infinity, -Infinity])
    expect(box[0]! >= 0 && box[1]! >= 0 && box[2]! <= 256 && box[3]! <= 256, `${placed} placed, extruding from ${box[0]}, ${box[1]} to ${box[2]}, ${box[3]}`).toBe(true)
  } finally {
    await h.client.close()
  }
}, 240_000)

/** A binary STL's triangles as the nest reads a part: corners and their indices, three a triangle. */
function partOf(stl: Buffer): { positions: Float32Array; indices: Uint32Array } {
  const n = stl.readUInt32LE(80)
  const positions = new Float32Array(n * 9)
  for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) positions[t * 9 + k] = stl.readFloatLE(84 + t * 50 + 12 + k * 4)
  return { positions, indices: Uint32Array.from({ length: n * 3 }, (_, i) => i) }
}

// A config merged the way docs/integrators/engine-path.md tells an integrator to: the SlicerX default process and a
// printer, neither of which sets a skirt key. sx then prints its default skirt, so a fill plan on the same config has
// to keep that skirt's room at the bed edge. The plan used to read the missing skirt_loops as no skirt and set copies
// 6 mm in, where the skirt 7.2 mm round them ran 1.2 mm past the bed and the slice was refused.
for (const planner of ['boxes', 'outlines'] as const) {
  it.skipIf(noSx() || (planner === 'outlines' && noSxGeom()))(`fills a bed on its ${planner} for a config with no skirt keys, and sx slices it with its default skirt`, async () => {
    const h = await connect()
    try {
      const profile = async (id: string) => data<{ config: Record<string, SettingValue> }>(await h.call('slicerx_get_profile', { profile: id })).config
      const config = { ...(await profile('process:slicerx-default')), ...(await profile('machine:prusa-mk4')) }
      expect(Object.keys(config).filter((k) => k.includes('skirt'))).toEqual([])
      const stl = boxStl(20, 20, 10)
      const model = join(h.dir, 'box.stl')
      writeFileSync(model, stl)
      const part = partOf(stl)
      const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
      const o: NestObject = { id: 'box', meshId: 'box', parts: () => [part], linear: identity, size: [20, 20, 10], min: [0, 0, 0], config, copies: 1 }
      // The arrange tool's default gap between copies.
      const plate = { bed: bedArea(config), config, tools: 1, gapMm: 6, fixed: [] }
      let placements
      if (planner === 'boxes') {
        const copies = boxFillCount(plate, o, 500)
        placements = boxPlate({ ...plate, moving: [{ ...o, copies }], center: false }).placements
      } else {
        const engine = geomEngine(sxGeomBin)
        const cache = new Map()
        const copies = await fillCount(engine, plate, o, 500, cache)
        placements = (await nestPlate(engine, { ...plate, moving: [{ ...o, copies }], center: false }, cache)).placements
      }
      expect(placements.length).toBeGreaterThan(20)
      const objects = placements.map((q, i) => ({ id: `box${i + 1}`, mesh: model, transform: [...identity.slice(0, 12), q.offset[0], q.offset[1], 0, 1] }))
      const bed = bedOf(config)
      const out = join(h.dir, 'out')
      mkdirSync(out, { recursive: true })
      writeFileSync(join(out, 'request.json'), JSON.stringify({ schemaVersion: 1, plate: { ...(bed ? { bed } : {}), objects }, config: sxConfig(config), options: { emitGcode: true, emitPreview: false } }))
      const ran = await runSx(sxBin, ['slice', '--request', join(out, 'request.json'), '--out-dir', out], sxTimeout)
      expect(ran.code, ran.stderr).toBe(0)
    } finally {
      await h.client.close()
    }
  }, 240_000)
}

/** The extruded X and Y of the G-code's prime tower moves, mm. */
function towerPoints(gcode: string): [number, number][] {
  const out: [number, number][] = []
  let x = 0
  let y = 0
  let tower = false
  for (const raw of gcode.split('\n')) {
    const type = raw.match(/^;\s*(?:TYPE|FEATURE):\s*(.*)$/)
    if (type) {
      tower = /prime tower/i.test(type[1]!)
      continue
    }
    const line = raw.split(';')[0]!.trim()
    if (!/^G[0-3]\b/.test(line)) continue
    const word = (c: string) => line.match(new RegExp(String.raw`\b${c}(-?[\d.]+)`))?.[1]
    x = Number(word('X') ?? x)
    y = Number(word('Y') ?? y)
    if (tower && Number(word('E') ?? 0) > 0) out.push([x, y])
  }
  return out
}

// The same integrator config printing in two filaments, the prime tower at its configured spot. Neither profile sets
// prime_tower_width, so sx prints the tower at the schema's 60 mm. The fill plan used to keep 35 mm for it (43 with
// its brim and 1 mm), while sx laid it 66 mm wide.
it.skipIf(noSx())('fills a two filament bed for a config with no prime tower width, keeping room as wide as the tower sx prints', async () => {
  const h = await connect()
  try {
    const profile = async (id: string) => data<{ config: Record<string, SettingValue> }>(await h.call('slicerx_get_profile', { profile: id })).config
    const config: Record<string, SettingValue> = {
      ...(await profile('process:slicerx-default')),
      ...(await profile('machine:prusa-mk4')),
      enable_prime_tower: true,
      prime_tower_auto_position: false,
      filament_colour: ['#FFFFFF', '#2255FF'],
      filament_type: ['PLA', 'PLA'],
      filament_diameter: [1.75, 1.75],
    }
    expect(config['prime_tower_width']).toBeUndefined()
    const stl = boxStl(20, 20, 4)
    const model = join(h.dir, 'box.stl')
    writeFileSync(model, stl)
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    const o: NestObject = { id: 'box', meshId: 'box', parts: () => [partOf(stl)], linear: identity, size: [20, 20, 4], min: [0, 0, 0], config, copies: 1 }
    const bedBox = bedArea(config)
    const plate = { bed: bedBox, config, tools: 2, gapMm: 6, fixed: [] }
    const room = plateMargins(config, 2, { origin: [bedBox.x0, bedBox.y0], size: { widthMm: bedBox.widthMm, depthMm: bedBox.depthMm } }).keepOut
    expect(room).toHaveLength(1)
    const copies = boxFillCount(plate, o, 500)
    const placements = boxPlate({ ...plate, moving: [{ ...o, copies }], center: false }).placements
    expect(placements.length).toBeGreaterThan(20)
    // every other copy in filament 2, so the plate changes filament and prints the tower
    const objects = placements.map((q, i) => ({ id: `box${i + 1}`, mesh: model, transform: [...identity.slice(0, 12), q.offset[0], q.offset[1], 0, 1], ...(i % 2 ? { slotOverrides: { 'box.stl': 2 } } : {}) }))
    const bed = bedOf(config)
    const out = join(h.dir, 'out')
    mkdirSync(out, { recursive: true })
    writeFileSync(join(out, 'request.json'), JSON.stringify({ schemaVersion: 1, plate: { ...(bed ? { bed } : {}), objects }, config: sxConfig(config), options: { emitGcode: true, emitPreview: false } }))
    const ran = await runSx(sxBin, ['slice', '--request', join(out, 'request.json'), '--out-dir', out], sxTimeout)
    expect(ran.code, ran.stderr).toBe(0)
    const points = towerPoints(readFileSync((JSON.parse(ran.stdout) as { files: { gcode: string } }).files.gcode, 'utf8'))
    expect(points.length).toBeGreaterThan(100)
    // the tower itself: its moves around the middle row, leaving out the odd priming move away from it
    const ys = points.map((p) => p[1]).sort((a, b) => a - b)
    const mid = ys[Math.floor(ys.length / 2)]!
    const xs = points.filter((p) => Math.abs(p[1] - mid) < 30).map((p) => p[0])
    const [x0, x1] = [Math.min(...xs), Math.max(...xs)]
    expect(x0, `tower printed from x ${x0} to ${x1}, room from ${room[0]!.x} to ${room[0]!.x + room[0]!.w}`).toBeGreaterThanOrEqual(room[0]!.x)
    expect(x1, `tower printed from x ${x0} to ${x1}, room from ${room[0]!.x} to ${room[0]!.x + room[0]!.w}`).toBeLessThanOrEqual(room[0]!.x + room[0]!.w)
  } finally {
    await h.client.close()
  }
}, 240_000)
