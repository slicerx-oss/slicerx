// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { beforeEach, describe, expect, it } from 'vitest'
import type { MeshHandle } from '@slicerx/contracts'
import { runCall } from '../src/app-link/methods'
import { resolveConfig } from '../src/adapters/config'
import { SETTINGS, settingDef } from '../src/adapters/settings'
import { sx3mfBytes } from '../src/export/actions'
import { unzipEntries } from '../src/export/import3mf'
import { slotSlope, withSlotSlope } from '../src/filament/slot-lift'
import { boxMesh } from '../src/plate/mesh-ops'
import { allPlates } from '../src/plate/plates'
import { compose } from '../src/plate/transform'
import { get, set, type PlateEntry } from '../src/state/store'
import { setPrinterSetting } from '../src/workspaces/prepare/printer-settings'

type SettingsReply = { output: { overrides: Record<string, unknown>; effective: Record<string, unknown> } }
const read = async () => await runCall('settings.get', {}) as SettingsReply

beforeEach(() => set({ overrides: { wall_loops: 3 }, plate: [], plates: [], activePlate: 'plate', plateLoading: false, historyEdit: null, rollback: null }))

it('reads explicit overrides and effective print settings without exposing scripts', async () => {
  set({ overrides: { wall_loops: 3, machine_start_gcode: 'private start script' } })
  const reply = await read()
  expect(reply.output.overrides).toEqual({ wall_loops: 3 })
  expect(reply.output.effective.wall_loops).toBe(3)
  expect(JSON.stringify(reply)).not.toContain('private start script')
})

it('sets live overrides and clears them back to the current profile and Easy values', async () => {
  const inherited = resolveConfig(get().easy, {}).layer_height
  const result = await runCall('project.set_overrides', { changes: { layer_height: 0.12, brim_type: 'painted' } }) as SettingsReply
  expect(result.output.overrides).toEqual({ wall_loops: 3, layer_height: 0.12, brim_type: 'painted' })
  expect(get().overrides).toEqual(result.output.overrides)
  expect((await read()).output.effective).toMatchObject({ layer_height: 0.12, brim_type: 'painted' })
  await runCall('project.set_overrides', { clear: ['layer_height'] })
  expect(get().overrides).toEqual({ wall_loops: 3, brim_type: 'painted' })
  expect((await read()).output.effective.layer_height).toEqual(inherited)
})

it('refuses an invalid mixed patch atomically', async () => {
  const before = get().overrides
  await expect(runCall('project.set_overrides', { changes: { wall_loops: 5, no_such_setting: 1 } })).rejects.toMatchObject({ code: 'invalid_input' })
  expect(get().overrides).toBe(before)
})

it('refuses script settings without applying the other values', async () => {
  const before = get().overrides
  await expect(runCall('project.set_overrides', { changes: { wall_loops: 5, machine_start_gcode: 'G28' } })).rejects.toMatchObject({ code: 'invalid_input' })
  expect(get().overrides).toBe(before)
})

it('reports the shown plate effective setting when its own choice overrides the project', async () => {
  set({ overrides: { print_sequence: 'by layer' }, plates: [{ id: 'plate', name: 'Plate', objects: [], settings: { sequence: 'by-object' } }] })
  const reply = await read()
  expect(reply.output.overrides.print_sequence).toBe('by layer')
  expect(reply.output.effective.print_sequence).toBe('by object')
})

