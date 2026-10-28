// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The stock Prusa MK4 printer profile (machine:prusa-mk4, 0.4 mm nozzle) lifts and retracts like the maker's MK4 IS
// profile: a 0.2 mm lift only below Z 219, a 0.7 mm retraction, and travel lifts that ramp at 1 degree. The other MK4
// nozzles keep their own values.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveSliceConfig } from '../src/config'
import { connect, data, noSx, sxBin, sxTimeout, text } from './helpers'

/** A binary STL of two separate square columns, so every layer travels from one to the other. */
function twoColumns(side: number, height: number, gap: number): Buffer {
  const faces: [number, number, number][] = [
    [0, 2, 1], [1, 2, 3], [4, 5, 6], [5, 7, 6],
    [0, 1, 4], [1, 5, 4], [2, 6, 3], [3, 6, 7],
    [0, 4, 2], [2, 4, 6], [1, 3, 5], [3, 7, 5],
  ]
  const buf = Buffer.alloc(84 + 2 * faces.length * 50)
  buf.writeUInt32LE(2 * faces.length, 80)
  let t = 0
  for (const x0 of [0, side + gap]) {
    const v = (i: number): [number, number, number] => [x0 + (i & 1 ? side : 0), i & 2 ? side : 0, i & 4 ? height : 0]
    for (const f of faces) {
      const o = 84 + t++ * 50 + 12
      f.forEach((vi, k) => v(vi).forEach((c, j) => buf.writeFloatLE(c, o + k * 12 + j * 4)))
    }
  }
  return buf
}

interface Motion {
  /** Total length of each retraction: the negative E moves between two extrusions. */
  retracts: number[]
  /** Per printed Z, the highest the nozzle rose above it on the travels that land there. */
  lifts: Map<number, number>
  /** Angle in degrees of each lift ramp that ends before its travel does (a level travel move follows it). */
  ramps: number[]
}

/** Reads retractions, lifts and lift ramps from the printed part of the G-code (absolute XYZ, relative E). */
function motion(gcode: string): Motion {
  const out: Motion = { retracts: [], lifts: new Map(), ramps: [] }
  let [x, y, z] = [0, 0, 0]
  let pending = 0
  let peak = 0
  let ramp: number | undefined
  let printing = false
  for (const raw of gcode.split('\n')) {
    const t = raw.split(';')[0]!.trim()
    if (raw.startsWith(';LAYER_CHANGE')) printing = true
    const cmd = t.split(/\s+/)[0]
    if (cmd !== 'G0' && cmd !== 'G1') continue
    const arg = (k: string): number | undefined => {
      const m = new RegExp(`(?:^|\\s)${k}(-?[\\d.]+)`).exec(t.slice(cmd.length))
      return m ? Number(m[1]) : undefined
    }
    const [nx, ny, nz, e] = [arg('X') ?? x, arg('Y') ?? y, arg('Z') ?? z, arg('E')]
    const xy = Math.hypot(nx - x, ny - y)
    if (printing) {
      if (e !== undefined && e > 0 && xy > 0) {
        if (pending > 0) out.retracts.push(Math.round(pending * 1000) / 1000)
        if (peak > nz) out.lifts.set(nz, Math.max(out.lifts.get(nz) ?? 0, Math.round((peak - nz) * 1000) / 1000))
        else if (!out.lifts.has(nz)) out.lifts.set(nz, 0)
        pending = 0
        peak = nz
        ramp = undefined
      } else if (e !== undefined && e < 0) {
        pending += -e
      } else if (e === undefined && (xy > 0 || nz !== z)) {
        if (ramp !== undefined && xy > 0 && nz === z) out.ramps.push(ramp)
        ramp = nz > z + 1e-6 && xy > 1e-6 ? (Math.atan2(nz - z, xy) * 180) / Math.PI : undefined
        peak = Math.max(peak, nz)
      }
    }
    ;[x, y, z] = [nx, ny, nz]
  }
  return out
}

describe('stock Prusa MK4 lift and retraction', () => {
  it('takes the MK4 IS values for the 0.4 mm nozzle', async () => {
    const h = await connect()
    await h.ctx.profiles.prepare(['machine:prusa-mk4'])
    const { config } = resolveSliceConfig(h.ctx.store, h.ctx.profiles, ['machine:prusa-mk4'], undefined)
    expect(config.z_hop).toEqual([0.2])
    expect(config.retraction_length).toEqual([0.7])
    expect(config.retract_lift_below).toEqual([219])
    expect(config.travel_slope).toEqual([1])
  })

  it.skipIf(noSx())('lifts 0.2 mm only below Z 219, retracts 0.7 mm and ramps lifts at 1 degree', { timeout: sxTimeout * 3 }, async () => {
    const h = await connect({ engine: 'sx', sxBin })
    const model = join(h.dir, 'columns.stl')
    writeFileSync(model, twoColumns(6, 219.4, 30))
    const r = await h.call('slicerx_slice_file', { model, profiles: ['machine:prusa-mk4'] })
    expect(r.isError, text(r)).toBeFalsy()
    const m = motion(readFileSync(data<{ gcode_path: string }>(r).gcode_path, 'utf8'))
    expect(m.retracts.length).toBeGreaterThan(1000)
    expect([...new Set(m.retracts)]).toEqual([0.7])
    const below = [...m.lifts].filter(([layer]) => layer < 219)
    const above = [...m.lifts].filter(([layer]) => layer >= 219)
    expect(below.length).toBeGreaterThan(1000)
    expect(Math.max(...below.map(([, lift]) => lift))).toBe(0.2)
    expect(below.filter(([, lift]) => lift === 0.2).length).toBeGreaterThan(1000)
    expect(above.length).toBeGreaterThan(0)
    expect(above.map(([, lift]) => lift).filter((lift) => lift > 0)).toEqual([])
    expect(m.ramps.length).toBeGreaterThan(1000)
    for (const deg of m.ramps) expect(deg).toBeCloseTo(1, 1)
  })
})
