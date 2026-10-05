// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What an app that builds SlicerX in relies on: 3MF projects and plates, the user's own presets,
// stock filament presets, progress, and .gcode.3mf output.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { describe, expect, it } from 'vitest'
import { gcode3mf } from '../src/gcode3mf'
import type { SliceSummary } from '../src/slicer'
import { readZip, writeZip } from '../src/zip'
import { connect, data, text } from './helpers'

type Err = { error: { code: string; message: string } }

const MODEL = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="10" y="0" z="0"/><vertex x="0" y="10" z="0"/><vertex x="0" y="0" z="10"/></vertices><triangles><triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/><triangle v1="1" v2="2" v3="3"/><triangle v1="0" v2="3" v3="2"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>`

function projectFile(dir: string): string {
  const path = join(dir, 'two-plates.3mf')
  writeFileSync(
    path,
    writeZip([
      { name: '3D/3dmodel.model', data: MODEL },
      {
        name: 'Metadata/model_settings.config',
        data: `<?xml version="1.0" encoding="UTF-8"?><config><object id="1"><metadata key="name" value="tetra"/><metadata key="extruder" value="1"/></object><plate><metadata key="plater_id" value="1"/><metadata key="plater_name" value="Body"/><model_instance><metadata key="object_id" value="1"/></model_instance></plate><plate><metadata key="plater_id" value="2"/><metadata key="plater_name" value=""/></plate></config>`,
      },
      {
        name: 'Metadata/project_settings.config',
        data: JSON.stringify({
          printer_settings_id: 'Bambu Lab A1 0.4 nozzle',
          print_settings_id: '0.20mm Standard @BBL A1',
          filament_settings_id: ['Bambu PLA Basic @BBL A1', 'Bambu PETG HF @BBL A1'],
          filament_type: ['PLA', 'PETG'],
          filament_colour: ['#FF0000', '#00AE42'],
          layer_height: '0.24',
          post_process: ['/usr/bin/evil'],
          printhost_apikey: 'secret',
        }),
      },
    ]),
  )
  return path
}

describe('error codes for projects and output', () => {
  it('refuses a plate on a plain model and a .gcode.3mf from the stub engine', async () => {
    const h = await connect()
    expect(data<Err>(await h.call('slicerx_slice_file', { model: join(h.dir, 'cube.stl'), output: 'gcode.3mf' })).error.code).toBe('engine_unavailable')
    expect(data<Err>(await h.call('slicerx_estimate_file', { model: join(h.dir, 'cube.stl'), plate: 2 })).error.code).toBe('invalid_input')
  })
})

describe('3MF projects', () => {
  it('lists plates, presets and filament slots, and drops scripts and secrets', async () => {
    const h = await connect()
    const r = await h.call('slicerx_inspect_project', { file: projectFile(h.dir) })
    expect(r.isError, text(r)).toBeFalsy()
    const s = data<{ has_settings: boolean; plates: { index: number; name?: string; objects: number }[]; presets: { printer?: string; process?: string; filaments: string[] }; filaments: { slot: number; type?: string; color?: string }[]; dropped_keys: string[] }>(r)
    expect(s.has_settings).toBe(true)
    expect(s.plates).toEqual([{ index: 1, name: 'Body', objects: 1 }, { index: 2, objects: 0 }])
    expect(s.presets.printer).toBe('Bambu Lab A1 0.4 nozzle')
    expect(s.filaments).toEqual([
      { slot: 1, type: 'PLA', color: '#FF0000', preset: 'Bambu PLA Basic @BBL A1' },
      { slot: 2, type: 'PETG', color: '#00AE42', preset: 'Bambu PETG HF @BBL A1' },
    ])
    expect(s.dropped_keys).toEqual(['post_process', 'printhost_apikey'])
  })

  it('refuses a plate the project does not have', async () => {
    const h = await connect()
    const r = await h.call('slicerx_estimate_file', { model: projectFile(h.dir), plate: 3 })
    expect(data<Err>(r).error.code).toBe('no_such_plate')
    expect(text(r)).toMatch(/Plates: 1, 2/)
  })

  it('refuses a file that is not a 3MF package', async () => {
    const h = await connect()
    writeFileSync(join(h.dir, 'fake.3mf'), 'not a zip')
    expect(data<Err>(await h.call('slicerx_inspect_project', { file: join(h.dir, 'fake.3mf') })).error.code).toBe('invalid_model')
  })
})

describe('profiles', () => {
  it('lists and resolves the makers\' filament presets', async () => {
    const h = await connect()
    const list = data<{ profiles: { id: string; source: string }[] }>(await h.call('slicerx_list_profiles', { source: 'stock', query: 'Bambu PLA Basic @BBL A1', limit: 5 }))
    const id = list.profiles.find((p) => p.id.endsWith('Bambu PLA Basic @BBL A1'))?.id
    expect(id).toBe('stock-filament:BBL/Bambu PLA Basic @BBL A1')
    const p = data<{ config: Record<string, unknown> }>(await h.call('slicerx_get_profile', { profile: id }))
    expect(p.config['filament_type']).toEqual(['PLA'])
    const est = await h.call('slicerx_estimate_file', { model: join(h.dir, 'cube.stl'), profiles: [id!] })
    expect(est.isError, text(est)).toBeFalsy()
    expect(data<{ applied: string[] }>(est).applied).toEqual([id])
  })

  it("applies the user's own Bambu Studio presets, inherits resolved", async () => {
    const h = await connect()
    const file = join(h.dir, 'My PLA.json')
    writeFileSync(file, JSON.stringify({ name: 'My PLA', inherits: 'Bambu PLA Basic @BBL A1', filament_settings_id: ['My PLA'], nozzle_temperature: ['225'], post_process: ['rm -rf ~'] }))
    const r = await h.call('slicerx_estimate_file', { model: join(h.dir, 'cube.stl'), profile_files: [file] })
    expect(r.isError, text(r)).toBeFalsy()
    expect(data<{ applied: string[] }>(r).applied).toEqual(['filament-file:My PLA'])
    writeFileSync(join(h.dir, 'notes.json'), '{"hello": 1}')
    expect(data<Err>(await h.call('slicerx_estimate_file', { model: join(h.dir, 'cube.stl'), profile_files: [join(h.dir, 'notes.json')] })).error.code).toBe('invalid_input')
  })
})

describe('a filament per slot', () => {
  it('sets each slot from its own preset, file or color, and leaves the others', async () => {
    const h = await connect()
    const mine = join(h.dir, 'My PETG.json')
    writeFileSync(mine, JSON.stringify({ name: 'My PETG', inherits: 'Bambu PETG HF @BBL A1', filament_settings_id: ['My PETG'], nozzle_temperature: ['245'] }))
    const r = await h.call('slicerx_estimate_file', {
      model: join(h.dir, 'cube.stl'),
      profiles: ['stock-filament:BBL/Bambu PLA Basic @BBL A1'],
      filaments: [{ slot: 2, file: mine, color: '#00AE42' }, { slot: 3, profile: 'stock-filament:BBL/Bambu PETG HF @BBL A1' }],
    })
    expect(r.isError, text(r)).toBeFalsy()
    expect(data<{ applied: string[] }>(r).applied).toEqual(['stock-filament:BBL/Bambu PLA Basic @BBL A1', 'slot 2: filament-file:My PETG', 'slot 3: stock-filament:BBL/Bambu PETG HF @BBL A1'])
    const { resolveSliceConfig } = await import('../src/config')
    await h.ctx.profiles.prepare(['stock-filament:BBL/Bambu PLA Basic @BBL A1', 'stock-filament:BBL/Bambu PETG HF @BBL A1'])
    const petg = h.ctx.profiles.get('stock-filament:BBL/Bambu PETG HF @BBL A1')!
    const { config } = resolveSliceConfig(h.ctx.store, h.ctx.profiles, ['stock-filament:BBL/Bambu PLA Basic @BBL A1'], undefined, { slots: [{ slot: 2, name: petg.id, values: petg.config, color: '#00AE42', customGcode: false }] })
    expect(config['filament_type']).toEqual(['PLA', 'PETG'])
    expect(config['filament_colour']).toEqual(['#FFFFFF', '#00AE42'])
  })

  it('refuses a slot that is not a filament, named twice or empty', async () => {
    const h = await connect()
    const call = (filaments: unknown[]) => h.call('slicerx_estimate_file', { model: join(h.dir, 'cube.stl'), filaments })
    expect(data<Err>(await call([{ slot: 1, profile: 'process:standard' }])).error.code).toBe('invalid_input')
    expect(data<Err>(await call([{ slot: 1, color: '#ffffff' }, { slot: 1, color: '#000000' }])).error.code).toBe('invalid_input')
    expect(data<Err>(await call([{ slot: 1 }])).error.code).toBe('invalid_input')
    expect(data<Err>(await call([{ slot: 1, profile: 'stock-filament:BBL/No Such PLA' }])).error.code).toBe('unknown_profile')
  })
})

describe('the integrator kit as resources', () => {
  it('serves the agent guide and the quickstart', async () => {
    const h = await connect()
    const agents = await h.client.readResource({ uri: 'slicerx://docs/integrators/agents' })
    expect(JSON.stringify(agents.contents[0])).toMatch(/Rules that never change/)
    const quick = await h.client.readResource({ uri: 'slicerx://docs/integrators/quickstart' })
    expect(JSON.stringify(quick.contents[0])).toMatch(/## Error codes/)
  })
})

describe('progress', () => {
  it('reports stages when the client sends a progress token', async () => {
    const h = await connect()
    const seen: { progress: number; message?: string | undefined }[] = []
    const r = await h.client.callTool({ name: 'slicerx_slice_file', arguments: { model: join(h.dir, 'cube.stl') } }, CallToolResultSchema, { onprogress: (p) => seen.push(p) })
    expect(r.isError).toBeFalsy()
    expect(seen.map((p) => p.progress)).toEqual([0, 0.1, 0.2, 1])
    expect(seen.at(-1)?.message).toBe('Done')
  })
})

describe('.gcode.3mf', () => {
  it('moves the engine\'s thumbnails out of the G-code into plate pictures', () => {
    const png = (n: number) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(n)])
    const block = (w: number, b: Buffer) => `; THUMBNAIL_BLOCK_START\n; thumbnail begin ${w}x${w} ${b.toString('base64').length}\n; ${b.toString('base64')}\n; thumbnail end\n; THUMBNAIL_BLOCK_END\n\n`
    const body = 'G28\nG1 X10 E1\n'
    const summary: SliceSummary = { engine: 'sx', model: { name: 'cube' }, layer_count: 1, time_s: 1, time_text: '0m', filament_g: 1, filament_mm: 1, filaments: [], warnings: [] }
    const zip = readZip(gcode3mf(`; header\n${block(128, png(4))}${block(512, png(40))}${body}`, summary, {}))
    expect(zip.read('Metadata/plate_1.png')?.length).toBe(44)
    expect(zip.read('Metadata/plate_1_small.png')?.length).toBe(8)
    expect(zip.text('Metadata/plate_1.gcode')).not.toMatch(/thumbnail/i)
    expect(zip.text('Metadata/plate_1.gcode')).toMatch(/^; header\n\n?G28\n/)
    expect(zip.text('_rels/.rels')).toMatch(/cover-thumbnail-middle/)
    expect(zip.text('Metadata/model_settings.config')).toMatch(/thumbnail_file" value="Metadata\/plate_1.png"/)
  })

  it('packs the plate the way Bambu Lab printers read it', () => {
    const gcode = '; model label id: 101,102\nG28\nG1 X10 E1\n'
    const summary: SliceSummary = {
      engine: 'sx',
      model: { name: 'bracket.stl' },
      layer_count: 10,
      time_s: 600,
      time_text: '10m',
      filament_g: 3.5,
      filament_mm: 1200,
      filaments: [{ slot: 1, filament_mm: 1000, filament_g: 3 }, { slot: 2, filament_mm: 200, filament_g: 0.5 }],
      warnings: [],
    }
    const zip = readZip(gcode3mf(gcode, summary, { filament_type: ['PLA', 'PETG'], filament_colour: ['#ff0000', '#00ae42'], printer_model: 'Bambu Lab A1' }))
    expect(zip.text('Metadata/plate_1.gcode')).toBe(gcode)
    expect(zip.text('Metadata/plate_1.gcode.md5')).toBe(createHash('md5').update(gcode).digest('hex').toUpperCase())
    const info = zip.text('Metadata/slice_info.config') ?? ''
    expect(info).toMatch(/key="prediction" value="600"/)
    expect(info).toMatch(/key="printer_model_id" value="N2S"/)
    expect(info).toMatch(/<object identify_id="102"/)
    expect(info).toMatch(/<filament id="2" tray_info_idx="" type="PETG" color="#00AE42" used_m="0.20" used_g="0.50"/)
    expect(zip.text('Metadata/model_settings.config')).toMatch(/gcode_file" value="Metadata\/plate_1.gcode"/)
  })
})

// Runs only where the core has been built (cargo build -p sx-cli --release), or SLICERX_TEST_SX_BIN names a build.
const sxBin = process.env['SLICERX_TEST_SX_BIN'] ?? resolve(__dirname, '../../../target/release/sx')
const twoColor = resolve(__dirname, '../../core/bench/models/x-mark-2color.3mf')
describe.skipIf(!existsSync(sxBin))('with the real sx CLI', () => {
  it('slices one plate of a two-color project to a .gcode.3mf with use per filament', async () => {
    const h = await connect({ engine: 'sx', sxBin, allowDirs: [resolve(__dirname, '../../core/bench/models')] })
    const r = await h.call('slicerx_slice_file', { model: twoColor, plate: 1, project_settings: true, output: 'gcode.3mf', preview: true, overrides: { layer_height: 0.3 } })
    expect(r.isError, text(r)).toBeFalsy()
    const s = data<{ plate: number; filaments: { slot: number; filament_g: number }[]; gcode_3mf_path: string; gcode_sha256: string; preview_path: string }>(r)
    expect(s.plate).toBe(1)
    expect(s.filaments).toHaveLength(2)
    expect(s.filaments.every((f) => f.filament_g > 0)).toBe(true)
    expect(s.gcode_sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(existsSync(s.preview_path)).toBe(true)
    expect(readZip(readFileSync(s.gcode_3mf_path)).text('Metadata/slice_info.config')).toMatch(/<filament id="2"/)
  })

  it('writes a filament and color per slot into the .gcode.3mf', async () => {
    const h = await connect({ engine: 'sx', sxBin, allowDirs: [resolve(__dirname, '../../core/bench/models')] })
    const r = await h.call('slicerx_slice_file', {
      model: twoColor,
      plate: 1,
      profiles: ['machine:bambu-a1', 'process:standard'],
      filaments: [{ slot: 1, profile: 'stock-filament:BBL/Bambu PLA Basic @BBL A1', color: '#F4EE2A' }, { slot: 2, profile: 'stock-filament:BBL/Bambu PETG HF @BBL A1', color: '#00AE42' }],
      output: 'gcode.3mf',
    })
    expect(r.isError, text(r)).toBeFalsy()
    const info = readZip(readFileSync(data<{ gcode_3mf_path: string }>(r).gcode_3mf_path)).text('Metadata/slice_info.config') ?? ''
    expect(info).toMatch(/<filament id="1" tray_info_idx="" type="PLA" color="#F4EE2A"/)
    expect(info).toMatch(/<filament id="2" tray_info_idx="" type="PETG" color="#00AE42"/)
  })

  it("trusts the G-code a user's preset inherits from a shipped profile, not G-code of its own", async () => {
    const h = await connect({ engine: 'sx', sxBin })
    const mine = join(h.dir, 'My PETG.json')
    writeFileSync(mine, JSON.stringify({ name: 'My PETG', inherits: 'Bambu PETG HF @BBL A1', filament_settings_id: ['My PETG'], nozzle_temperature: ['245'] }))
    for (const args of [{ profile_files: [mine] }, { filaments: [{ slot: 1, file: mine }] }]) {
      const r = await h.call('slicerx_estimate_file', { model: join(h.dir, 'cube.stl'), profiles: ['machine:bambu-a1'], ...args })
      expect(r.isError, text(r)).toBeFalsy()
    }
    const own = join(h.dir, 'Odd PETG.json')
    writeFileSync(own, JSON.stringify({ name: 'Odd PETG', inherits: 'Bambu PETG HF @BBL A1', filament_settings_id: ['Odd PETG'], filament_start_gcode: ['M18'] }))
    const r = await h.call('slicerx_estimate_file', { model: join(h.dir, 'cube.stl'), profiles: ['machine:bambu-a1'], filaments: [{ slot: 1, file: own }] })
    expect(data<Err>(r).error.code).toBe('preflight_blocked')
  })

  it('slices for a Bambu Lab A1 with a stock filament and process preset', async () => {
    const h = await connect({ engine: 'sx', sxBin })
    const r = await h.call('slicerx_slice_file', { model: join(h.dir, 'cube.stl'), profiles: ['machine:bambu-a1', 'stock-filament:BBL/Bambu PLA Basic @BBL A1', 'process:standard'], output: 'gcode.3mf' })
    expect(r.isError, text(r)).toBeFalsy()
    const s = data<{ gcode_3mf_path: string; filament_g: number }>(r)
    expect(s.filament_g).toBeGreaterThan(0)
    const info = readZip(readFileSync(s.gcode_3mf_path)).text('Metadata/slice_info.config') ?? ''
    expect(info).toMatch(/key="printer_model_id" value="N2S"/)
    expect(info).toMatch(/type="PLA"/)
    const pic = readZip(readFileSync(s.gcode_3mf_path)).read('Metadata/plate_1.png')
    expect(pic?.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    expect(readZip(readFileSync(s.gcode_3mf_path)).text('Metadata/plate_1.gcode')).not.toMatch(/thumbnail begin/)
    // G-code from a tool call gets the strict checks, which the A1's own start G-code does not pass.
    const edited = await h.call('slicerx_estimate_file', { model: join(h.dir, 'cube.stl'), profiles: ['machine:bambu-a1'], overrides: { machine_end_gcode: 'M18' } })
    expect(data<Err>(edited).error.code).toBe('preflight_blocked')
    expect(text(edited)).toMatch(/safety preflight/)
  })
})
