// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as pilot from '@slicerx/pilot'
import { listPrinterProfiles } from '@slicerx/settings'
import { boxStl, connect, data, text } from './helpers'

const hasRegistry = typeof (pilot as unknown as Record<string, unknown>)['builtinTools'] === 'function'

describe('tool list', () => {
  it('registers file, settings, knowledge, project, printer and approval tools', async () => {
    const { client } = await connect()
    const names = (await client.listTools()).tools.map((t) => t.name)
    expect(names).toEqual(
      expect.arrayContaining([
        'slicerx_slice_file',
        'slicerx_estimate_file',
        'slicerx_plan_settings',
        'slicerx_validate_config',
        'slicerx_project_open',
        'slicerx_project_add_model',
        'slicerx_project_set_overrides',
        'slicerx_printer_list',
        'slicerx_printer_status',
        'slicerx_printer_set_temperature',
        'slicerx_printer_filament',
        'slicerx_printer_gcode',
        'slicerx_printer_snapshot',
        'slicerx_approve',
        'slicerx_get_policy',
        'slicerx_action_log',
      ]),
    )
  })

  it('marks hardware tools destructive and explains the permission class', async () => {
    const { client } = await connect()
    const tool = (await client.listTools()).tools.find((t) => t.name === 'slicerx_printer_set_temperature')
    expect(tool?.annotations?.destructiveHint).toBe(true)
    expect(tool?.annotations?.readOnlyHint).toBe(false)
    expect(tool?.description).toMatch(/Permission class: start/)
  })

  it('drops printer tools with printers off', async () => {
    const { client } = await connect({ printers: 'off' })
    const names = (await client.listTools()).tools.map((t) => t.name)
    const printerTools = ['slicerx_printer_list', 'slicerx_printer_queue', 'slicerx_printer_pause', 'slicerx_printer_gcode', 'slicerx_printer_snapshot', 'slicerx_list_fleets']
    expect(names.filter((n) => printerTools.includes(n))).toEqual([])
  })

  it('keeps tool names unique', async () => {
    const { client } = await connect()
    const names = (await client.listTools()).tools.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
    expect(names).toContain('slicerx_printer_status')
  })

  it('gives every tool a description', async () => {
    const { client } = await connect()
    for (const t of (await client.listTools()).tools) expect(t.description?.length ?? 0, t.name).toBeGreaterThan(30)
  })
})

describe('slicing with the stub engine', () => {
  it('estimates a 20 mm cube', async () => {
    const h = await connect()
    const r = await h.call('slicerx_estimate_file', { model: join(h.dir, 'cube.stl'), profiles: ['printer:bambu_x1c', 'filament:pla'] })
    expect(r.isError).toBeFalsy()
    const s = data<{ engine: string; layer_count: number; filament_g: number; time_s: number; gcode_path?: string }>(r)
    expect(s.engine).toBe('stub')
    expect(s.layer_count).toBe(100)
    expect(s.filament_g).toBeGreaterThan(1)
    expect(s.filament_g).toBeLessThan(10)
    expect(s.time_s).toBeGreaterThan(0)
    expect(s.gcode_path).toBeUndefined()
  })

  it('writes a marked, unprintable G-code file on slice and honors overrides', async () => {
    const h = await connect()
    const r = await h.call('slicerx_slice_file', { model: join(h.dir, 'cube.stl'), overrides: { layer_height: 0.1, initial_layer_print_height: 0.1 } })
    const s = data<{ layer_count: number; gcode_path: string }>(r)
    expect(s.layer_count).toBe(200)
    expect(readFileSync(s.gcode_path, 'utf8')).toContain('SLICERX_STUB_OUTPUT')
    expect(text(r)).toContain('G-code:')
  })

  it('rejects invalid overrides before slicing', async () => {
    const h = await connect()
    const r = await h.call('slicerx_slice_file', { model: join(h.dir, 'cube.stl'), overrides: { layer_height: 5, not_a_key: 1 } })
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/layer height/i)
    expect(text(r)).toMatch(/not_a_key/)
  })

  it('refuses paths outside the allowed directories', async () => {
    const h = await connect()
    const r = await h.call('slicerx_estimate_file', { model: process.execPath })
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/outside the directories/)
  })

  it('refuses unknown profiles and non-model files', async () => {
    const h = await connect()
    writeFileSync(join(h.dir, 'notes.txt'), 'hello')
    expect(text(await h.call('slicerx_estimate_file', { model: join(h.dir, 'cube.stl'), profiles: ['printer:nope'] }))).toMatch(/No profile/)
    expect(text(await h.call('slicerx_estimate_file', { model: join(h.dir, 'notes.txt') }))).toMatch(/Unsupported model type/)
  })

  it('refuses URLs when started with --no-urls', async () => {
    const h = await connect({ allowUrls: false })
    const r = await h.call('slicerx_estimate_file', { model: 'https://example.com/cube.stl' })
    expect(text(r)).toMatch(/--no-urls/)
  })

  it('reports a missing engine instead of guessing when engine is sx', async () => {
    const h = await connect({ engine: 'sx', sxBin: '/nonexistent/sx' })
    const r = await h.call('slicerx_estimate_file', { model: join(h.dir, 'cube.stl') })
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/sx CLI was not found/)
  })
})