describe('lift settings for clients', () => {
  const saved = async () => {
    const files = await unzipEntries(await sx3mfBytes(allPlates(get())))
    return JSON.parse(new TextDecoder().decode(files.get('Metadata/project_settings.config'))) as Record<string, unknown>
  }
  const cube = (): PlateEntry => {
    const handle = { id: 'a', hash: 'a', name: 'a', triangles: 12, bboxMm: [20, 20, 20], openEdges: 0, parts: [] } as MeshHandle
    return { id: 'a', name: 'cube', handle, parts: [{ ...boxMesh(20, 20, 20), name: 'body', slot: 1 }], colors: ['#f2754e'], transform: compose({ position: [60, 60, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }) }
  }
  type LiftReply = { output: { overrides: Record<string, unknown>; effective: Record<string, unknown>; supported: string[]; warnings: { code: string }[] } }
  const lift = async () => await runCall('settings.get', { keys: ['z_hop_types', 'filament_travel_slope'] }) as LiftReply

  it('sets and reads back the Z hop type and a filament travel slope, and the saved project keeps both', async () => {
    set({ overrides: {}, plate: [cube()] })
    await runCall('project.set_overrides', { changes: { z_hop_types: ['Ramp Lift'], filament_travel_slope: [12] } })
    const reply = await lift()
    expect(reply.output.overrides).toEqual({ z_hop_types: ['Ramp Lift'], filament_travel_slope: [12] })
    expect(reply.output.effective).toMatchObject({ z_hop_types: ['Ramp Lift'], filament_travel_slope: [12] })
    expect(reply.output.warnings.map((w) => w.code)).not.toContain('enum_value_unavailable')
    const file = await saved()
    expect(file['z_hop_types']).toEqual(['Ramp Lift'])
    expect(file['filament_travel_slope']).toEqual(['12'])
    // The Filament dialog reads the same entry, and clearing it there removes the key for clients and the file.
    expect(slotSlope(get().overrides, 1)).toBe(12)
    set((s) => ({ overrides: withSlotSlope(s.overrides, 1, 1, undefined) }))
    expect((await lift()).output.overrides).toEqual({ z_hop_types: ['Ramp Lift'] })
    // The file then carries the setting's empty default.
    expect((await saved())['filament_travel_slope'] ?? []).toEqual([])
  })

  it('reads what the app controls set, per filament slot', async () => {
    set({ overrides: {}, plate: [cube()] })
    setPrinterSetting('z_hop_types', ['Spiral Lift'], { z_hop_types: ['Slope Lift', 'Slope Lift'] } as never)
    set((s) => ({ overrides: withSlotSlope(s.overrides, 2, 2, 20) }))
    const reply = await lift()
    expect(reply.output.overrides).toEqual({ z_hop_types: ['Spiral Lift', 'Spiral Lift'], filament_travel_slope: ['nil', 20] })
    expect(reply.output.overrides).toEqual(Object.fromEntries(['z_hop_types', 'filament_travel_slope'].map((k) => [k, get().overrides[k]])))
  })

  it('refuses a lift type the engine does not know', async () => {
    const before = get().overrides
    await expect(runCall('project.set_overrides', { changes: { z_hop_types: ['Bogus Lift'] } })).rejects.toMatchObject({ code: 'invalid_input' })
    expect(get().overrides).toBe(before)
  })

  it('keeps every other printer setting refused, to set and to read', async () => {
    const printer = SETTINGS.filter((d) => d.section === 'printer' && d.key !== 'z_hop_types')
    expect(printer.length).toBeGreaterThan(50)
    const before = get().overrides
    const accepted: string[] = []
    for (const d of printer) {
      const value = d.default ?? 0
      try {
        await runCall('project.set_overrides', { changes: { [d.key]: value } })
        accepted.push(d.key)
      } catch (e) {
        expect(e, d.key).toMatchObject({ code: 'invalid_input' })
      }
      await expect(runCall('settings.get', { keys: [d.key] }), d.key).rejects.toMatchObject({ code: 'invalid_input' })
    }
    expect(accepted).toEqual([])
    expect(get().overrides).toBe(before)
    const supported = (await lift()).output.supported
    expect(supported.filter((k) => settingDef(k)?.section === 'printer')).toEqual(['z_hop_types'])
    await expect(runCall('project.set_overrides', { changes: { machine_start_gcode: 'G28' } })).rejects.toMatchObject({ code: 'invalid_input' })
  })
})
