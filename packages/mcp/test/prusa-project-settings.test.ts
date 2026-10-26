// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A PrusaSlicer project's own settings (Metadata/Slic3r_PE.config) as readProjectFile reads them, against the shared
// cases in @slicerx/settings fixtures/prusa-project-settings.json that sx-core and the app run too. Then the T slab
// fixture slices the same moves through the MCP server as through `sx slice <project.3mf>`.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { importFlat } from '@slicerx/settings'
import { readProjectFile } from '../src/projectfile'
import { readZip, writeZip } from '../src/zip'
import { connect, data, noSx, sxBin, sxTimeout } from './helpers'

const fixtures = join(__dirname, '../../settings/fixtures')
type Case = { name: string; files?: string[]; lines?: string[]; config: Record<string, unknown>; unmapped: string[] }
const cases = (JSON.parse(readFileSync(join(fixtures, 'prusa-project-settings.json'), 'utf8')) as { cases: Case[] }).cases
const engineChoices = JSON.parse(readFileSync(join(__dirname, '../../settings/engine-choices.json'), 'utf8')) as Record<string, Record<string, unknown> | undefined>

const model = '<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><metadata name="Application">PrusaSlicer-2.9.6</metadata><resources><object id="1" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="20" y="0" z="0"/><vertex x="0" y="20" z="0"/><vertex x="0" y="0" z="10"/></vertices><triangles><triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/><triangle v1="1" v2="2" v3="3"/><triangle v1="2" v2="0" v3="3"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>'
const dir = mkdtempSync(join(tmpdir(), 'sx-prusa-project-'))
let n = 0
/** Each project a case stands for: its files, or one built from its lines as a project writes them. */
function projects(c: Case): string[] {
  if (!c.lines) return (c.files ?? []).map((f) => join(fixtures, f))
  const path = join(dir, `p${n++}.3mf`)
  writeFileSync(path, writeZip([{ name: '3D/3dmodel.model', data: model }, { name: 'Metadata/Slic3r_PE.config', data: c.lines.map((l) => `; ${l}`).join('\n') }]))
  return [path]
}

describe("readProjectFile and a PrusaSlicer project's settings", () => {
  for (const c of cases) {
    it(c.name, () => {
      for (const path of projects(c)) {
        const { config, summary } = readProjectFile(path)
        expect(summary.has_settings).toBe(true)
        // The case's values in schema shapes, as every project's config is given, and nothing else: no engine choices
        // or defaults, which the app does not add to a PrusaSlicer project either.
        expect(config).toEqual(importFlat(c.config).config)
        expect(summary.import_report.source).toBe('PrusaSlicer-2.9.6')
        expect(summary.import_report.unknown.map((u) => u.key)).toEqual(c.unmapped)
      }
    })
  }

  it('adds none of the engine choices or defaults', () => {
    const ours = [...Object.keys(engineChoices['keeps'] ?? {}), ...Object.keys(engineChoices['defaults'] ?? {})]
    expect(ours.length).toBeGreaterThan(0)
    const noGaps = cases.find((c) => c.name === 'support on without its gap settings')
    if (!noGaps) throw new Error('no case without support gaps')
    const { config } = readProjectFile(projects(noGaps)[0]!)
    for (const k of [...ours, 'support_top_z_distance', 'support_bottom_z_distance']) expect(config[k], k).toBeUndefined()
  })

  it('reports the values it left out and the filaments', () => {
    const { summary } = readProjectFile(join(fixtures, 'preset-files/prusaslicer-2.9.6-tslab.3mf'))
    expect(summary.import_report.invalid).toEqual([{ key: 'support_material_xy_spacing', value: '50%' }])
    expect(summary.filaments[0]?.type).toBe('PETG')
    expect(summary.support['enable_support']).toBe(true)
  })
})

/** The lines of a G-code file that print, without its comments. */
const moves = (gcode: string): string[] => gcode.split('\n').filter((l) => !l.startsWith(';') && l.trim() !== '')

describe.skipIf(noSx())('a PrusaSlicer project through the MCP server and sx slice', () => {
  it('prints the same moves, with its support', { timeout: sxTimeout * 3 }, async () => {
    const h = await connect({ engine: 'sx', sxBin })
    const path = join(h.dir, 'tslab.3mf')
    writeFileSync(path, readFileSync(join(fixtures, 'preset-files/prusaslicer-2.9.6-tslab.3mf')))
    const cli = spawnSync(sxBin, ['slice', path, '-o', join(h.dir, 'cli.gcode')], { encoding: 'utf8' })
    expect(cli.status, cli.stderr).toBe(0)
    const r = await h.call('slicerx_slice_file', { model: path, project_settings: true })
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy()
    const viaCli = readFileSync(join(h.dir, 'cli.gcode'), 'utf8')
    const viaMcp = readFileSync(String(data<{ gcode_path: string }>(r).gcode_path), 'utf8')
    expect(viaCli.split('\n').filter((l) => l === ';TYPE:Support').length).toBeGreaterThan(50)
    expect(moves(viaMcp)).toEqual(moves(viaCli))
  })

  it('prints the same support for a project without support gaps', { timeout: sxTimeout * 3 }, async () => {
    // The T slab with neither contact distance, on 0.12 mm layers: the gaps are the printer's, 0.2 mm in sx slice as in
    // the app, not one layer, which the engine gives a request that leaves them out.
    const h = await connect({ engine: 'sx', sxBin })
    const src = readZip(readFileSync(join(fixtures, 'preset-files/prusaslicer-2.9.6-tslab.3mf')), 'tslab')
    const config = src
      .text('Metadata/Slic3r_PE.config')!
      .split('\n')
      .filter((l) => !/^; support_material(_bottom)?_contact_distance = /.test(l))
      .map((l) => l.replace(/^; layer_height = .*/, '; layer_height = 0.12'))
      .join('\n')
    const path = join(h.dir, 'nogaps.3mf')
    writeFileSync(path, writeZip(src.names().map((n) => ({ name: n, data: n === 'Metadata/Slic3r_PE.config' ? config : src.read(n)! }))))
    const cli = spawnSync(sxBin, ['slice', path, '-o', join(h.dir, 'cli.gcode')], { encoding: 'utf8' })
    expect(cli.status, cli.stderr).toBe(0)
    const r = await h.call('slicerx_slice_file', { model: path, project_settings: true })
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy()
    const viaCli = readFileSync(join(h.dir, 'cli.gcode'), 'utf8')
    const viaMcp = readFileSync(String(data<{ gcode_path: string }>(r).gcode_path), 'utf8')
    const support = (g: string) => g.split('\n').filter((l) => l === ';TYPE:Support').length
    expect(support(viaCli)).toBeGreaterThan(50)
    expect(support(viaMcp)).toBe(support(viaCli))
    expect(moves(viaMcp)).toEqual(moves(viaCli))
  })
})
