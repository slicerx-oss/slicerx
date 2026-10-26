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
import { prusaProjectConfig, takesProjectValue } from './prusa'
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
    expect(r.notApplied.map((d) => [d.key, d.target])).toEqual([
      ['filament_shrinkage_compensation_z', 'filament_shrinkage_compensation_z'],
      ['support_material_xy_spacing', 'support_object_xy_distance'],
    ])
  })

  it('keeps the filament colors apart from the settings', () => {
    const r = prusaProjectConfig('; filament_colour = #FF8000;#00AAFF\n; layer_height = 0.2')
    expect(r.colors).toEqual(['#FF8000', '#00AAFF'])
    expect(r.config).toEqual({ layer_height: '0.2' })
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
