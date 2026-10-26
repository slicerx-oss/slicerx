// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// slicerx_slice_file with project_settings passes a Bambu Studio project's per-plate tower spots (wipe_tower_x and
// wipe_tower_y, one entry per plate) to the engine as the file has them, and names the plate; the engine prints that
// plate's tower at the plate's own entry, as the app and sx slice <project.3mf> do.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeZip } from '../src/zip'
import { connect, data, noSx, sxBin, sxTimeout } from './helpers'

/** Each plate's tower spot, as the file's per-plate lists hold them. */
const SPOTS: [number, number][] = [[30, 200], [180, 30], [200, 180]]

/** A 30 x 30 x 3 mm box with its front face painted another filament, so every layer changes tools. */
function box(id: number): string {
  const v = [[-15, -15, 0], [15, -15, 0], [15, 15, 0], [-15, 15, 0], [-15, -15, 3], [15, -15, 3], [15, 15, 3], [-15, 15, 3]]
  const t: [number[], boolean][] = [[[0, 2, 1], false], [[0, 3, 2], false], [[4, 5, 6], false], [[4, 6, 7], false], [[0, 1, 5], true], [[0, 5, 4], true], [[1, 2, 6], false], [[1, 6, 5], false], [[2, 3, 7], false], [[2, 7, 6], false], [[3, 0, 4], false], [[3, 4, 7], false]]
  return `<object id="${id}" type="model"><mesh><vertices>${v.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('')}</vertices><triangles>${t.map(([[a, b, c], p]) => `<triangle v1="${a}" v2="${b}" v3="${c}"${p ? ' paint_color="1C"' : ''}/>`).join('')}</triangles></mesh></object>`
}

/** A three-plate P1S project, one box in the middle of each plate, the plates on the project's grid. */
function threeTowers(path: string): string {
  const at = [[128, 128], [128 + 256 * 1.2, 128], [128, 128 - 256 * 1.2]]
  const main = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><metadata name="Application">BambuStudio-02.08.02.61</metadata><resources>${[1, 2, 3].map(box).join('')}</resources><build>${at.map(([x, y], i) => `<item objectid="${i + 1}" transform="1 0 0 0 1 0 0 0 1 ${x} ${y} 0"/>`).join('')}</build></model>`
  const objects = [1, 2, 3].map((o) => `<object id="${o}"><metadata key="name" value="box${o}"/><metadata key="extruder" value="1"/></object>`).join('')
  const plates = [1, 2, 3].map((p) => `<plate><metadata key="plater_id" value="${p}"/><model_instance><metadata key="object_id" value="${p}"/></model_instance></plate>`).join('')
  const settings = {
    printer_settings_id: 'Bambu Lab P1S 0.4 nozzle',
    printer_model: 'Bambu Lab P1S',
    printable_area: ['0x0', '256x0', '256x256', '0x256'],
    filament_colour: ['#FFFFFF', '#FF0000', '#00A0FF', '#202020'],
    filament_type: ['PLA', 'PLA', 'PLA', 'PLA'],
    enable_prime_tower: '1',
    prime_tower_width: '35',
    wipe_tower_x: SPOTS.map(([x]) => String(x)),
    wipe_tower_y: SPOTS.map(([, y]) => String(y)),
    brim_width: '0',
    skirt_loops: '0',
    layer_height: '0.2',
    initial_layer_print_height: '0.2',
  }
  writeFileSync(path, writeZip([
    { name: '3D/3dmodel.model', data: main },
    { name: 'Metadata/model_settings.config', data: `<?xml version="1.0" encoding="UTF-8"?><config>${objects}${plates}</config>` },
    { name: 'Metadata/project_settings.config', data: JSON.stringify(settings) },
  ]))
  return path
}

/** The tower's front left corner: the 2nd percentile of the X and Y its extrusions reach from the second layer up. */
function towerCorner(gcode: string): [number, number] | null {
  let feature = ''
  let layer = 0
  let x = NaN
  let y = NaN
  const xs: number[] = []
  const ys: number[] = []
  for (const line of gcode.split('\n')) {
    if (line.startsWith('; FEATURE:')) feature = line.slice(10).trim()
    else if (line.startsWith('; CHANGE_LAYER')) layer++
    else if (/^G[123] /.test(line)) {
      const word = (c: string): number | undefined => {
        const m = new RegExp(` ${c}(-?[\\d.]+)`).exec(line)
        return m ? Number(m[1]) : undefined
      }
      x = word('X') ?? x
      y = word('Y') ?? y
      const e = word('E')
      if (feature === 'Prime tower' && layer >= 2 && e !== undefined && e > 0 && Number.isFinite(x) && Number.isFinite(y)) {
        xs.push(x)
        ys.push(y)
      }
    }
  }
  if (xs.length === 0) return null
  const low = (v: number[]): number => v.sort((a, b) => a - b)[Math.floor(0.02 * (v.length - 1))]!
  return [low(xs), low(ys)]
}

describe.skipIf(noSx())('a project tower spot per plate, with the real sx CLI', () => {
  it('prints each plate\'s tower at its own spot', { timeout: sxTimeout * 3 }, async () => {
    const h = await connect({ engine: 'sx', sxBin })
    const file = threeTowers(join(h.dir, 'three-towers.3mf'))
    for (const [i, [wx, wy]] of SPOTS.entries()) {
      const r = await h.call('slicerx_slice_file', { model: file, plate: i + 1, project_settings: true, project_gcode: 'profile' })
      expect(r.isError, JSON.stringify(r.content)).toBeFalsy()
      const corner = towerCorner(readFileSync(data<{ gcode_path: string }>(r).gcode_path, 'utf8'))
      expect(corner, `plate ${i + 1}`).not.toBeNull()
      // within 2 mm: the printer profile's tower walls reach a little past the corner the engine is given
      expect(Math.abs(corner![0] - wx), `plate ${i + 1} x ${corner![0]}`).toBeLessThan(2)
      expect(Math.abs(corner![1] - wy), `plate ${i + 1} y ${corner![1]}`).toBeLessThan(2)
    }
    // The request carries the file's lists as they are and names the plate; the engine picks the plate's entry.
    const jobs = join(h.dir, 'out', 'jobs')
    const requests = readdirSync(jobs).map((j) => JSON.parse(readFileSync(join(jobs, j, 'request.json'), 'utf8')) as { config: Record<string, unknown> })
    for (const req of requests) expect(req.config['wipe_tower_x']).toEqual(['30', '180', '200'])
  })
})
