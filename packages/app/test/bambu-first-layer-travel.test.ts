// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Bambu Studio reads a missing first layer travel acceleration as 500 mm/s2. A project it wrote (the model's Application
// metadata starts with BambuStudio) without the key opens with 500, one with the key keeps its value, and a project from
// another app is left as it is, the same rule the engine's project import has. A missing internal bridge speed is read
// as the bridge speed (100%) the same way.
import { describe, expect, it } from 'vitest'
import { baseConfig } from '../src/adapters/settings'
import { projectSettingChanges } from '../src/export/project-settings'
import { readProject } from '../src/export/import3mf'
import { zip } from '../src/export/zip'

const vertices = [[0, 0, 0], [20, 0, 0], [20, 20, 0], [0, 20, 0], [0, 0, 20], [20, 0, 20], [20, 20, 20], [0, 20, 20]]
const triangles = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [3, 7, 6], [3, 6, 2], [0, 4, 7], [0, 7, 3], [1, 2, 6], [1, 6, 5]]
const model = (app?: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">${app ? `<metadata name="Application">${app}</metadata>` : ''}<resources><object id="1" name="box" type="model"><mesh><vertices>${vertices.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('')}</vertices><triangles>${triangles.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('')}</triangles></mesh></object></resources><build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 30 40 0"/></build></model>`
const bed = { widthMm: 256, depthMm: 256 }
const open = async (app: string | undefined, settings: Record<string, unknown>) =>
  (await readProject(zip([{ name: '3D/3dmodel.model', data: model(app) }, { name: 'Metadata/project_settings.config', data: JSON.stringify({ layer_height: '0.2', ...settings }) }]), bed)).settings

describe('first layer travel acceleration of a project without the key', () => {
  it('is 500 for a Bambu Studio project', async () => {
    const s = await open('BambuStudio-02.01.00.00', {})
    expect(s['initial_layer_travel_acceleration']).toEqual(['500'])
    // and it reaches the plate's settings in the same form as a value the project writes itself
    const own = projectSettingChanges({ initial_layer_travel_acceleration: ['500'] }, baseConfig()).values['initial_layer_travel_acceleration']
    expect(own).toBeDefined()
    expect(projectSettingChanges(s, baseConfig()).values['initial_layer_travel_acceleration']).toEqual(own)
  })

  it('keeps the value a Bambu Studio project has', async () => {
    const s = await open('BambuStudio-02.01.00.00', { initial_layer_travel_acceleration: ['6000'] })
    expect(s['initial_layer_travel_acceleration']).toEqual(['6000'])
  })

  it('counts as changed when the project lists what it changed, so a project opened with only those still gets it', async () => {
    const s = await open('BambuStudio-02.01.00.00', { different_settings_to_system: ['layer_height;', '', ''] })
    expect(s['initial_layer_travel_acceleration']).toEqual(['500'])
    expect(s['different_settings_to_system']).toEqual(['layer_height;initial_layer_travel_acceleration;internal_bridge_speed', '', ''])
  })

  it('gives internal bridges the bridge speed the same way', async () => {
    expect((await open('BambuStudio-02.01.00.00', {}))['internal_bridge_speed']).toEqual(['100%'])
    expect((await open('BambuStudio-02.01.00.00', { internal_bridge_speed: ['120%'] }))['internal_bridge_speed']).toEqual(['120%'])
    for (const app of ['OrcaSlicer-2.3.0', undefined]) expect('internal_bridge_speed' in (await open(app, {})), String(app)).toBe(false)
    // and it reaches the plate's settings in the same form as a value the project writes itself
    const s = await open('BambuStudio-02.01.00.00', {})
    const own = projectSettingChanges({ internal_bridge_speed: ['100%'] }, baseConfig()).values['internal_bridge_speed']
    expect(own).toBeDefined()
    expect(projectSettingChanges(s, baseConfig()).values['internal_bridge_speed']).toEqual(own)
  })

  it('is left as it is for an OrcaSlicer project, one with no app named, and one with no settings', async () => {
    for (const app of ['OrcaSlicer-2.3.0', undefined]) expect('initial_layer_travel_acceleration' in (await open(app, {})), String(app)).toBe(false)
    const plain = await readProject(zip([{ name: '3D/3dmodel.model', data: model('BambuStudio-02.01.00.00') }]), bed)
    expect(plain.settings).toEqual({})
  })
})
