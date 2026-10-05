// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A PrusaSlicer 2.9.6 project (packages/settings/fixtures/preset-files/prusaslicer-2.9.6.3mf): its print settings from
// Metadata/Slic3r_PE.config and its per-object and per-volume settings from Metadata/Slic3r_PE_model.config, read
// into the same shapes an Orca or Bambu Studio project gives.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { PrintConfig } from '@slicerx/contracts'
import { readProject } from '../src/export/import3mf'
import { modifierSettings, projectSettingChanges } from '../src/export/project-settings'

const bytes = new Uint8Array(readFileSync(join(__dirname, '../../settings/fixtures/preset-files/prusaslicer-2.9.6.3mf')))
const bed = { widthMm: 250, depthMm: 210 }

describe('PrusaSlicer project', () => {
  it('splits the object into its part and its modifier by the triangle ranges', async () => {
    const p = await readProject(bytes, bed)
    const o = p.plates[0]!.objects[0]!
    expect(o.name).toBe('Cube with modifier')
    expect(o.parts).toHaveLength(1)
    expect(o.parts[0]!.indices.length).toBe(36)
    expect(o.volumes.map((v) => [v.name, v.role])).toEqual([['Denser core', 'modifier']])
    expect(o.volumes[0]!.part.indices.length).toBe(36)
    // The modifier is the 10 mm cube inside the 20 mm one.
    const pos = o.volumes[0]!.part.positions
    const xs = [...pos].filter((_, i) => i % 3 === 0)
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(10)
  })

  it('brings the object and modifier settings, in SlicerX keys', async () => {
    const o = (await readProject(bytes, bed)).plates[0]!.objects[0]!
    expect(modifierSettings(o.rawPartSettings!['Cube']!)).toMatchObject({ layer_height: 0.15, wall_loops: 4, sparse_infill_pattern: 'gyroid' })
    expect(modifierSettings(o.volumes[0]!.rawSettings!)).toMatchObject({ sparse_infill_density: 40, sparse_infill_speed: [120] })
  })

  it('brings the print settings the project was saved with', async () => {
    const p = await readProject(bytes, bed)
    expect(p.settingsFrom).toBe('prusaslicer')
    const { values } = projectSettingChanges(p.settings, { wall_loops: 2, sparse_infill_density: 15 } as unknown as PrintConfig)
    expect(values).toMatchObject({ wall_loops: 3, sparse_infill_density: 20, enable_support: true, support_type: 'tree(auto)' })
    // Printer settings stay with the person's own printer.
    expect(values['printable_height']).toBeUndefined()
  })
})
