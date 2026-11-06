// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A project's printer G-code can name a setting SlicerX does not model, which the project itself carries. The engine
// renders a script from every key its config holds, and `sx slice <project.3mf>` slices with every key the file
// holds, so it renders the script. slicerx_slice_file builds its config from the imported settings, which leave the
// unknown key out: a script the slice keeps (here one the engine's stock review vouches for, as it does for a
// printer maker's own text) must still find the project's value for it.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { ScriptReview, ScriptReviewInput } from '@slicerx/contracts'
import { settingDef } from '@slicerx/settings'
import { connect, data, noSx, sxBin, sxTimeout } from './helpers'
import { writeZip } from '../src/zip'

const dir = mkdtempSync(join(tmpdir(), 'project-script-keys-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** A key no slicer setting has, which the project's own start G-code reads. */
const KEY = 'hold_probe_temp'
const START = `; our own start G-code\nM104 S{${KEY}[0]} ; hold\nG28\nM109 S{nozzle_temperature_initial_layer[0]}\n`

const cubeMesh = (s: number) => {
  const v = [[0, 0, 0], [s, 0, 0], [s, s, 0], [0, s, 0], [0, 0, s], [s, 0, s], [s, s, s], [0, s, s]]
  const t = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]]
  return `<mesh><vertices>${v.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('')}</vertices><triangles>${t.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('')}</triangles></mesh>`
}

/** A Bambu Studio project for the P1S of one 12 mm cube, with its own start G-code and the unknown key it reads. */
function p1sProject(): string {
  const model = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><metadata name="Application">BambuStudio-02.08.04.61</metadata><resources><object id="1" type="model">${cubeMesh(12)}</object><object id="2" type="model"><components><component objectid="1"/></components></object></resources><build><item objectid="2" transform="1 0 0 0 1 0 0 0 1 128 128 0"/></build></model>`
  const cfg = `<?xml version="1.0" encoding="UTF-8"?><config><object id="2"><metadata key="name" value="cube"/><metadata key="extruder" value="1"/><part id="1" subtype="normal_part"><metadata key="name" value="cube"/><metadata key="extruder" value="1"/></part></object><plate><metadata key="plater_id" value="1"/><model_instance><metadata key="object_id" value="2"/><metadata key="instance_id" value="0"/></model_instance></plate></config>`
  const settings = { printer_settings_id: 'Bambu Lab P1S 0.4 nozzle', printer_model: 'Bambu Lab P1S', gcode_flavor: 'marlin', nozzle_diameter: ['0.4'], filament_colour: ['#00AE42'], filament_type: ['PLA'], layer_height: '0.2', initial_layer_print_height: '0.2', machine_start_gcode: START, [KEY]: ['187'] }
  const path = join(dir, 'own-key.3mf')
  writeFileSync(path, writeZip([{ name: '3D/3dmodel.model', data: model }, { name: 'Metadata/model_settings.config', data: cfg }, { name: 'Metadata/project_settings.config', data: JSON.stringify(settings) }]))
  return path
}

/** The engine's stock review, answering that each script is the P1S maker's text. */
const vouched = async (inputs: ScriptReviewInput[]): Promise<ScriptReview[]> =>
  inputs.map(() => ({ schemaVersion: 1, decision: 'exact', reason: 'stock_match', identity: { model: 'bambu-p1s', firmware: 'marlin' }, source: 'test maker', stockVersion: '1.0', fingerprint: 'f'.repeat(32), ignored: [] }))

describe.skipIf(noSx())("a project's start G-code that reads a key SlicerX does not model", { timeout: sxTimeout }, () => {
  it('is a key the schema has no setting for', () => {
    expect(settingDef(KEY)).toBeUndefined()
  })

  it('renders with the project\'s value through sx slice <project.3mf>', () => {
    const file = p1sProject()
    const out = execFileSync(sxBin, ['slice', file, '-o', '-'], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 }).toString()
    expect(out).toContain('M104 S187 ; hold')
  })

  it('renders with the project\'s value through slicerx_slice_file when the slice keeps the script', async () => {
    const file = p1sProject()
    const h = await connect({ engine: 'sx', sxBin, allowDirs: [dir] })
    try {
      h.ctx.slicer!.reviewScripts = vouched
      const r = await h.call('slicerx_slice_file', { model: file, plate: 1, project_settings: true, script_printer: { model: 'bambu-p1s', firmware: 'marlin' } })
      const out = data<{ gcode_path?: string; project_gcode?: { key: string; use: string }[]; error?: { message: string } }>(r)
      expect(r.isError, JSON.stringify(out)).toBeFalsy()
      expect(out.project_gcode).toContainEqual(expect.objectContaining({ key: 'machine_start_gcode', use: 'project' }))
      const gcode = readFileSync(out.gcode_path!, 'utf8')
      expect(gcode).toContain('M104 S187 ; hold')
      const request = JSON.parse(readFileSync(join(out.gcode_path!, '..', 'request.json'), 'utf8')) as { config: Record<string, unknown> }
      expect(request.config[KEY]).toEqual(['187'])
    } finally {
      await h.client.close()
    }
  })

  it('leaves the key out when the slice uses the printer profile\'s G-code instead', async () => {
    const file = p1sProject()
    const h = await connect({ engine: 'sx', sxBin, allowDirs: [dir] })
    try {
      const r = await h.call('slicerx_slice_file', { model: file, plate: 1, profiles: ['machine:bambu-p1s'], project_settings: true, project_gcode: 'profile' })
      const out = data<{ gcode_path?: string }>(r)
      expect(r.isError, JSON.stringify(out)).toBeFalsy()
      const request = JSON.parse(readFileSync(join(out.gcode_path!, '..', 'request.json'), 'utf8')) as { config: Record<string, unknown> }
      expect(request.config['machine_start_gcode']).not.toBe(START)
      expect(request.config[KEY]).toBeUndefined()
    } finally {
      await h.client.close()
    }
  })
})
