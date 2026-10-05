// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { beforeEach, describe, expect, it } from 'vitest'
import { printerBase, profileIdFor } from '../src/workspaces/prepare/printer-base'
import { setPrinterSetting } from '../src/workspaces/prepare/printer-settings'
import { capture } from '../src/presets/presets'
import { get, set } from '../src/state/store'

beforeEach(() => set({ overrides: {} }))

describe('printer settings', () => {
  it('finds the profile of a printer by vendor and model, and starts from its values', () => {
    const id = profileIdFor({ vendor: 'Bambu Lab', model: 'X1 Carbon' })
    expect(id).toBeDefined()
    const base = printerBase({ vendor: 'Bambu Lab', model: 'X1 Carbon' }) as Record<string, unknown>
    expect(base['printable_height']).toBeGreaterThan(200)
    expect(base['nozzle_diameter']).toEqual([0.4])
  })

  it('falls back to the schema defaults for an unknown printer', () => {
    expect(profileIdFor({ vendor: 'Nobody', model: 'Nothing 9' })).toBeUndefined()
    expect(printerBase(undefined)).toHaveProperty('retraction_length')
  })

  it('edits the first value of a per-mode list and keeps the rest', () => {
    const base = { machine_max_speed_x: [500, 200] } as never
    setPrinterSetting('machine_max_speed_x', [300], base)
    expect(get().overrides['machine_max_speed_x']).toEqual([300, 200])
    setPrinterSetting('machine_max_speed_x', [250], base)
    expect(get().overrides['machine_max_speed_x']).toEqual([250, 200])
  })

  it('a reset drops the change, and edits are picked up as a printer preset', () => {
    setPrinterSetting('retraction_length', [1.4], undefined)
    expect(capture('printer').values).toEqual({ retraction_length: [1.4] })
    setPrinterSetting('retraction_length', undefined, undefined)
    expect(get().overrides).toEqual({})
  })
})
