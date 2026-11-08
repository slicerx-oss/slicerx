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
import { FLUSH_DEFAULTS, flushValues, printerMinFlush } from '../src/filament/flush'
import { flushPlan, slotConfig } from '../src/filament/slot-config'
import { boxMesh } from '../src/plate/mesh-ops'
import { compose } from '../src/plate/transform'
import { settingDefault } from '@slicerx/settings/defaults'
import { printerBase } from '../src/workspaces/prepare/printer-base'
import { profileReady, resetProfileReady } from '../src/state/profile-sync'
import { get, set, type PlateEntry } from '../src/state/store'

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

  it('no printer: a multi-color plate flushes by the colors alone, and the matrix stays usable', async () => {
    const part = (id: string, x: number, slot: number): PlateEntry => ({ id, name: id, handle: { id, hash: id, name: id, triangles: 12, bboxMm: [20, 20, 10], openEdges: 0, parts: [{ name: 'Body', slot, triangles: 12 }] }, parts: [{ ...boxMesh(20, 20, 10), name: 'Body', slot }], colors: ['#fff'], transform: compose({ position: [x, 100, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }) })
    const colors = ['#ffffff', '#000000', '#ff0000']
    set({ plate: [part('a', 40, 1), part('b', 100, 2), part('c', 160, 3)], plates: [{ id: 'p1', name: 'Plate 1', objects: [], settings: {} }], activePlate: 'p1', slotSetup: Object.fromEntries(colors.map((color, i) => [i + 1, { type: 'PLA', brand: 'Generic', color }])) } as never)
    // a printer with one nozzle and its own volume first (the H2D's two nozzles use measured sets that already hold it)
    set({ printerModel: { id: 'p1s', vendor: 'Bambu Lab', model: 'P1S' }, printerId: 'p1s' } as never)
    await profileReady()
    const p1s = slotConfig(get())['flush_volumes_matrix'] as number[]
    const p1sMins = flushPlan(get(), 3).mins
    expect(get().printerNozzleVolume).toBeGreaterThan(0)
    expect(p1sMins.every((m) => m > 0)).toBe(true)
    set({ printerModel: null, printerId: null } as never)
    await profileReady()
    // the generic printer's own nozzle volume, the schema's default
    expect(get().printerNozzleVolume).toBe(0)
    expect(get().printerNozzleVolume).toBe(printerMinFlush(settingDefault('nozzle_volume')))
    expect(flushPlan(get(), 3).mins).toEqual([0, 0, 0])
    const generic = slotConfig(get())['flush_volumes_matrix'] as number[]
    expect(generic).toHaveLength(9)
    // the color model alone: nothing on the diagonal, at least its 60 mm3 floor everywhere else
    expect(generic).toEqual(flushValues(colors, FLUSH_DEFAULTS, 0))
    generic.forEach((v, k) => (Math.floor(k / 3) === k % 3 ? expect(v).toBe(0) : expect(v).toBeGreaterThanOrEqual(60)))
    // the P1S adds its minimum to each change from a filament, and nothing else
    p1s.forEach((v, k) => expect(v - generic[k]!).toBe(Math.floor(k / 3) === k % 3 ? 0 : p1sMins[Math.floor(k / 3)]))
  })
})