describe('profiles', () => {
  it('lists knowledge printers, filaments and intents with pagination', async () => {
    const h = await connect()
    const all = data<{ total: number; has_more: boolean }>(await h.call('slicerx_list_profiles', { limit: 5 }))
    expect(all.total).toBeGreaterThan(40)
    expect(all.has_more).toBe(true)
    const fil = data<{ profiles: { id: string }[] }>(await h.call('slicerx_list_profiles', { section: 'filament', limit: 200 }))
    expect(fil.profiles.map((p) => p.id)).toContain('filament:petg')
    const bambu = data<{ profiles: { vendor?: string }[] }>(await h.call('slicerx_list_profiles', { vendor: 'bambu', section: 'printer', limit: 200 }))
    expect(bambu.profiles.length).toBeGreaterThan(5)
    expect(bambu.profiles.every((p) => p.vendor === 'Bambu Lab')).toBe(true)
  })

  it('returns filament values in schema shapes', async () => {
    const h = await connect()
    const p = data<{ config: Record<string, unknown> }>(await h.call('slicerx_get_profile', { profile: 'filament:petg' }))
    expect(p.config['nozzle_temperature']).toEqual([245])
    expect(p.config['filament_type']).toEqual(['PETG'])
  })

  it('finds a printer by loose name and converts percent strings', async () => {
    const h = await connect()
    const p = data<{ id: string; config: Record<string, unknown> }>(await h.call('slicerx_get_profile', { profile: 'Bambu Lab X1 Carbon' }))
    expect(p.id).toBe('printer:bambu_x1c')
    expect(p.config['sparse_infill_density']).toBe(15)
    expect(p.config['printable_height']).toBe(250)
  })
})

