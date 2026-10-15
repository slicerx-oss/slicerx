// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveSliceConfig } from '../src/config'
import type { SliceSummary } from '../src/slicer'
import { writeZip } from '../src/zip'
import { connect, data, noSx, sxBin, sxTimeout, text } from './helpers'

function coloredPlate(file: string): void {
  const vertices = [[0, 0, 0], [12, 0, 0], [12, 10, 0], [0, 10, 0], [0, 0, 3], [12, 0, 3], [12, 10, 3], [0, 10, 3]]
  const faces = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]]
  const mesh = `<mesh><vertices>${vertices.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('')}</vertices><triangles>${faces.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('')}</triangles></mesh>`
  const objects = [1, 2, 3].map((id) => `<object id="${id}" type="model">${mesh}</object>`).join('')
  const items = Array.from({ length: 30 }, (_, i) => `<item objectid="${i % 3 + 1}" transform="1 0 0 0 1 0 0 0 1 ${40 + i % 6 * 25} ${40 + Math.floor(i / 6) * 25} 0"/>`).join('')
  const instances = Array.from({ length: 30 }, (_, i) => `<model_instance><metadata key="object_id" value="${i % 3 + 1}"/><metadata key="instance_id" value="${Math.floor(i / 3)}"/></model_instance>`).join('')
  writeFileSync(file, writeZip([
    { name: '3D/3dmodel.model', data: `<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>${objects}</resources><build>${items}</build></model>` },
    { name: 'Metadata/model_settings.config', data: `<config>${[1, 2, 3].map((id) => `<object id="${id}"><metadata key="extruder" value="${id}"/></object>`).join('')}<plate><metadata key="plater_id" value="1"/>${instances}</plate></config>` },
  ]))
}

describe('process motion settings for the selected printer', () => {
  it('uses U1 motion settings for Standard in either profile order and for the default process', async () => {
    const h = await connect()
    await h.ctx.profiles.prepare(['machine:snapmaker-u1', 'process:standard'])
    for (const names of [['machine:snapmaker-u1', 'process:standard'], ['process:standard', 'machine:snapmaker-u1'], ['machine:snapmaker-u1']]) {
      const { config } = resolveSliceConfig(h.ctx.store, h.ctx.profiles, names, undefined)
      expect(config.outer_wall_speed, names.join(',')).toEqual([200])
      expect(config.default_acceleration).toEqual([10000])
      expect(config.travel_speed).toEqual([500])
    }
  })

  it('uses the project printer when a process is applied over its saved settings', async () => {
    const h = await connect()
    await h.ctx.profiles.prepare(['process:standard'])
    const { config } = resolveSliceConfig(h.ctx.store, h.ctx.profiles, ['process:standard'], undefined, {
      project: { name: 'colored-parts.3mf', model: 'snapmaker-u1', config: { nozzle_diameter: [0.4], outer_wall_speed: [200], default_acceleration: [10000] } },
    })
    expect(config.outer_wall_speed).toEqual([200])
    expect(config.default_acceleration).toEqual([10000])
  })

  it('keeps explicit speed choices and the generic process without a known printer', async () => {
    const h = await connect()
    await h.ctx.profiles.prepare(['machine:snapmaker-u1', 'process:standard'])
    const chosen = resolveSliceConfig(h.ctx.store, h.ctx.profiles, ['machine:snapmaker-u1', 'process:standard'], { outer_wall_speed: [55] })
    expect(chosen.config.outer_wall_speed).toEqual([55])
    expect(resolveSliceConfig(h.ctx.store, h.ctx.profiles, ['process:standard'], undefined).config.outer_wall_speed).toEqual([60])
  })

  it('follows the final printer and nozzle while leaving user presets last', async () => {
    const h = await connect()
    await h.ctx.profiles.prepare(['machine:snapmaker-u1', 'machine:prusa-mk4s', 'process:standard'])
    const switched = resolveSliceConfig(h.ctx.store, h.ctx.profiles, ['machine:snapmaker-u1', 'process:standard', 'machine:prusa-mk4s'], undefined)
    expect(switched.config.outer_wall_speed).toEqual([170])
    const nozzle = resolveSliceConfig(h.ctx.store, h.ctx.profiles, ['machine:snapmaker-u1', 'process:standard'], { nozzle_diameter: [0.6] })
    expect(nozzle.config.nozzle_diameter).toEqual([0.6])
    expect(nozzle.config.outer_wall_speed).toEqual([60])
    const custom = resolveSliceConfig(h.ctx.store, h.ctx.profiles, ['machine:snapmaker-u1', 'process:standard'], undefined, {
      presets: [{ name: 'Quiet', section: 'process', values: { outer_wall_speed: [45] }, customGcode: false }],
    })
    expect(custom.config.outer_wall_speed).toEqual([45])
  })

  it.skipIf(noSx())('sends the selected printer motion settings through a real three-color plate slice', async () => {
    const h = await connect({ engine: 'sx', sxBin })
    const model = join(h.dir, 'colored-parts.3mf')
    coloredPlate(model)
    const inspected = await h.call('slicerx_inspect_project', { file: model })
    expect(data<{ plates: { objects: number }[] }>(inspected).plates[0]?.objects).toBe(30)
    const result = await h.call('slicerx_slice_file', {
      model,
      profiles: ['machine:snapmaker-u1', 'process:standard'],
      filaments: ['#FF0000', '#00FF00', '#0000FF'].map((color, i) => ({ slot: i + 1, profile: 'filament:pla', color })),
      overrides: { enable_support: false, brim_type: 'no_brim' },
    })
    expect(result.isError, text(result)).toBeFalsy()
    const sliced = data<SliceSummary>(result)
    expect(sliced.engine).toBe('sx')
    expect(sliced.layer_count).toBeGreaterThan(0)
    expect(sliced.filaments.filter((f) => f.filament_mm > 0)).toHaveLength(3)
    const gcode = readFileSync(sliced.gcode_path!, 'utf8')
    expect(gcode).toContain('SET_VELOCITY_LIMIT ACCEL=10000')
    expect(gcode).toContain('SET_VELOCITY_LIMIT ACCEL=5000')
  }, sxTimeout)
})
