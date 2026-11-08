// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A printer change whose nozzle volume code fails to load (a chunk that will not download) leaves the printer and
// filament layer and the store's profile on the same printer: the layer is applied only once everything the profile
// needs is in hand. A printer with no layer (none picked, or one the profiles do not know) gets its own nozzle volume
// too, not the last printer's.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const fail = vi.hoisted(() => ({ on: false }))
vi.mock('../src/workspaces/prepare/printer-base', async (actual) => {
  const real = await actual<typeof import('../src/workspaces/prepare/printer-base')>()
  return {
    ...real,
    printerBase: (...a: Parameters<typeof real.printerBase>) => {
      if (fail.on) throw new Error('chunk failed to load')
      return real.printerBase(...a)
    },
  }
})

import type { SettingValue } from '@slicerx/contracts'
import { profileLayerToken, resolveConfig } from '../src/adapters/config'
import { printerMinFlush } from '../src/filament/flush'
import { printerBase } from '../src/workspaces/prepare/printer-base'
import { profileReady, resetProfileReady } from '../src/state/profile-sync'
import { get, set } from '../src/state/store'

beforeEach(async () => {
  fail.on = false
  resetProfileReady()
  set({ printerModel: { id: 'h2d', vendor: 'Bambu Lab', model: 'H2D' }, printerId: 'h2d', printerSlots: [], slotSetup: {}, overrides: {} } as never)
  await profileReady()
})

describe('the profile layer and the profile stay in step', () => {
  it('a printer change whose nozzle volume code fails: the layer and the profile both stay on the old printer', async () => {
    const token = profileLayerToken()
    const profile = get().profile
    const start = resolveConfig(get().easy, get().overrides)['machine_start_gcode']
    expect(profile?.printerId).toContain('h2d')
    fail.on = true
    set({ printerModel: { id: 'p1s', vendor: 'Bambu Lab', model: 'P1S' }, printerId: 'p1s' } as never)
    await profileReady()
    expect(get().profile).toBe(profile)
    expect(profileLayerToken()).toBe(token)
    expect(resolveConfig(get().easy, get().overrides)['machine_start_gcode']).toBe(start)
    // once the code loads, the next read builds the new printer's layer
    fail.on = false
    resetProfileReady()
    await profileReady()
    expect(get().profile?.printerId).toContain('p1s')
    expect(profileLayerToken()).not.toBe(token)
  })
})

describe('a printer with no profile layer', () => {
  const volume = (m?: { vendor: string; model: string }) => printerMinFlush((printerBase(m) as Record<string, SettingValue>)['nozzle_volume'])

  it("no printer: the nozzle volume goes back to the generic printer's, as Prepare sets it", async () => {
    expect(get().printerNozzleVolume).toBe(volume({ vendor: 'Bambu Lab', model: 'H2D' }))
    expect(volume(undefined)).not.toBe(volume({ vendor: 'Bambu Lab', model: 'H2D' }))
    set({ printerModel: null, printerId: null } as never)
    await profileReady()
    expect(get().profile).toBeNull()
    expect(get().printerNozzleVolume).toBe(volume(undefined))
  })

  it("a printer the profiles do not know: its own nozzle volume, not the last printer's", async () => {
    const unknown = { vendor: 'Nobody', model: 'Box 1' }
    set({ printerModel: { id: 'box', ...unknown }, printerId: 'box' } as never)
    await profileReady()
    expect(get().profile).toBeNull()
    expect(get().printerNozzleVolume).toBe(volume(unknown))
    expect(get().printerNozzleVolume).not.toBe(volume({ vendor: 'Bambu Lab', model: 'H2D' }))
  })
})
