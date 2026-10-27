// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What a PrusaSlicer project's own settings set when it opens, against the shared cases in
// fixtures/prusa-project-settings.json. sx-core (sx project-settings, sx slice <project.3mf>), the MCP server and the
// app's project open run the same cases, so a project slices the same in each.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import cases from '../fixtures/prusa-project-settings.json'
import mapJson from '../prusa-map.json'
import { prusaObjectOverrides, prusaProjectConfig, takesProjectValue } from './prusa'
import { settingDef } from './schema'
import { unzipForTest } from './testkit'

type Case = { name: string; files?: string[]; lines?: string[]; config: Record<string, unknown>; unmapped: string[] }

/** Each Slic3r_PE.config text a case stands for: its files' own, or its lines as a project writes them. */
function texts(c: Case): string[] {
  if (c.lines) return [c.lines.map((l) => `; ${l}`).join('\n')]
  return (c.files ?? []).map((f) => {
    const entry = unzipForTest(new Uint8Array(readFileSync(join(__dirname, '../fixtures', f)))).get('Metadata/Slic3r_PE.config')
    if (!entry) throw new Error(`${f} has no Slic3r_PE.config`)
    return new TextDecoder().decode(entry)
  })
}

describe('prusaProjectConfig', () => {
  for (const c of cases.cases as Case[]) {
    it(c.name, () => {
      for (const text of texts(c)) {
        const r = prusaProjectConfig(text)
        expect(r.config).toEqual(c.config)
        expect(r.unmapped).toEqual(c.unmapped)
      }
    })
  }

  it('sets only plain print and filament values', () => {
    for (const c of cases.cases as Case[]) {
      for (const [k, v] of Object.entries(c.config)) {
        expect(settingDef(k)?.section, k).not.toBe('printer')
        expect(takesProjectValue(k, v), k).toBe(true)
      }
    }
  })

  it('says which values it left out because they read differently here', () => {
    const r = prusaProjectConfig('; support_material_xy_spacing = 50%\n; filament_shrinkage_compensation_z = 0.5%')
    expect(r.notApplied.map((d) => [d.key, d.target])).toEqual([['filament_shrinkage_compensation_z', 'filament_shrinkage_compensation_z']])
    // A support XY spacing in percent is of the outer wall's width (1.125 x the default 0.4 nozzle here), so it carries over in mm.
    expect(r.config['support_object_xy_distance']).toBe('0.225')
  })

  it('keeps the filament colors apart from the settings', () => {
    const r = prusaProjectConfig('; filament_colour = #FF8000;#00AAFF\n; layer_height = 0.2')
    expect(r.colors).toEqual(['#FF8000', '#00AAFF'])
    expect(r.config).toEqual({ layer_height: '0.2' })
  })
})

describe('prusaObjectOverrides', () => {
  const project = ['layer_height = 0.1', 'perimeter_extrusion_width = 150%', 'external_perimeter_extrusion_width = 0.6', 'first_layer_extrusion_width = 200%'].map((l) => `; ${l}`).join('\n')

  it("takes the project's width percents of an object's own layer height", () => {
    const o = prusaObjectOverrides({ layer_height: '0.3' }, project)
    expect(o['inner_wall_line_width']).toBe('0.45')
    // The first layer width is the project's, and an outer wall in mm stays the project's.
    expect(o['initial_layer_line_width']).toBeUndefined()
    expect(o['outer_wall_line_width']).toBeUndefined()
  })

  it("takes an object's own percents of its layer height, else the project's", () => {
    expect(prusaObjectOverrides({ perimeter_extrusion_width: '250%' }, project)['inner_wall_line_width']).toBe('0.25')
    expect(prusaObjectOverrides({ support_material_xy_spacing: '150%' }, project)['support_object_xy_distance']).toBe('0.9')
    expect(prusaObjectOverrides({ support_material_xy_spacing: '100%', external_perimeter_extrusion_width: '200%', layer_height: '0.3' }, project)['support_object_xy_distance']).toBe('0.6')
  })

  it('leaves an object without its own layer height or width percents as before', () => {
    expect(prusaObjectOverrides({ perimeter_extrusion_width: '0.55' }, project)).toEqual({ inner_wall_line_width: '0.55' })
    expect(prusaObjectOverrides({ perimeters: '3' }, project)).toEqual({ wall_loops: '3' })
  })
})

describe('takesProjectValue', () => {
  it('reads its rule from prusa-map.json projectTakes, the table sx-core reads too', () => {
    const takes = (mapJson as { projectTakes: { sections: string[]; unread: string[] } }).projectTakes
    expect(takes.sections).toEqual(['process', 'filament'])
    for (const k of takes.unread) expect(takesProjectValue(k, '1')).toBe(false)
  })

  it('takes a text setting only when it fits its grammar on one line', () => {
    expect(takesProjectValue('sparse_infill_rotate_template', '0,90')).toBe(true)
    expect(takesProjectValue('sparse_infill_rotate_template', '0,90\n1')).toBe(false)
    expect(takesProjectValue('solid_infill_rotate_template', 'rm -rf')).toBe(false)
    expect(takesProjectValue('extra_solid_infills', '5#2')).toBe(true)
    expect(takesProjectValue('notes', 'hello')).toBe(false)
  })

  it('leaves a value that means unset', () => {
    expect(takesProjectValue('idle_temperature', 'nil')).toBe(false)
    expect(takesProjectValue('layer_height', '0.2')).toBe(true)
  })
})
