// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A plate of several objects printed layer by layer gets one skirt round them all, also when objects have settings or
// layer heights of their own: a client slicing such a project through slicerx_slice_file finds one skirt loop on each
// of the plate's first skirt_height layers, round all three boxes, kept clear of each object's own brim.
//
// The projects (core's tests/fixtures/skirt-brim) are three 10 x 10 x 3 mm boxes in a row on the A1, 87 mm apart,
// with a one loop skirt 2 mm out on 3 layers and a 3 mm brim: c6 gives object 2 its own infill and object 3 a 6 mm
// brim, c7 prints the objects at 0.1, 0.2 and 0.3 mm layers.
import { copyFileSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { connect, data, noSx, sxBin, sxTimeout, text } from './helpers'

const fixtures = resolve(__dirname, '../../core/cli/tests/fixtures/skirt-brim')
const A1 = ['machine:bambu-a1', 'process:standard']
// The projects' plate: 0.2 mm layers (no smart layer heights), one skirt loop 2 mm out on 3 layers, a 3 mm brim 0.5 mm from the part.
const S1B3 = { layer_height: 0.2, initial_layer_print_height: 0.2, smart_layer: 'off', skirt_loops: 1, skirt_distance: 2, skirt_height: 3, brim_type: 'outer_only', brim_width: 3, brim_object_gap: 0.5 }
const XS = [40.96, 128, 215.04]
const Y = 128

type Pt = [number, number]

/** The skirt paths of each skirt layer: runs of skirt moves that start where the one before ended. */
function skirts(gcode: string): Map<number, Pt[][]> {
  const out = new Map<number, Pt[][]>()
  let feature = ''
  let started = false
  let [x, y, z] = [0, 0, 0]
  for (const line of gcode.split('\n')) {
    if (line.startsWith('; CHANGE_LAYER') || line.startsWith(';LAYER_CHANGE')) started = true
    if (line.startsWith('; FEATURE: ')) feature = line.slice(11).trim()
    else if (line.startsWith(';TYPE:')) feature = line.slice(6).trim()
    const code = line.split(';')[0]!.trim()
    if (!/^G[0123] /.test(code)) continue
    const get = (c: string) => {
      const m = new RegExp(` ${c}(-?[\\d.]+)`).exec(code)
      return m ? Number(m[1]) : undefined
    }
    const [nx, ny, nz] = [get('X') ?? x, get('Y') ?? y, get('Z') ?? z]
    const e = get('E') ?? 0
    if (started && feature === 'Skirt' && e > 0 && (nx !== x || ny !== y)) {
      const key = Math.round(nz * 100)
      const layer = out.get(key) ?? []
      const last = layer[layer.length - 1]
      const end = last?.[last.length - 1]
      if (last && end && Math.hypot(end[0] - x, end[1] - y) < 0.1) last.push([nx, ny])
      else layer.push([[x, y], [nx, ny]])
      out.set(key, layer)
    }
    ;[x, y, z] = [nx, ny, nz]
  }
  return out
}

const length = (p: Pt[]) => p.slice(1).reduce((s, q, i) => s + Math.hypot(q[0] - p[i]![0], q[1] - p[i]![1]), 0)

/** Whether the closed ring `p` goes round `q`. */
function encloses(p: Pt[], q: Pt): boolean {
  let inside = false
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const [a, b] = [p[i]!, p[j]!]
    if (a[1] > q[1] !== b[1] > q[1] && q[0] < ((b[0] - a[0]) * (q[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside
  }
  return inside
}

describe.skipIf(noSx())('slicerx_slice_file: one skirt round a plate of objects with settings of their own', { timeout: sxTimeout }, () => {
  const slice = async (name: string) => {
    const h = await connect({ engine: 'sx', sxBin })
    try {
      const model = join(h.dir, `${name}.3mf`)
      copyFileSync(join(fixtures, `${name}.3mf`), model)
      const r = await h.call('slicerx_slice_file', { model, profiles: A1, overrides: S1B3 })
      expect(r.isError, text(r)).toBeFalsy()
      return skirts(readFileSync(data<{ gcode_path: string }>(r).gcode_path, 'utf8'))
    } finally {
      await h.client.close()
    }
  }

  /** One loop on each skirt layer, round every box, each as long as the first layer's within 1 mm; the layers. */
  const oneLoopRoundAll = (layers: Map<number, Pt[][]>) => {
    const first = [...layers.values()][0]?.[0] ?? []
    for (const [z, loops] of layers) {
      expect(loops.length, `skirt paths at ${z / 100} mm`).toBe(1)
      for (const x of XS) expect(encloses(loops[0]!, [x, Y]), `the box at x ${x}, ${z / 100} mm`).toBe(true)
      expect(Math.abs(length(loops[0]!) - length(first)), `skirt at ${z / 100} mm`).toBeLessThanOrEqual(1)
    }
    return [...layers.keys()]
  }

  /** The first layer skirt's nearest distance to the edge of the box centered at x `cx`, mm. */
  const clearance = (layers: Map<number, Pt[][]>, cx: number) =>
    Math.min(...([...layers.values()][0]?.[0] ?? []).map(([x, y]) => Math.hypot(Math.max(Math.abs(x - cx) - 5, 0), Math.max(Math.abs(y - Y) - 5, 0))))

  it('keeps each brim at its own width inside one skirt', async () => {
    const layers = await slice('a1--c6')
    expect(oneLoopRoundAll(layers)).toEqual([20, 40, 60])
    // Object 3's 6 mm brim keeps the skirt about 3 mm further out than object 1's 3 mm brim does.
    const more = clearance(layers, XS[2]!) - clearance(layers, XS[0]!)
    expect(more).toBeGreaterThan(2.5)
    expect(more).toBeLessThan(3.1)
  })

  it('prints the skirt whole on the first three plate layers at mixed layer heights', async () => {
    expect(oneLoopRoundAll(await slice('a1--c7'))).toEqual([20, 30, 40])
  })
})
