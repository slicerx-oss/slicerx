// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it, vi } from 'vitest'
import { hashParams, type ApprovalHost, type ApprovalRequest, type FilamentSlot, type Host, type PrinterInfo, type SlotSetting } from '@slicerx/contracts'
import { setProfileLayer } from '../src/adapters/config'
import { slotMatches, slotSettingFor, writeSlot } from '../src/filament/slot-write'
import { get, set } from '../src/state/store'

const h2d: PrinterInfo & { status: { state: string } } = { id: 'h2d', name: 'Tawain #1', vendor: 'Bambu Lab', model: 'H2D', plugin: 'bambu-lan', nozzleCount: 2, status: { state: 'idle' } } as never
const trays: FilamentSlot[] = [{ id: 'A1', material: 'PLA', color: '#ffffff' }, { id: 'A2', material: 'PLA', color: '#000000' }]

function setup(over: Partial<FilamentSlot> = {}) {
  setProfileLayer({ nozzle_temperature_range_low: [190, 220], nozzle_temperature_range_high: [230, 260] }, [])
  set({
    printerSlots: [trays[0]!, { ...trays[1]!, ...over }],
    slotSetup: { 2: { type: 'PETG', brand: 'Bambu', color: '#1a2b3c' } },
    profile: { ...(get().profile ?? { printerId: 'bambu-h2d', nozzle: 0.4, nozzles: [0.4], nozzleFrom: 'default', tier: 'standard', source: 'orca', shippedGcode: false, gcodeKeys: [], limits: {} }), values: { nozzle_temperature_range_low: [190, 220], nozzle_temperature_range_high: [230, 260] }, filamentIds: ['GFA00', 'GFG99'] } as never,
  })
}

describe('writing a slot to the printer', () => {
  it('takes the preset id, type, color and nozzle range SlicerX has for the slot', () => {
    setup()
    const got = slotSettingFor(get(), 2, h2d)
    expect(got).toEqual({ setting: { slot: 'A2', filamentId: 'GFG99', material: 'PETG', color: '#1a2b3c', nozzleTempMin: 220, nozzleTempMax: 260 } })
  })

  it('says why not: another make, a print running, an RFID spool, no preset id', () => {
    setup()
    expect(slotSettingFor(get(), 2, { ...h2d, plugin: 'moonraker' })).toHaveProperty('reason')
    expect(slotSettingFor(get(), 2, { ...h2d, status: { state: 'printing' } })).toHaveProperty('reason', 'The printer is printing. Set the slot when it is done.')
    setup({ spoolUid: 'A1B2' })
    expect(slotSettingFor(get(), 2, h2d)).toHaveProperty('reason', 'This spool has an RFID tag, which sets the slot itself.')
    setup()
    set({ profile: { ...get().profile!, filamentIds: ['GFA00', ''] } })
    expect(slotSettingFor(get(), 2, h2d)).toHaveProperty('reason')
  })

  it('asks first with the exact setting on the card, then follows what the printer reports', async () => {
    setup()
    const setting: SlotSetting = { slot: 'A2', filamentId: 'GFG99', material: 'PETG', color: '#1a2b3c', nozzleTempMin: 220, nozzleTempMax: 260 }
    const seen: ApprovalRequest[] = []
    const approvals = { register: async (r: ApprovalRequest) => void seen.push(r), grant: async () => ({ id: 'tok' }), grantWith: async () => ({ id: 'tok' }), deny: async () => undefined } as unknown as ApprovalHost
    const setSlot = vi.fn(async () => ({ slot: { id: 'A2', material: 'PETG', color: '#1a2b3c' }, shown: true }))
    const host = { printers: { adjust: { setSlot } }, approvals } as unknown as Host
    const done = writeSlot(host, h2d, 2)
    await vi.waitFor(() => expect(get().approval).not.toBeNull())
    expect(setSlot).not.toHaveBeenCalled()
    const card = get().approval!.requests[0]!
    expect(card.title).toBe('Set slot A2 on Tawain #1 to PETG?')
    expect(card.actions).toEqual([{ action: 'printer.adjust', target: 'h2d', paramsHash: await hashParams({ printerId: 'h2d', slot: setting }) }])
    await get().approval!.approve()
    await done
    expect(setSlot).toHaveBeenCalledWith('h2d', setting, expect.anything())
    expect(get().printerSlots[1]).toEqual({ id: 'A2', material: 'PETG', color: '#1a2b3c' })
    expect(get().slotSetup[2]).toBeUndefined()
    expect(slotMatches(get().printerSlots[1], setting)).toBe(true)
  })

  it('writes nothing when the card is denied', async () => {
    setup()
    const approvals = { register: async () => undefined, grant: async () => ({}), deny: async () => undefined } as unknown as ApprovalHost
    const setSlot = vi.fn()
    const done = writeSlot({ printers: { adjust: { setSlot } }, approvals } as unknown as Host, h2d, 2)
    await vi.waitFor(() => expect(get().approval).not.toBeNull())
    await get().approval!.deny()
    await done
    expect(setSlot).not.toHaveBeenCalled()
    expect(get().slotSetup[2]).toBeDefined()
  })
})
