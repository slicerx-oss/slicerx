// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The app's tool changer for Preview on the Prusa Core One with INDX: the shipped profile's eight tools give the front
// docks, a two color print plays its changes at about the profile's 12 s, and the plain Core One plays none.
import { describe, expect, it } from 'vitest'
import { printerConfig } from '@slicerx/settings'
import type { SettingValue } from '@slicerx/contracts/settings'
import { toolChangerFor } from '../src/lib/toolchanger'
import { get, set, type ProfileInfo } from '../src/state/store'

const profile = (printerId: string) => ({ printerId, nozzle: 0.4, nozzles: [0.4], nozzleFrom: 'printer', tier: 'standard', source: 'slicerx' }) as unknown as ProfileInfo
/** The printer's shipped settings, as the app resolves them under a person's overrides. */
const shipped = (id: string) => printerConfig(id) as unknown as Record<string, SettingValue>

describe('toolChangerFor on the Core One INDX', () => {
  it('gives the shipped INDX profile the front docks, eight of them, and two tools for a two color print', () => {
    set({ profile: profile('prusa-core-one-indx'), overrides: shipped('prusa-core-one-indx'), bed: { widthMm: 248, depthMm: 205, heightMm: 270 } })
    const spec = toolChangerFor({ ...get(), preview: { toolCount: 2 } as never })
    expect(spec?.kind).toBe('front-dock')
    expect(spec?.frontDock?.x).toHaveLength(8)
    expect(spec?.tools).toBe(2)
    expect(spec?.extruderOf).toEqual([0, 1])
    expect(spec?.seconds.switch).toBe(12)
    expect(spec?.chute).toBeUndefined()
    expect(spec?.klipper).toBeUndefined()
  })

  it('plays nothing on the plain Core One', () => {
    set({ profile: profile('prusa-core-one'), overrides: shipped('prusa-core-one'), bed: { widthMm: 250, depthMm: 220, heightMm: 270 } })
    expect(toolChangerFor({ ...get(), preview: { toolCount: 2 } as never })).toBeNull()
  })
})