describe('settings tools', () => {
  it('plans a PLA to PETG switch with reasons and sources', async () => {
    const h = await connect()
    const plan = data<{ changes: { key: string; before: unknown; after: unknown; reason: string; sources: string[] }[]; config_patch: Record<string, unknown> }>(
      await h.call('slicerx_plan_settings', { from_filament: 'pla', filament: 'PETG', printer: 'bambu_x1c' }),
    )
    const temp = plan.changes.find((c) => c.key === 'nozzle_temperature')
    expect(temp?.after).toEqual([245])
    expect(temp?.reason).toMatch(/PETG/)
    expect(temp?.sources.some((s) => s.startsWith('knowledge:filaments/petg'))).toBe(true)
    expect(plan.config_patch['filament_type']).toEqual(['PETG'])
    for (const c of plan.changes) expect(c.reason.length, c.key).toBeGreaterThan(5)
  })

  it('maps a free-text intent to an Easy goal', async () => {
    const h = await connect()
    const plan = data<{ intent_goal: string; changes: { key: string }[] }>(await h.call('slicerx_plan_settings', { intent: 'a strong functional bracket' }))
    expect(plan.intent_goal).toBe('strong')
    expect(plan.changes.map((c) => c.key)).toContain('wall_loops')
  })

  it('flags an abrasive filament and unknown names', async () => {
    const h = await connect()
    const plan = data<{ unresolved: { reason: string }[] }>(await h.call('slicerx_plan_settings', { filament: 'pa_cf', printer: 'nope printer' }))
    expect(plan.unresolved.some((u) => /No printer named/.test(u.reason))).toBe(true)
  })

  it('needs at least one target', async () => {
    const h = await connect()
    expect((await h.call('slicerx_plan_settings', {})).isError).toBe(true)
  })

  it('explains a setting and suggests keys for a typo', async () => {
    const h = await connect()
    const s = data<{ label: string; unit: string; summary: string; effect: { increase: string } }>(await h.call('slicerx_explain_setting', { key: 'sparse_infill_density' }))
    expect(s.label).toMatch(/infill/i)
    expect(s.summary).toMatch(/percent/)
    expect(s.effect.increase).toMatch(/strength/)
    const miss = await h.call('slicerx_explain_setting', { key: 'infill_density' })
    expect(miss.isError).toBe(true)
    expect(text(miss)).toMatch(/sparse_infill_density/)
  })

  it('finds settings by words', async () => {
    const h = await connect()
    const r = data<{ settings: { key: string }[] }>(await h.call('slicerx_find_settings', { query: 'seam position' }))
    expect(r.settings[0]?.key).toBe('seam_position')
  })

  it('validates types, limits, cross-key rules and material temperature', async () => {
    const h = await connect()
    const r = data<{ valid: boolean; issues: { code: string; severity: string }[] }>(
      await h.call('slicerx_validate_config', {
        config: { layer_height: 0.36, nozzle_diameter: [0.4], wall_loops: 2.5, seam_position: 'sideways', fan_min_speed: [80], fan_max_speed: [40], filament_type: ['PETG'], nozzle_temperature: [200], layer_heigth: 0.2 },
      }),
    )
    const codes = r.issues.map((i) => i.code)
    expect(r.valid).toBe(false)
    expect(codes).toEqual(expect.arrayContaining(['layer_over_75pct', 'wrong_type', 'bad_enum', 'fan_order', 'temp_outside_material', 'unknown_key']))
    expect(r.issues.find((i) => i.code === 'unknown_key')?.severity).toBe('warning')
    expect(r.issues[0]?.severity).toBe('error')
  })

  it('accepts a clean config', async () => {
    const h = await connect()
    const r = data<{ valid: boolean; issues: unknown[] }>(await h.call('slicerx_validate_config', { config: { layer_height: 0.2, wall_loops: 3, sparse_infill_density: 20 }, nozzle_diameter: 0.4 }))
    expect(r.valid).toBe(true)
    expect(r.issues).toEqual([])
  })
})

describe('knowledge', () => {
  it('looks up entries by alias and lists a kind', async () => {
    const h = await connect()
    const e = data<{ id: string; uri: string }>(await h.call('slicerx_knowledge_lookup', { kind: 'troubleshoot', id: 'cobwebs' }))
    expect(e.id).toBe('stringing')
    expect(e.uri).toBe('slicerx://knowledge/troubleshoot/stringing')
    const list = data<{ count: number }>(await h.call('slicerx_knowledge_lookup', { kind: 'filament' }))
    expect(list.count).toBeGreaterThanOrEqual(20)
  })

  it('serves knowledge and settings as resources', async () => {
    const { client } = await connect()
    const list = await client.listResources()
    const uris = list.resources.map((r) => r.uri)
    expect(uris).toContain('slicerx://knowledge/filament/petg')
    expect(uris).toContain('slicerx://settings/schema')
    const read = await client.readResource({ uri: 'slicerx://knowledge/filament/petg' })
    const first = read.contents[0]
    expect(first && 'text' in first ? first.text : '').toContain('kind: filament')
  })

  it('serves the guide to building on the engine', async () => {
    const { client } = await connect()
    const uris = (await client.listResources()).resources.map((r) => r.uri)
    expect(uris).toContain('slicerx://docs/build-on-the-engine')
    const read = await client.readResource({ uri: 'slicerx://docs/build-on-the-engine' })
    const first = read.contents[0]
    const body = first && 'text' in first ? first.text : ''
    expect(body).toContain('shape.extrude')
    expect(body).toContain('Made possible by SlicerX')
  })
})

