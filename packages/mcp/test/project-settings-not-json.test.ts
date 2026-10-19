// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A project whose Metadata/project_settings.config is not a JSON object of settings still opens and slices: an empty
// one is as if it were missing, JSON after a byte order mark is read, and INI style lines or a damaged file are left
// out with the reason in the import report. strict_settings refuses the ones left out.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { projectSettingsOf, readProjectFile } from '../src/projectfile'
import { writeZip } from '../src/zip'
import { connect, data, noSx, sxBin, sxTimeout, text } from './helpers'

const MODEL = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="20" y="0" z="0"/><vertex x="20" y="20" z="0"/><vertex x="0" y="20" z="0"/><vertex x="0" y="0" z="10"/><vertex x="20" y="0" z="10"/><vertex x="20" y="20" z="10"/><vertex x="0" y="20" z="10"/></vertices><triangles><triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="3" v3="2"/><triangle v1="4" v2="5" v3="6"/><triangle v1="4" v2="6" v3="7"/><triangle v1="0" v2="1" v3="5"/><triangle v1="0" v2="5" v3="4"/><triangle v1="1" v2="2" v3="6"/><triangle v1="1" v2="6" v3="5"/><triangle v1="2" v2="3" v3="7"/><triangle v1="2" v2="7" v3="6"/><triangle v1="3" v2="0" v3="4"/><triangle v1="3" v2="4" v3="7"/></triangles></mesh></object></resources><build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 128 128 0"/></build></model>`

const JSON_SETTINGS = '{\n  "layer_height": "0.3",\n  "initial_layer_print_height": "0.3"\n}\n'
const INI = '; an older export\n\nlayer_height = 0.3\ninitial_layer_print_height = 0.3\nnozzle_diameter = 0.4,0.4\n'

function project(dir: string, name: string, settings: string | Buffer): string {
  const path = join(dir, name)
  writeFileSync(path, writeZip([{ name: '3D/3dmodel.model', data: MODEL }, { name: 'Metadata/project_settings.config', data: settings }]))
  return path
}

const LEFT_OUT = "so the project's print settings were left out"

describe('project settings that are not JSON', () => {
  it('read as missing when empty or white space', () => {
    for (const blank of ['', '  \r\n\t\n ', '\uFEFF', '\uFEFF \n']) expect(projectSettingsOf('p.3mf', blank), JSON.stringify(blank)).toEqual({})
    expect(projectSettingsOf('p.3mf', undefined)).toEqual({})
  })

  it('read JSON after a byte order mark', () => {
    expect(projectSettingsOf('p.3mf', `\uFEFF${JSON_SETTINGS}`)).toEqual({ raw: { layer_height: '0.3', initial_layer_print_height: '0.3' } })
  })

  it('leave INI style lines and damaged files out, with the reason', () => {
    expect(projectSettingsOf('p.3mf', INI)).toEqual({ skipped: `p.3mf: Metadata/project_settings.config holds INI style settings (key = value lines), not JSON, ${LEFT_OUT}` })
    for (const bad of [JSON_SETTINGS.slice(0, 30), 'nope', '\u0000\u0001 not settings �']) {
      const s = projectSettingsOf('p.3mf', bad).skipped
      expect(s, bad).toMatch(/^p\.3mf: Metadata\/project_settings\.config is not JSON \(.+\), so the project's print settings were left out$/)
    }
    for (const notObject of ['[1, 2]', 'null', '"0.2"']) expect(projectSettingsOf('p.3mf', notObject).skipped, notObject).toContain('is JSON but not an object of settings')
  })

  it('open as a project without settings, the reason in the import report', async () => {
    const h = await connect()
    const empty = readProjectFile(project(h.dir, 'empty.3mf', ''))
    expect(empty.summary.has_settings).toBe(false)
    expect(empty.summary.import_report.skipped).toBeUndefined()
    const bom = readProjectFile(project(h.dir, 'bom.3mf', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON_SETTINGS)])))
    expect(bom.summary.has_settings).toBe(true)
    expect(bom.config['layer_height']).toBe(0.3)
    for (const [name, settings] of [['ini.3mf', INI], ['cut.3mf', JSON_SETTINGS.slice(0, 30)], ['junk.3mf', Buffer.from([0, 1, 0xff, 0x20, 0x7b])]] as const) {
      const read = readProjectFile(project(h.dir, name, settings))
      expect(read.summary.has_settings, name).toBe(false)
      expect(read.config, name).toEqual({})
      expect(read.summary.import_report.skipped, name).toContain(`${name}: Metadata/project_settings.config`)
    }
  })

  it('inspect without an error and say why the settings were left out', async () => {
    const h = await connect()
    const r = await h.call('slicerx_inspect_project', { file: project(h.dir, 'ini.3mf', INI) })
    expect(r.isError, text(r)).toBeFalsy()
    expect(text(r)).toContain(`Settings: ini.3mf: Metadata/project_settings.config holds INI style settings (key = value lines), not JSON, ${LEFT_OUT}`)
    expect(text(r)).not.toContain('a plain 3MF')
    expect(data<{ has_settings: boolean }>(r).has_settings).toBe(false)
    const blank = await h.call('slicerx_inspect_project', { file: project(h.dir, 'blank.3mf', '\n') })
    expect(blank.isError, text(blank)).toBeFalsy()
    expect(text(blank)).toContain('no print settings (a plain 3MF)')
  })
})

describe.skipIf(noSx())('project settings that are not JSON, with the real sx CLI', () => {
  it('slice with the other settings, and strict_settings refuses them', { timeout: sxTimeout }, async () => {
    const h = await connect({ engine: 'sx', sxBin })
    const ini = project(h.dir, 'ini.3mf', INI)
    const r = await h.call('slicerx_slice_file', { model: ini, project_settings: true, project_gcode: 'profile' })
    expect(r.isError, text(r)).toBeFalsy()
    expect(text(r)).toContain(`Project settings: ini.3mf: Metadata/project_settings.config holds INI style settings`)
    expect(data<{ import_report: { skipped?: string } }>(r).import_report.skipped).toContain(LEFT_OUT)
    const strict = await h.call('slicerx_slice_file', { model: ini, project_settings: true, project_gcode: 'profile', strict_settings: true })
    expect(strict.isError).toBe(true)
    expect(text(strict)).toContain('project_settings_unused')
    expect(text(strict)).toContain('INI style settings')
    // An empty settings file slices as a plain 3MF does, and JSON after a byte order mark keeps its 0.3 mm layers.
    const empty = await h.call('slicerx_slice_file', { model: project(h.dir, 'empty.3mf', ''), project_settings: true, project_gcode: 'profile' })
    expect(empty.isError, text(empty)).toBeFalsy()
    const bom = await h.call('slicerx_slice_file', { model: project(h.dir, 'bom.3mf', `\uFEFF${JSON_SETTINGS}`), project_settings: true, project_gcode: 'profile' })
    expect(bom.isError, text(bom)).toBeFalsy()
    expect(data<{ layer_count: number }>(bom).layer_count).toBe(33)
  })
})
