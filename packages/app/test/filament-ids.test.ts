// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Each slot's filament preset id (`filament_ids`, such as GFA00) reaches the .gcode.3mf a Bambu Lab printer starts,
// as tray_info_idx per filament, the way Orca writes it from each filament preset's `filament_id`.
import { describe, expect, it } from 'vitest'
import type { MeshHandle } from '@slicerx/contracts'
import { buildProfileLayer } from '../src/adapters/profile'
import { printGcode3mf } from '../src/export/actions'
import { unzipEntries } from '../src/export/import3mf'
import { boxMesh } from '../src/plate/mesh-ops'
import { compose } from '../src/plate/transform'
import { get, set, type PlateEntry } from '../src/state/store'

const dec = (b: Uint8Array | undefined) => new TextDecoder().decode(b)

function cube(): PlateEntry {
  const handle = { id: 'a', hash: 'a', name: 'a', triangles: 12, bboxMm: [20, 20, 20], openEdges: 0, parts: [] } as MeshHandle
  return { id: 'a', name: 'cube', handle, parts: [{ ...boxMesh(20, 20, 20), name: 'body', slot: 1 }], colors: ['#f2754e'], transform: compose({ position: [60, 60, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }) }
}

const GCODE = [
  '; HEADER_BLOCK_START',
  '; model label id: 1',
  '; HEADER_BLOCK_END',
  '; start printing object, unique label id: 1',
  'G1 X60 Y60',
  'G1 X80 Y80 E1',
  '; stop printing object, unique label id: 1',
  '; filament used [mm] = 2403.83',
  '; filament used [g] = 7.29',
  '; estimated printing time (normal mode) = 24m 47s',
  '',
].join('\n')

describe('filament preset ids', () => {
  it('come from each slot preset, empty where a slot has none', async () => {
    const layer = await buildProfileLayer({
      printer: { vendor: 'Bambu Lab', model: 'P1S' },
      tier: 'standard',
      slots: [{ type: 'PLA', vendor: 'BBL', family: 'Bambu PLA Basic' }, { type: 'PETG' }, { type: 'PLA' }],
    })
    expect(layer?.filamentIds).toHaveLength(3)
    expect(layer!.filamentIds[0]).toBe('GFA00')
    // The generic PETG preset carries its own id.
    expect(layer!.filamentIds[1]).toMatch(/^GF/)
    // The maker's default filament carries the id Orca resolved for its preset.
    expect(layer!.filamentIds[2]).toBe('GFA00')
  })

  it('come with the maker default filament of a Bambu printer', async () => {
    for (const model of ['A1', 'A1 mini']) {
      const layer = await buildProfileLayer({ printer: { vendor: 'Bambu Lab', model }, tier: 'standard', slots: [{ type: 'PLA' }] })
      expect(layer?.filamentIds).toEqual(['GFA00'])
    }
  })

  it('reach the .gcode.3mf a Bambu printer starts, per tray', async () => {
    const layer = await buildProfileLayer({ printer: { vendor: 'Bambu Lab', model: 'P1S' }, tier: 'standard', slots: [{ type: 'PLA', vendor: 'BBL', family: 'Bambu PLA Basic' }] })
    const s = get()
    set({ plate: [cube()], profile: { ...(s.profile ?? { printerId: 'bambu-p1s', nozzle: 0.4, nozzles: [0.4], nozzleFrom: 'default', tier: 'standard', source: 'orca', shippedGcode: false, gcodeKeys: [], limits: {} }), filamentIds: layer!.filamentIds } })
    const files = await unzipEntries(await printGcode3mf(GCODE))
    expect(dec(files.get('Metadata/slice_info.config'))).toContain('tray_info_idx="GFA00"')
    expect(dec(files.get('Metadata/project_settings.config'))).toMatch(/"filament_ids":\s*\[\s*"GFA00"\s*\]/)
  })
})
