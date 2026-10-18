// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// resolveConfig keeps its last result while easy, overrides and the profile layer are the same objects. The kept result
// must match a fresh build, any new object must build again, and no caller can change what the next one gets.
import type { SettingValue } from '@slicerx/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { goalEasy, resolveConfig, setProfileLayer } from '../src/adapters/config'
import { buildProfileLayer } from '../src/adapters/profile'

afterEach(() => setProfileLayer(null, []))

const p1s = async (): Promise<Record<string, SettingValue>> => (await buildProfileLayer({ printer: { vendor: 'Bambu Lab', model: 'P1S' }, tier: 'standard', slots: [{ type: 'PLA' }] }))!.values

describe('resolveConfig cache', () => {
  it('gives what a fresh build gives, with and without a maker preset', async () => {
    const easy = goalEasy('fine')
    const overrides: Record<string, SettingValue> = { wall_loops: 4, seam_position: 'back' }
    const kept = [resolveConfig(easy, overrides), resolveConfig(easy, overrides)]
    // Copies of easy and overrides are new objects, so this one is built from scratch.
    expect(kept[1]).toEqual(resolveConfig({ ...easy }, { ...overrides }))
    expect(kept[1]).toEqual(kept[0])
    setProfileLayer(await p1s(), [])
    const preset = resolveConfig(easy, overrides)
    expect(preset).not.toEqual(kept[0])
    expect(resolveConfig(easy, overrides)).toEqual(resolveConfig({ ...easy }, { ...overrides }))
    expect(preset['wall_generator']).toBe('aegis')
  })

  it('builds again for a new easy, overrides or profile layer object', async () => {
    const easy = { ...goalEasy('standard') }
    const overrides: Record<string, SettingValue> = { wall_loops: 3 }
    expect(resolveConfig(easy, overrides)['wall_loops']).toBe(3)
    expect(resolveConfig(easy, { wall_loops: 6 })['wall_loops']).toBe(6)
    const coarse = resolveConfig(easy, overrides)['layer_height']
    expect(resolveConfig({ ...easy, detail: 100 }, overrides)['layer_height']).not.toEqual(coarse)

    // The key is the object, not its contents: the store never edits these in place, it replaces them.
    const values = await p1s()
    setProfileLayer(values, [])
    const before = resolveConfig(easy, overrides)['machine_start_gcode']
    values['machine_start_gcode'] = 'G28 ; edited in place'
    expect(resolveConfig(easy, overrides)['machine_start_gcode']).toBe(before)
    setProfileLayer(values, [])
    expect(resolveConfig(easy, overrides)['machine_start_gcode']).toBe('G28 ; edited in place')
    setProfileLayer(null, [])
    expect(resolveConfig(easy, overrides)['machine_start_gcode']).not.toBe('G28 ; edited in place')
  })

  it('a caller that changes its result leaves the next caller alone', () => {
    const easy = goalEasy('standard')
    const overrides: Record<string, SettingValue> = {}
    const clean = { ...resolveConfig({ ...easy }, { ...overrides }) }
    const first = resolveConfig(easy, overrides) as Record<string, SettingValue | undefined>
    first['wall_loops'] = 99
    first['brim_type'] = 'painted'
    delete first['layer_height']
    const next = resolveConfig(easy, overrides)
    expect(next).not.toBe(first)
    expect(next).toEqual(clean)
  })
})
