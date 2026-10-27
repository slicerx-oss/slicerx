// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The keys a project read adds because the app that wrote the file reads them differently when they are missing
// (engine-choices.json fromApp in @slicerx/settings), and SlicerX's defaults for keys any project leaves out
// (engine-choices.json defaults), against the shared cases sx-core and the app run too. Then a bare Bambu Studio project
// slices with the same tower, and a project without support gaps with the same supports, through the MCP server as
// through `sx slice <project.3mf>`.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readProjectFile } from '../src/projectfile'
import { writeZip } from '../src/zip'
import { connect, data, noSx, sxBin, sxTimeout } from './helpers'

const cases = JSON.parse(readFileSync(join(__dirname, '../../settings/fixtures/project-defaults.json'), 'utf8')) as {
  cases: { name: string; application?: string; settings: Record<string, unknown>; added: Record<string, unknown>; defaults: Record<string, unknown> }[]
}
const choices = JSON.parse(readFileSync(join(__dirname, '../../settings/engine-choices.json'), 'utf8')) as { defaults?: Record<string, { value: unknown }> }
const table = (JSON.parse(readFileSync(join(__dirname, '../../settings/engine-choices.json'), 'utf8')) as { fromApp?: Record<string, Record<string, { value: unknown; unlessAny?: string[] }>> }).fromApp

const vertices = [[0, 0, 0], [20, 0, 0], [20, 20, 0], [0, 20, 0], [0, 0, 6], [20, 0, 6], [20, 20, 6], [0, 20, 6]]
// The fifth and sixth triangles (one side) are painted with filament 2, so every layer changes filament and the plate
// has a prime tower.
const triangles = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]]
const model = (app: string | undefined, paint = false) =>
  `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">${app ? `<metadata name="Application">${app}</metadata>` : ''}<resources><object id="1" type="model"><mesh><vertices>${vertices.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('')}</vertices><triangles>${triangles.map(([a, b, c], i) => `<triangle v1="${a}" v2="${b}" v3="${c}"${paint && (i === 4 || i === 5) ? ' paint_color="1C"' : ''}/>`).join('')}</triangles></mesh></object></resources><build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 118 118 0"/></build></model>`

const dir = mkdtempSync(join(tmpdir(), 'sx-project-defaults-'))
let n = 0
function project(app: string | undefined, settings: Record<string, unknown>, paint = false, into = dir): string {
  const path = join(into, `p${n++}.3mf`)
  writeFileSync(path, writeZip([{ name: '3D/3dmodel.model', data: model(app, paint) }, { name: 'Metadata/project_settings.config', data: JSON.stringify(settings) }]))
  return path
}
/** One setting value as text: `["500"]`, `"500"` and `500` alike. */
const one = (v: unknown): string | undefined => (v === undefined ? undefined : String(Array.isArray(v) ? v[0] : v))
/** The same, with a switch as 1 or 0: `true`, `"1"`. */
const flat = (v: unknown): string | undefined => ({ true: '1', false: '0' } as Record<string, string>)[one(v) ?? ''] ?? one(v)

describe("readProjectFile and the keys a project's app reads differently", () => {
  for (const c of cases.cases) {
    it(c.name, () => {
      const { config, summary } = readProjectFile(project(c.application, c.settings))
      for (const [k, v] of Object.entries(c.added)) expect(one(config[k]), k).toBe(one(v))
      // the table's other keys are the project's own, or not there when the project names none of them
      const rows = Object.values(table ?? {}).flatMap((t) => Object.entries(t))
      for (const [k, row] of rows) {
        if (k in c.added || k in c.settings || (row.unlessAny ?? []).some((u) => u in c.settings)) continue
        expect(config[k], k).toBeUndefined()
      }
      // SlicerX's defaults for the keys the project leaves out, whatever app wrote it; a key it sets stays its own
      for (const [k, v] of Object.entries(c.defaults)) expect(one(config[k]), k).toBe(one(v))
      for (const k of Object.keys(choices.defaults ?? {})) if (k in c.settings) expect(flat(config[k]), k).toBe(flat(c.settings[k]))
      expect(summary.unknown_keys).toEqual([])
    })
  }
})