describe('printers (demo fleet)', () => {
  it('lists printers and reads status', async () => {
    const h = await connect()
    const list = data<Record<string, unknown>>(await h.call('slicerx_printer_list'))
    expect(JSON.stringify(list)).toContain('bay-1')
    const st = await h.call('slicerx_printer_status', { printerId: 'bay-1' })
    expect(text(st)).toContain('printing')
  })

  it('manages fleets without approval and logs each edit', async () => {
    const h = await connect()
    const list = data<{ fleets: { id: string; printerIds: string[] }[] }>(await h.call('slicerx_list_fleets'))
    expect(list.fleets.find((f) => f.id === 'workshop')?.printerIds).toContain('bay-1')
    const made = data<{ result: { id: string; name: string } }>(await h.call('slicerx_create_fleet', { name: 'Resin corner', printer_ids: ['bay-4'] }))
    expect(made.result.name).toBe('Resin corner')
    const added = data<{ result: { printerIds: string[] } }>(await h.call('slicerx_add_to_fleet', { fleet_id: made.result.id, printer_id: 'bay-5' }))
    expect(added.result.printerIds).toEqual(['bay-4', 'bay-5'])
    const dup = await h.call('slicerx_create_fleet', { name: 'resin CORNER' })
    expect(dup.isError).toBe(true)
    await h.call('slicerx_delete_fleet', { fleet_id: made.result.id })
    const after = data<{ fleets: { id: string }[] }>(await h.call('slicerx_list_fleets'))
    expect(after.fleets.map((f) => f.id)).not.toContain(made.result.id)
    expect(h.ctx.gate.log.recent(10).map((e) => e.tool)).toEqual(expect.arrayContaining(['fleet.create', 'fleet.add', 'fleet.delete']))
    const st = await h.call('slicerx_printer_status', { printerId: 'bay-4' })
    expect(st.isError).toBeFalsy()
  })

  it('returns a camera snapshot as an image', async () => {
    const h = await connect()
    const r = await h.call('slicerx_printer_snapshot', { printer_id: 'bay-1' })
    expect(r.content[0]?.type).toBe('image')
  })
})

describe('SlicerX printer profiles and process presets', () => {
  it('lists a profile for every catalog model and returns its settings', async () => {
    const h = await connect()
    const list = data<{ total: number }>(await h.call('slicerx_list_profiles', { query: 'machine:', limit: 1 }))
    expect(list.total).toBe(listPrinterProfiles().length)
    expect(list.total).toBeGreaterThanOrEqual(57)
    const p = data<{ config: Record<string, unknown> }>(await h.call('slicerx_get_profile', { profile: 'machine:bambu-x1-carbon' }))
    expect(p.config['gcode_flavor']).toBe('marlin')
    const q = data<{ config: Record<string, unknown> }>(await h.call('slicerx_get_profile', { profile: 'process:standard' }))
    expect(q.config['layer_height']).toBe(0.2)
  })
})

