// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A ramp lift (`Ramp Lift`, with the filament's own travel slope) leaves the app in a form each reader takes: the
// .gcode.3mf a Bambu Lab printer, Bambu Studio or OrcaSlicer opens carries it as Slope Lift and leaves the filament
// travel slope out, and the app's own .sx3mf keeps both, so the project opens again as it was.
import { describe, expect, it } from 'vitest'
import type { MeshHandle } from '@slicerx/contracts'
import { printGcode3mf, sx3mfBytes } from '../src/export/actions'
import { unzipEntries } from '../src/export/import3mf'
import { boxMesh } from '../src/plate/mesh-ops'
import { allPlates } from '../src/plate/plates'
import { compose } from '../src/plate/transform'
import { get, set, type PlateEntry } from '../src/state/store'

const dec = (b: Uint8Array | undefined) => new TextDecoder().decode(b)

function cube(): PlateEntry {
  const handle = { id: 'a', hash: 'a', name: 'a', triangles: 12, bboxMm: [20, 20, 20], openEdges: 0, parts: [] } as MeshHandle
  return { id: 'a', name: 'cube', handle, parts: [{ ...boxMesh(20, 20, 20), name: 'body', slot: 1 }], colors: ['#f2754e'], transform: compose({ position: [60, 60, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }) }
}

const GCODE = ['; HEADER_BLOCK_START', '; model label id: 1', '; HEADER_BLOCK_END', 'G1 X60 Y60', 'G1 X80 Y80 E1', ''].join('\n')

async function settingsOf(bytes: Uint8Array): Promise<Record<string, unknown>> {
  const files = await unzipEntries(bytes)
  return JSON.parse(dec(files.get('Metadata/project_settings.config'))) as Record<string, unknown>
}

describe('a ramp lift on export', () => {
  it('goes to a .gcode.3mf as a slope lift, and the app keeps it as a ramp in its own project', async () => {
    set({ plate: [cube()], overrides: { ...get().overrides, filament_z_hop: [0.6], filament_z_hop_types: ['Ramp Lift'], filament_travel_slope: [1] } })
    const printed = await settingsOf(await printGcode3mf(GCODE))
    expect(printed['filament_z_hop_types']).toEqual(['Slope Lift'])
    expect(printed).not.toHaveProperty('filament_travel_slope')
    const saved = await settingsOf(await sx3mfBytes(allPlates(get())))
    expect(saved['filament_z_hop_types']).toEqual(['Ramp Lift'])
    expect(saved['filament_travel_slope']).toEqual(['1'])
  })
})
