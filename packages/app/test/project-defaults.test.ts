// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A project open adds the keys the app that wrote the file reads differently when they are missing (engine-choices.json
// fromApp in @slicerx/settings), against the shared cases sx-core and the MCP server run too, and counts them as changed
// when the project lists what it changed.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { baseConfig } from '../src/adapters/settings'
import { projectSettingChanges } from '../src/export/project-settings'
import { readProject, withBambuMissingKeys } from '../src/export/import3mf'
import { zip } from '../src/export/zip'

const cases = JSON.parse(readFileSync(join(__dirname, '../../settings/fixtures/project-defaults.json'), 'utf8')) as {
  cases: { name: string; application?: string; settings: Record<string, unknown>; added: Record<string, unknown> }[]
}

const vertices = [[0, 0, 0], [20, 0, 0], [20, 20, 0], [0, 20, 0], [0, 0, 20], [20, 0, 20], [20, 20, 20], [0, 20, 20]]
const triangles = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [3, 7, 6], [3, 6, 2], [0, 4, 7], [0, 7, 3], [1, 2, 6], [1, 6, 5]]
const model = (app?: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">${app ? `<metadata name="Application">${app}</metadata>` : ''}<resources><object id="1" name="box" type="model"><mesh><vertices>${vertices.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('')}</vertices><triangles>${triangles.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('')}</triangles></mesh></object></resources><build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 30 40 0"/></build></model>`
const bed = { widthMm: 256, depthMm: 256 }
const open = async (app: string | undefined, settings: Record<string, unknown>) =>
  (await readProject(zip([{ name: '3D/3dmodel.model', data: model(app) }, { name: 'Metadata/project_settings.config', data: JSON.stringify(settings) }]), bed)).settings

describe("a project open and the keys its app reads differently", () => {
  for (const c of cases.cases) {
    it(c.name, async () => {
      const s = await open(c.application, c.settings)
      const added = Object.fromEntries(Object.keys(s).filter((k) => !(k in c.settings)).map((k) => [k, s[k]]))
      expect(added).toEqual(c.added)
      expect(withBambuMissingKeys(c.settings, c.application)).toEqual({ ...c.settings, ...c.added })
    })
  }

  it('counts the added keys as changed when the project lists what it changed', async () => {
    const bare = cases.cases[0]
    if (!bare) throw new Error('no cases')
    const s = await open(bare.application, { ...bare.settings, different_settings_to_system: ['layer_height;', '', ''] })
    expect(s['different_settings_to_system']).toEqual([`layer_height;${Object.keys(bare.added).join(';')}`, '', ''])
    expect(s['wipe_tower_wall_type']).toBe('rib')
  })

  it("puts the rib tower in the plate's settings, as a project that names it does", async () => {
    const bare = cases.cases[0]
    if (!bare) throw new Error('no cases')
    const s = await open(bare.application, bare.settings)
    const own = projectSettingChanges({ wipe_tower_wall_type: 'rib' }, baseConfig()).values['wipe_tower_wall_type']
    expect(own).toBe('rib')
    expect(projectSettingChanges(s, baseConfig()).values['wipe_tower_wall_type']).toBe(own)
    // a project with Bambu Studio's rib switch off keeps the rectangle tower (the base value, so no change)
    const off = await open(bare.application, { ...bare.settings, prime_tower_rib_wall: '0' })
    expect(projectSettingChanges(off, baseConfig()).values['wipe_tower_wall_type'] ?? baseConfig()['wipe_tower_wall_type']).toBe('rectangle')
  })
})