describe('theming', () => {
  it('returns a built-in theme with a stylesheet and passing contrast', async () => {
    const h = await connect()
    const t = data<{ theme: { name: string }; css: string; contrast: { ok: boolean | null }[] }>(await h.call('slicerx_theme_get', { name: 'nocturne' }))
    expect(t.theme.name).toBe('nocturne')
    expect(t.css).toContain('--purple')
    expect(t.contrast.filter((c) => c.ok === false)).toEqual([])
  })

  it('builds and saves a brand theme and flags unreadable colors', async () => {
    const h = await connect()
    const r = await h.call('slicerx_theme_create', {
      base: 'nocturneLight',
      overrides: { name: 'acme', colors: { purple: '#2f6df6', onGrad: '#ffffff' }, fonts: { body: '"Inter", sans-serif' } },
      selector: '[data-sx-theme="acme"]',
      save: true,
    })
    const out = data<{ theme: { colors: { purple: string }; fonts: { body: string } }; css: string; files: { json: string; css: string } }>(r)
    expect(out.theme.colors.purple).toBe('#2f6df6')
    expect(out.css).toContain('[data-sx-theme="acme"]')
    expect(readFileSync(out.files.css, 'utf8')).toContain('#2f6df6')
    const bad = await h.call('slicerx_theme_create', { overrides: { name: 'murky', colors: { fg: '#333333' } } })
    expect(text(bad)).toMatch(/below the minimum/)
  })

  it('rejects unknown theme keys', async () => {
    const h = await connect()
    const r = await h.call('slicerx_theme_create', { overrides: { colours: { purple: '#000' } } })
    expect(r.isError).toBe(true)
  })
})

describe('sample models', () => {
  it('estimates a built-in test cube without a file', async () => {
    const h = await connect()
    const s = data<{ layer_count: number; model: { name: string } }>(await h.call('slicerx_estimate_file', { model: 'sample:cube-20' }))
    expect(s.layer_count).toBe(100)
    expect(s.model.name).toBe('cube-20.stl')
    expect(text(await h.call('slicerx_estimate_file', { model: 'sample:dragon' }))).toMatch(/No sample model/)
  })
})

describe('project rotation and added objects', () => {
  it('rotates an object so its footprint and plate transform follow, and adds generated objects on new plates', async () => {
    const { McpProject } = await import('../src/project')
    const { ProfileCatalog } = await import('../src/profiles')
    const { DataStore, resolveDataPaths } = await import('../src/data')
    const { createNodeSlicerHost } = await import('../src/slicerhost')
    const { createStubSlicer } = await import('../src/slicer')
    const { readStlPositions } = await import('../src/mesh')
    const store = new DataStore(resolveDataPaths())
    const host = createNodeSlicerHost(createStubSlicer(), '/tmp/slicerx-mcp-test-rotation')
    const project = new McpProject({ name: 'Tower', profiles: [], printer: 'bambu_p1s' }, store, new ProfileCatalog(store), host)
    const positions = readStlPositions(boxStl(20, 20, 60))
    const handle = await host.loadParts('tower', [{ name: 'tower', slot: 1, positions, indices: Uint32Array.from({ length: positions.length / 3 }, (_, i) => i) }])
    project.addMesh(handle.id, 'tower', handle.bboxMm, handle.triangles, 1)
    const id = project.objects()[0]?.id ?? ''
    project.setRotation(id, [90, 0, 0])
    expect(project.objects()[0]?.bboxMm).toEqual([20, 60, 20])
    const plate = await project.plate(1)
    const t = plate.objects[0]?.transform ?? []
    expect(t[10]).toBeCloseTo(0)
    expect(t[14]).toBeCloseTo(0)

    await project.addObject({ id: 'cal', name: 'calibration cube', bboxMm: [0, 0, 0] }, [{ name: 'cube', slot: 1, positions: readStlPositions(boxStl(10, 10, 10)), indices: Uint32Array.from({ length: 36 }, (_, i) => i) }])
    expect(project.plates().map((p) => p.index)).toEqual([1, 2])
    expect(project.objects().find((o) => o.id === 'cal')?.bboxMm).toEqual([10, 10, 10])
  })
})
