// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Slots that print different filaments each keep their own preset's values. A setting one slot's preset leaves out
// slices at its schema default, as it does when that filament prints alone, never at another slot's value: a PLA slot
// beside a TPU one kept TPU's 30 C cool plate and its 200 to 250 C range before.
import type { SettingValue } from '@slicerx/contracts/settings'
import { describe, expect, it } from 'vitest'
import { settingDefault } from './defaults'
import { FILAMENT_OVERRIDE_KEYS, stockLayer, type SlotFilament } from './stock-layer'

const first = (v: unknown): unknown => (Array.isArray(v) ? v[0] : v)

/** The filament values the layer of these slots gives slot by slot, beside what each slot's filament gives alone. */
async function bySlot(printerId: string, slots: SlotFilament[]): Promise<{ both: Record<string, SettingValue>; alone: Record<string, SettingValue>[]; machine: Set<string> }> {
  const both = (await stockLayer({ printerId, tier: 'standard', slots }))!.values
  const alone = await Promise.all(slots.map(async (s) => (await stockLayer({ printerId, tier: 'standard', slots: [s] }))!.values))
  // Machine and process keys are the printer's, not a slot's; a two-entry machine list is not a slot list.
  const none = (await stockLayer({ printerId, tier: 'standard', slots: [] }))!.values
  const keys = new Set(alone.flatMap((a) => Object.keys(a)))
  const machine = new Set([...keys].filter((k) => alone.every((a) => JSON.stringify(a[k]) === JSON.stringify(none[k])) && JSON.stringify(both[k]) === JSON.stringify(none[k])))
  return { both, alone, machine }
}

/** Each slot entry that is neither the slot's own value nor the schema default where its preset is silent. */
async function borrowed(printerId: string, slots: SlotFilament[]): Promise<string[]> {
  const { both, alone, machine } = await bySlot(printerId, slots)
  const out: string[] = []
  for (const [key, v] of Object.entries(both)) {
    if (!Array.isArray(v) || v.length !== slots.length || machine.has(key)) continue
    slots.forEach((s, i) => {
      const own = alone[i]![key]
      // An empty list is a key left out; a default that is an empty list leaves an empty entry.
      const want = first(own) ?? (FILAMENT_OVERRIDE_KEYS.has(key) ? 'nil' : (first(settingDefault(key)) ?? ''))
      if (JSON.stringify(v[i]) !== JSON.stringify(want)) out.push(`${key} slot ${i + 1} (${s.family ?? s.type}): ${JSON.stringify(v[i])}, own ${own === undefined ? 'unset' : JSON.stringify(first(own))}`)
    })
  }
  return out
}

describe('per-slot filament values on a plate of different presets', () => {
  it("gives the A1's PLA slot its own plate temperatures and range beside a TPU slot", async () => {
    const { both } = await bySlot('bambu-a1', [{ type: 'PLA' }, { type: 'TPU' }])
    expect(both['filament_type']).toEqual(['PLA', 'TPU'])
    expect(both['cool_plate_temp']).toEqual([35, 30])
    expect(both['cool_plate_temp_initial_layer']).toEqual([35, 30])
    expect(both['nozzle_temperature_range_low']).toEqual([190, 200])
    expect(both['nozzle_temperature_range_high']).toEqual([240, 250])
  })

  it('borrows nothing across the A1 PLA and TPU slots', async () => {
    expect(await borrowed('bambu-a1', [{ type: 'PLA' }, { type: 'TPU' }])).toEqual([])
  })

  it('borrows nothing for a slot set by hand to a TPU product', async () => {
    expect(await borrowed('bambu-a1', [{ type: 'PLA' }, { type: 'TPU', vendor: 'BBL', family: 'Bambu TPU 95A HF' }])).toEqual([])
    expect(await borrowed('bambu-a1', [{ type: 'TPU', vendor: 'BBL', family: 'Bambu TPU 95A HF' }, { type: 'PLA' }])).toEqual([])
  })

  it('gives a slot the same values whatever the other slots print', async () => {
    const pla = (await stockLayer({ printerId: 'bambu-a1', tier: 'standard', slots: [{ type: 'PLA' }, { type: 'PLA' }] }))!.values
    for (const other of [{ type: 'TPU' }, { type: 'PETG' }, { type: 'ABS' }]) {
      const mixed = (await stockLayer({ printerId: 'bambu-a1', tier: 'standard', slots: [{ type: 'PLA' }, other] }))!.values
      // A key the PLA pair leaves out slices at its default (an override at the printer's value) on that plate.
      const plaFirst = (k: string): unknown => (Array.isArray(pla[k]) ? (pla[k] as unknown[])[0] : FILAMENT_OVERRIDE_KEYS.has(k) ? 'nil' : first(settingDefault(k)))
      const moved = Object.keys(mixed).filter((k) => Array.isArray(mixed[k]) && (mixed[k] as unknown[]).length === 2 && plaFirst(k) !== undefined && JSON.stringify(plaFirst(k)) !== JSON.stringify((mixed[k] as unknown[])[0]))
      expect(moved, other.type).toEqual([])
    }
  })

  it('borrows nothing on any printer for common pairs of materials', async () => {
    const { listPrinterProfiles } = await import('./profiles')
    const found: string[] = []
    for (const { id } of listPrinterProfiles()) {
      for (const types of [['PLA', 'TPU'], ['PLA', 'PETG'], ['ASA', 'PLA', 'TPU']]) {
        if (!(await stockLayer({ printerId: id, tier: 'standard', slots: [] }))) continue
        for (const line of await borrowed(id, types.map((type) => ({ type })))) found.push(`${id}: ${line}`)
      }
    }
    expect(found.slice(0, 20)).toEqual([])
  }, 60_000)
})
