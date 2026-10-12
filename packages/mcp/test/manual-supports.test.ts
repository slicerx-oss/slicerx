// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Manual supports in a Bambu Studio style project, sliced the way a client does it. A plate whose only enforcers are
// painted triangles (paint_supports) prints supports there and gets no "plate has none" warning, also by object, where
// each object is sliced on its own and only one of them is painted. A plate with no enforcers at all still warns.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeZip } from '../src/zip'
import { connect, data, noSx, sxBin, sxTimeout, text } from './helpers'

const NONE = 'Manual supports print only where enforcers ask, and the plate has none'
const A1 = ['machine:bambu-a1', 'process:standard']
/** Over the profiles, which turn on automatic supports. */
const MANUAL = { enable_support: true, support_type: 'tree(manual)', print_sequence: 'by object' }

type V = [number, number, number]

/** The faces of an axis-aligned box from `lo` to `hi`, outward, after `base` vertices; bottom face first. */
function box(lo: V, hi: V, base: number): { v: V[]; t: [number, number, number][] } {
  const v: V[] = []
  for (let i = 0; i < 8; i++) v.push([i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]])
  const faces: [number, number, number][] = [[0, 2, 1], [1, 2, 3], [4, 5, 6], [5, 7, 6], [0, 1, 4], [1, 5, 4], [2, 6, 3], [3, 6, 7], [0, 4, 2], [2, 4, 6], [1, 3, 5], [3, 7, 5]]
  return { v, t: faces.map(([a, b, c]) => [a + base, b + base, c + base]) }
}

/**
 * A table: a 10 mm square leg 12 mm tall under a 40 by 10 mm top 3 mm thick, which overhangs 15 mm each side. With
 * `painted`, the underside of the top is painted as a support enforcer the way Bambu Studio writes it ("4").
 */
function table(id: number, name: string, painted: boolean): string {
  const leg = box([-5, -5, 0], [5, 5, 12], 0)
  const top = box([-20, -5, 12], [20, 5, 15], 8)
  const vertices = [...leg.v, ...top.v].map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('')
  const tris = [...leg.t, ...top.t].map(([a, b, c], i) => `<triangle v1="${a}" v2="${b}" v3="${c}"${painted && (i === 12 || i === 13) ? ' paint_supports="4"' : ''}/>`).join('')
  return `<object id="${id}" name="${name}" type="model"><mesh><vertices>${vertices}</vertices><triangles>${tris}</triangles></mesh></object>`
}

/** One plate, two tables 120 mm apart, printed by object with manual tree supports; the left one painted when asked. */
function project(path: string, painted: boolean): string {
  const model = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>${table(1, 'left', painted)}${table(2, 'right', false)}</resources><build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 68 128 0"/><item objectid="2" transform="1 0 0 0 1 0 0 0 1 188 128 0"/></build></model>`
  const objects = ['left', 'right'].map((n, i) => `<object id="${i + 1}"><metadata key="name" value="${n}"/><metadata key="extruder" value="1"/></object>`).join('')
  const plate = `<plate><metadata key="plater_id" value="1"/>${[1, 2].map((i) => `<model_instance><metadata key="object_id" value="${i}"/><metadata key="instance_id" value="0"/></model_instance>`).join('')}</plate>`
  const settings = { printer_settings_id: 'Bambu Lab A1 0.4 nozzle', enable_support: '1', support_type: 'tree(manual)', print_sequence: 'by object' }
  writeFileSync(
    path,
    writeZip([
      { name: '3D/3dmodel.model', data: model },
      { name: 'Metadata/model_settings.config', data: `<?xml version="1.0" encoding="UTF-8"?><config>${objects}${plate}</config>` },
      { name: 'Metadata/project_settings.config', data: JSON.stringify(settings) },
    ]),
  )
  return path
}

describe.skipIf(noSx())('manual supports from painted enforcers', () => {
  it('a plate whose enforcers are painted prints supports and does not say it has none', { timeout: sxTimeout }, async () => {
    const h = await connect({ engine: 'sx', sxBin })
    const r = await h.call('slicerx_slice_file', { model: project(join(h.dir, 'painted.3mf'), true), profiles: A1, overrides: MANUAL })
    expect(r.isError, text(r)).toBeFalsy()
    const out = data<{ warnings: string[]; gcode_path: string }>(r)
    expect(out.warnings.filter((w) => w.includes(NONE))).toEqual([])
    expect(readFileSync(out.gcode_path, 'utf8')).toMatch(/^; FEATURE: Support$/m)
  })

  it('a plate with no enforcers still warns, and prints no supports', { timeout: sxTimeout }, async () => {
    const h = await connect({ engine: 'sx', sxBin })
    const r = await h.call('slicerx_slice_file', { model: project(join(h.dir, 'plain.3mf'), false), profiles: A1, overrides: MANUAL })
    expect(r.isError, text(r)).toBeFalsy()
    const out = data<{ warnings: string[]; gcode_path: string }>(r)
    expect(out.warnings.some((w) => w.includes(NONE)), JSON.stringify(out.warnings)).toBe(true)
    expect(readFileSync(out.gcode_path, 'utf8')).not.toMatch(/^; FEATURE: Support$/m)
  })
})