describe('slicerx_inspect_project', () => {
  it('returns the settings a project slices with as project_config, with its app defaults', async () => {
    const h = await connect()
    const bare = cases.cases[0]
    if (!bare) throw new Error('no cases')
    const path = project(bare.application, bare.settings, false, h.dir)
    const r = data<{ project_config?: Record<string, unknown> }>(await h.call('slicerx_inspect_project', { file: path }))
    expect(r.project_config).toEqual(readProjectFile(path).config)
    expect(one(r.project_config?.['wipe_tower_wall_type'])).toBe('rib')
    // a plain 3MF has no settings, so no project_config
    const plain = join(h.dir, 'plain.3mf')
    writeFileSync(plain, writeZip([{ name: '3D/3dmodel.model', data: model(undefined) }]))
    expect(data<{ project_config?: unknown }>(await h.call('slicerx_inspect_project', { file: plain })).project_config).toBeUndefined()
  })
})

/** The X and Y size of the prime tower's extrusions from layer 2 up (2nd to 98th percentile), mm. */
function towerSize(gcode: string): { x: number; y: number } {
  let feature = ''
  let layer = 0
  let x: number | undefined
  let y: number | undefined
  const xs: number[] = []
  const ys: number[] = []
  for (const line of gcode.split('\n')) {
    if (line.startsWith('; FEATURE:')) feature = line.slice(10).trim()
    else if (line.startsWith('; CHANGE_LAYER')) layer++
    else if (/^G[123] /.test(line)) {
      const nx = /X(-?[\d.]+)/.exec(line)
      const ny = /Y(-?[\d.]+)/.exec(line)
      const e = / E(-?[\d.]+)/.exec(line)
      x = nx ? Number(nx[1]) : x
      y = ny ? Number(ny[1]) : y
      if (feature === 'Prime tower' && e && Number(e[1]) > 0 && layer >= 2 && x !== undefined && y !== undefined) {
        xs.push(x)
        ys.push(y)
      }
    }
  }
  const q = (a: number[], f: number) => a.sort((p, r) => p - r)[Math.floor(f * (a.length - 1))] ?? Number.NaN
  return { x: q(xs, 0.98) - q(xs, 0.02), y: q(ys, 0.98) - q(ys, 0.02) }
}
/** The config block's line for each key. */
const header = (gcode: string, keys: string[]) => Object.fromEntries(keys.map((k) => [k, new RegExp(`^; ${k} = (.*)$`, 'm').exec(gcode)?.[1]]))

describe.skipIf(noSx())('a bare Bambu Studio project through the MCP server and sx slice', () => {
  it('prints the same tower and the same Bambu Studio defaults', { timeout: sxTimeout * 3 }, async () => {
    const settings = {
      printer_model: 'Bambu Lab P1S',
      printable_area: ['0x0', '256x0', '256x256', '0x256'],
      filament_colour: ['#FFFFFF', '#FF0000'],
      nozzle_temperature: ['220', '220'],
      enable_prime_tower: '1',
      prime_tower_width: '35',
      brim_width: '0',
      skirt_loops: '0',
      layer_height: '0.2',
      initial_layer_print_height: '0.2',
    }
    const h = await connect({ engine: 'sx', sxBin })
    const path = project('BambuStudio-02.08.02.61', settings, true, h.dir)
    const cli = spawnSync(sxBin, ['slice', path, '--plate', '1', '-o', join(h.dir, 'cli.gcode')], { encoding: 'utf8' })
    expect(cli.status, cli.stderr).toBe(0)
    const r = await h.call('slicerx_slice_file', { model: path, plate: 1, project_settings: true })
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy()
    const viaCli = readFileSync(join(h.dir, 'cli.gcode'), 'utf8')
    const viaMcp = readFileSync(String(data<{ gcode_path: string }>(r).gcode_path), 'utf8')
    const keys = ['initial_layer_travel_acceleration', 'internal_bridge_speed', 'solid_infill_direction', 'wipe_tower_wall_type']
    expect(header(viaCli, ['wipe_tower_wall_type'])).toEqual({ wipe_tower_wall_type: 'rib' })
    expect(header(viaMcp, keys)).toEqual(header(viaCli, keys))
    const [a, b] = [towerSize(viaCli), towerSize(viaMcp)]
    expect(Math.abs(a.x - b.x), JSON.stringify({ cli: a, mcp: b })).toBeLessThan(0.5)
    expect(Math.abs(a.y - b.y), JSON.stringify({ cli: a, mcp: b })).toBeLessThan(0.5)
    // the keys checked are the table's
    expect(Object.keys(table?.['BambuStudio'] ?? {}).sort()).toEqual(keys)
  })
})

