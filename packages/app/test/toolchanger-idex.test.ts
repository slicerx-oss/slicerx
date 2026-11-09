// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The app's tool changer for Preview reads the printer catalog's kinematics: an IDEX printer parks a carriage, it never
// plays the H2D's chute switch.
import { describe, expect, it } from 'vitest'
import { toolChangerFor } from '../src/lib/toolchanger'
import { get, set, type ProfileInfo } from '../src/state/store'

const profile = (printerId: string) => ({ printerId, nozzle: 0.4, nozzles: [0.4], nozzleFrom: 'printer', tier: 'standard', source: 'slicerx' }) as unknown as ProfileInfo

describe('toolChangerFor', () => {
  it('gives the Snapmaker J1, an IDEX printer in the catalog, the carriage park', () => {
    set({ profile: profile('snapmaker-j1'), overrides: { nozzle_diameter: ['0.4', '0.4'], printable_area: ['0x0', '324x0', '324x200', '0x200'] }, bed: { widthMm: 324, depthMm: 200, heightMm: 200 } })
    const spec = toolChangerFor({ ...get(), preview: { toolCount: 2 } as never })
    expect(spec?.kind).toBe('idex-park')
    expect(spec?.idex?.park).toEqual([-50, 374])
    expect(spec?.chute).toBeUndefined()
  })

  it('plays nothing on the Snapmaker Artisan and keeps the H2D on its chute switch', () => {
    set({ profile: profile('snapmaker-artisan'), overrides: { nozzle_diameter: ['0.4', '0.4'] }, bed: { widthMm: 400, depthMm: 400, heightMm: 400 } })
    expect(toolChangerFor({ ...get(), preview: { toolCount: 2 } as never })).toBeNull()
    set({ profile: profile('bambu-h2d'), overrides: { nozzle_diameter: ['0.4', '0.4'] }, bed: { widthMm: 350, depthMm: 320, heightMm: 325 } })
    expect(toolChangerFor({ ...get(), preview: { toolCount: 2 } as never })?.kind).toBe('dual-nozzle')
  })
})
