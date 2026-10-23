// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { boxStl, connect, data, noSx, sxBin } from './helpers'

it.skipIf(noSx()).each([
  { name: 'skirt', changes: { skirt_loops: 1, skirt_distance: 6, brim_type: 'no_brim' }, refused: 45, accepted: 40 },
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