// A ledge: a 10 mm post with a 4 mm slab on top that overhangs it by 20 mm, 20 mm deep, so the slab needs supports.
const LEDGE = [[0, 0], [10, 0], [10, 10], [30, 10], [30, 14], [0, 14]]
function ledgeModel(app: string): string {
  const v = [...LEDGE.map(([x, z]) => [x!, 0, z!]), ...LEDGE.map(([x, z]) => [x!, 20, z!])]
  let t: number[][] = []
  for (const [a, b, c] of [[0, 1, 2], [0, 2, 5], [2, 3, 4], [2, 4, 5]] as const) t.push([a, b, c], [c + 6, b + 6, a + 6])
  for (let i = 0; i < 6; i++) {
    const j = (i + 1) % 6
    t.push([i, j, j + 6], [i, j + 6, i + 6])
  }
  // Outward normals: flip every triangle if the signed volume comes out negative.
  const vol = t.reduce((s, [a, b, c]) => {
    const [p, q, r] = [v[a!]!, v[b!]!, v[c!]!]
    return s + p[0]! * (q[1]! * r[2]! - r[1]! * q[2]!) - p[1]! * (q[0]! * r[2]! - r[0]! * q[2]!) + p[2]! * (q[0]! * r[1]! - r[0]! * q[1]!)
  }, 0)
  if (vol < 0) t = t.map(([a, b, c]) => [a!, c!, b!])
  return `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><metadata name="Application">${app}</metadata><resources><object id="1" type="model"><mesh><vertices>${v.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('')}</vertices><triangles>${t.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('')}</triangles></mesh></object></resources><build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 110 118 0"/></build></model>`
}
const LEDGE_PLATE = '<?xml version="1.0" encoding="UTF-8"?><config><object id="1"><metadata key="name" value="ledge"/><metadata key="extruder" value="1"/></object><plate><metadata key="plater_id" value="1"/><model_instance><metadata key="object_id" value="1"/></model_instance></plate></config>'
/** The G-code without its header and config blocks, which say how it was made rather than what it prints. */
const body = (gcode: string) => gcode.replace(/; HEADER_BLOCK_START\n[\s\S]*?; HEADER_BLOCK_END\n/, '').replace(/; CONFIG_BLOCK_START\n[\s\S]*?; CONFIG_BLOCK_END\n/, '')

describe.skipIf(noSx())('a project without support gaps through the MCP server and sx slice', () => {
  it('prints 0.12 mm layers with the same 0.2 mm support gaps either way', { timeout: sxTimeout * 3 }, async () => {
    const settings = {
      printer_model: 'Bambu Lab P1S',
      printable_area: ['0x0', '256x0', '256x256', '0x256'],
      filament_colour: ['#FFFFFF'],
      nozzle_temperature: ['245'],
      nozzle_temperature_initial_layer: ['250'],
      enable_support: '1',
      support_type: 'normal(auto)',
      brim_width: '0',
      skirt_loops: '0',
      layer_height: '0.12',
      initial_layer_print_height: '0.2',
    }
    const h = await connect({ engine: 'sx', sxBin })
    const path = join(h.dir, 'ledge.3mf')
    writeFileSync(path, writeZip([{ name: '3D/3dmodel.model', data: ledgeModel('BambuStudio-02.08.02.61') }, { name: 'Metadata/model_settings.config', data: LEDGE_PLATE }, { name: 'Metadata/project_settings.config', data: JSON.stringify(settings) }]))
    const cli = spawnSync(sxBin, ['slice', path, '--plate', '1', '-o', join(h.dir, 'cli.gcode')], { encoding: 'utf8' })
    expect(cli.status, cli.stderr).toBe(0)
    const r = await h.call('slicerx_slice_file', { model: path, plate: 1, project_settings: true })
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy()
    const viaCli = readFileSync(join(h.dir, 'cli.gcode'), 'utf8')
    const viaMcp = readFileSync(String(data<{ gcode_path: string }>(r).gcode_path), 'utf8')
    const gaps = ['support_top_z_distance', 'support_bottom_z_distance']
    expect(header(viaCli, gaps)).toEqual({ support_top_z_distance: '0.2', support_bottom_z_distance: '0.2' })
    expect(header(viaMcp, gaps)).toEqual(header(viaCli, gaps))
    // the supports are there, and every printed line is the same
    expect(viaCli).toMatch(/^; FEATURE: Support/m)
    const [a, b] = [body(viaCli).split('\n'), body(viaMcp).split('\n')]
    const at = a.findIndex((line, i) => line !== b[i])
    expect(at === -1 && a.length === b.length, `bodies differ at line ${at + 1}: ${a[at]} | ${b[at]} (${a.length} vs ${b.length} lines)`).toBe(true)
  })
})
