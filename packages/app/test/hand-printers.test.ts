// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { beforeEach, describe, expect, it } from 'vitest'
import type { ApprovalHost, Host, PrinterHost, PrinterInfo, PrinterStatus } from '@slicerx/contracts'
import { connectBridge, resetBridge, setBridgeConnector, type ConnectedBridge } from '../src/link/bridge'
import { registerPrinterSetup } from '../src/first-run/setup-registry'
// Connecting loads these; loaded here, they do not outlive the test environment.
import '../src/inventory/usage'
import '../src/state/actions'
import { migrateSetupPrinters, setupHostFor } from '../src/first-run/setup-host'
import { filamentInput } from '../src/first-run/printer-form'
import { addHandPrinter, handSlots, isExportOnly, LEGACY_SETUP_KEY, withHandPrinters } from '../src/lib/hand-printers'
import { fleetQuery } from '../src/lib/queries'
import { printTarget, shownPrinter } from '../src/lib/use-printer'
import { loadPrefs, normalizePrefs } from '../src/state/prefs'
import { profileIdFor } from '../src/workspaces/prepare/printer-base'
import { get, set } from '../src/state/store'

const bay: PrinterInfo = { id: 'bay-2', name: 'Bay 2', vendor: 'Bambu Lab', model: 'P1S', plugin: 'bambu-lan', host: '192.0.2.12', nozzleCount: 1 }
const idle = (id: string): PrinterStatus => ({ printerId: id, state: 'idle', nozzles: [], slots: [], cameraAvailable: false, updatedAt: '' })

function demoPrinters(extra: PrinterInfo[] = []): PrinterHost {
  return { list: async () => [bay, ...extra], status: async (id: string) => idle(id), subscribe: () => () => undefined, fleets: async () => [] } as unknown as PrinterHost
}

function host(printers: PrinterHost = demoPrinters()): Host {
  return { printers: withHandPrinters(printers), approvals: {} as ApprovalHost, secrets: { set: async () => undefined }, capabilities: { printers: 'sim', secureStorage: false } } as unknown as Host
}

async function rows(h: Host) {
  const q = fleetQuery(h.printers)
  return (q.queryFn as () => Promise<Awaited<ReturnType<NonNullable<typeof q.queryFn>>>>)()
}

beforeEach(() => {
  resetBridge()
  setBridgeConnector(null)
  registerPrinterSetup(null)
  localStorage.clear()
  set({ handPrinters: [], printerId: null, printerNozzles: {}, bridgeStatus: { state: 'off' } })
})

describe('printers added by hand', () => {
  it('joins the printers with no connection, is shown once selected, and exports instead of sending', async () => {
    const h = host()
    const { printerId } = await setupHostFor(h).addPrinter({ profileId: 'bambu-a1', nozzleMm: 0.4, name: 'A1' })
    expect(printerId).toBe('local-bambu-a1')
    // Setup closing selects it, as first-run does with the outcome's printer id.
    set({ printerId })
    const list = await rows(h)
    expect(list.map((r) => r.id)).toEqual(['bay-2', 'local-bambu-a1'])
    const shown = shownPrinter(list, get().printerId)
    expect(shown).toMatchObject({ id: 'local-bambu-a1', name: 'A1', vendor: 'Bambu Lab', model: 'A1', plugin: 'export' })
    expect(isExportOnly(shown!)).toBe(true)
    // Its profile drives the slice: bed, start G-code and limits of the A1.
    expect(profileIdFor(shown)).toBe('bambu-a1')
    expect(printTarget(shown, list)).toBeUndefined()
    expect(get().printerNozzles['local-bambu-a1']).toBe(0.4)
    await expect(h.printers!.upload('local-bambu-a1', { name: 'a.gcode' } as never, {} as never)).rejects.toThrow(/no connection/)
    // A second A1 gets its own id; the host's printer ids are never reused.
    expect(addHandPrinter({ name: 'A1 2', profileId: 'bambu-a1', vendor: 'Bambu Lab', model: 'A1', nozzleCount: 1 }, 0.2)).toBe('local-bambu-a1-2')
  })

  it('shows no live state for it in the setup scan', async () => {
    const h = host()
    await setupHostFor(h).addPrinter({ profileId: 'bambu-a1', nozzleMm: 0.4, name: 'A1' })
    const found = (await setupHostFor(h).discover()).find((f) => f.id === 'local-bambu-a1')
    expect(found).toMatchObject({ family: 'export', filamentSystem: 'ams' })
    expect(found?.state).toBeUndefined()
  })

  it("keeps the wizard's AMS units and slots, gives them as the printer's slots, and keeps them after a reload", async () => {
    const h = host()
    // two AMS units picked in the wizard on an A1, whose catalog entry has one
    const { printerId } = await setupHostFor(h).addPrinter({ profileId: 'bambu-a1', nozzleMm: 0.4, name: 'A1', filament: { system: 'ams', slots: 8 } })
    expect(get().handPrinters.find((p) => p.id === printerId)).toMatchObject({ filamentSystem: 'ams', slotCount: 8 })
    const st = await h.printers!.status(printerId)
    // named as the printer's own report names AMS slots: a letter per unit from A, four places each
    expect(st.slots.map((x) => x.id)).toEqual(['A1', 'A2', 'A3', 'A4', 'B1', 'B2', 'B3', 'B4'])
    expect(st.slots.every((x) => x.material === undefined && x.color === undefined)).toBe(true)
    const back = normalizePrefs(JSON.parse(localStorage.getItem('slicerx.prefs.v1') ?? '{}') as unknown)
    expect(back.handPrinters?.[0]).toMatchObject({ id: printerId, filamentSystem: 'ams', slotCount: 8 })
  })

  it('keeps a single spool picked over the catalog AMS, and an MMU or other unit by its slot count', async () => {
    const h = host()
    const one = (await setupHostFor(h).addPrinter({ profileId: 'bambu-a1', nozzleMm: 0.4, name: 'A1 single', filament: { system: 'single', slots: 1 } })).printerId
    const rec = get().handPrinters.find((p) => p.id === one)!
    expect(rec.filamentSystem).toBeUndefined()
    expect(rec.slotCount).toBeUndefined()
    expect((await h.printers!.status(one)).slots).toEqual([])
    const mmu = (await setupHostFor(h).addPrinter({ profileId: 'prusa-mk4s', nozzleMm: 0.4, filament: { system: 'mmu', slots: 5 } })).printerId
    expect(get().handPrinters.find((p) => p.id === mmu)).toMatchObject({ filamentSystem: 'mmu', slotCount: 5 })
    expect((await h.printers!.status(mmu)).slots.map((x) => x.id)).toEqual(['1', '2', '3', '4', '5'])
    // a printer added before the wizard kept its choice has no slots, as before
    const old = addHandPrinter({ name: 'Old', profileId: 'bambu-a1', vendor: 'Bambu Lab', model: 'A1', nozzleCount: 1, filamentSystem: 'ams' }, 0.4)
    expect((await h.printers!.status(old)).slots).toEqual([])
    // a slot count outside what any unit has is dropped on reload
    expect(normalizePrefs({ handPrinters: [{ ...rec, id: 'x', filamentSystem: 'ams', slotCount: 99 }] }).handPrinters?.[0]?.slotCount).toBeUndefined()
  })

  it('keeps no unit when setup says none on a printer whose catalog has an AMS, as the connected path names none', async () => {
    const h = host()
    for (const profileId of ['bambu-a1', 'bambu-x1-carbon']) {
      const filament = filamentInput({ kind: 'none', units: 1, slots: 1 })
      const { printerId } = await setupHostFor(h).addPrinter({ profileId, nozzleMm: 0.4, filament })
      const rec = get().handPrinters.find((p) => p.id === printerId)!
      expect(rec.filamentSystem, profileId).toBeUndefined()
      expect(rec.slotCount, profileId).toBeUndefined()
      expect((await h.printers!.status(printerId)).slots, profileId).toEqual([])
      expect((await rows(h)).find((r) => r.id === printerId)?.filamentSystem, profileId).toBeUndefined()
    }
  })

  it('names AMS HT slots after the AMS slots, E1 on, as a connected printer names them, and keeps the count after a reload', async () => {
    expect(handSlots({ filamentSystem: 'ams', slotCount: 5, amsHtUnits: 1 }).map((x) => x.id)).toEqual(['A1', 'A2', 'A3', 'A4', 'E1'])
    expect(handSlots({ filamentSystem: 'ams', slotCount: 10, amsHtUnits: 2 }).map((x) => x.id)).toEqual(['A1', 'A2', 'A3', 'A4', 'B1', 'B2', 'B3', 'B4', 'E1', 'F1'])
    expect(handSlots({ filamentSystem: 'ams', slotCount: 8 }).map((x) => x.id)).toEqual(['A1', 'A2', 'A3', 'A4', 'B1', 'B2', 'B3', 'B4'])
    const h = host()
    // an X1 Carbon added by hand with two AMS units and one AMS HT
    const { printerId } = await setupHostFor(h).addPrinter({ profileId: 'bambu-x1-carbon', nozzleMm: 0.4, name: 'X1C', filament: { system: 'ams', slots: 9, htUnits: 1 } })
    expect(get().handPrinters.find((p) => p.id === printerId)).toMatchObject({ filamentSystem: 'ams', slotCount: 9, amsHtUnits: 1 })
    expect((await h.printers!.status(printerId)).slots.map((x) => x.id)).toEqual(['A1', 'A2', 'A3', 'A4', 'B1', 'B2', 'B3', 'B4', 'E1'])
    const back = normalizePrefs(JSON.parse(localStorage.getItem('slicerx.prefs.v1') ?? '{}') as unknown).handPrinters?.find((p) => p.id === printerId)
    expect(back).toMatchObject({ slotCount: 9, amsHtUnits: 1 })
    // nine units, a fraction, a count that leaves no AMS unit, or one on another system is dropped
    for (const bad of [{ amsHtUnits: 9 }, { amsHtUnits: 1.5 }, { slotCount: 4, amsHtUnits: 1 }, { filamentSystem: 'mmu', amsHtUnits: 1 }]) expect(normalizePrefs({ handPrinters: [{ ...back, id: 'x', ...bad }] }).handPrinters?.[0]?.amsHtUnits, JSON.stringify(bad)).toBeUndefined()
  })

  it('stays after a reload', async () => {
    await setupHostFor(host()).addPrinter({ profileId: 'bambu-a1-mini', nozzleMm: 0.2 })
    const saved = JSON.parse(localStorage.getItem('slicerx.prefs.v1') ?? '{}') as unknown
    const back = normalizePrefs(saved)
    expect(back.handPrinters).toMatchObject([{ id: 'local-bambu-a1-mini', name: 'A1 mini', profileId: 'bambu-a1-mini', vendor: 'Bambu Lab', model: 'A1 mini', nozzleCount: 1 }])
    expect(back.printerNozzles).toEqual({ 'local-bambu-a1-mini': 0.2 })
    expect(loadPrefs().handPrinters).toHaveLength(1)
  })

  it('hands a Bambu LAN printer to the desktop bridge, waiting for it to start', async () => {
    const added: unknown[] = []
    const hub = demoPrinters()
    const bridge: ConnectedBridge = {
      printers: hub,
      approvals: {} as ApprovalHost,
      setup: {
        discover: async () => [],
        testConnection: async () => ({ ok: true, steps: [] }),
        addPrinter: async (input) => {
          added.push(input)
          return { printerId: 'a1-01p00a000000000' }
        },
      },
      close: () => undefined,
    }
    setBridgeConnector({ automatic: true, connect: async () => bridge })
    const h = host()
    const epoch = get().linkEpoch
    const { printerId } = await setupHostFor(h).addPrinter({ profileId: 'bambu-a1', nozzleMm: 0.4, connection: { family: 'bambu-lan', address: '192.168.1.40', serial: '01P00A000000000', credential: '12345678' } })
    expect(printerId).toBe('a1-01p00a000000000')
    expect(get().bridgeStatus.state).toBe('on')
    expect(added).toHaveLength(1)
    expect(get().handPrinters).toEqual([])
    expect(get().linkEpoch).toBeGreaterThan(epoch)
  })

  it('keeps a connection saved without a bridge, and connects it when one comes up', async () => {
    const h = host()
    const klipper = await setupHostFor(h).addPrinter({ profileId: 'voron-2-4-350', nozzleMm: 0.4, name: 'Voron', connection: { family: 'moonraker', address: '192.168.1.50' } })
    const bambu = await setupHostFor(h).addPrinter({ profileId: 'bambu-a1', nozzleMm: 0.4, connection: { family: 'bambu-lan', address: '192.168.1.40', serial: '01P00A000000000', credential: '12345678' } })
    expect(get().handPrinters.map((x) => [x.id, x.connection?.needsSecret])).toEqual([
      [klipper.printerId, false],
      [bambu.printerId, true],
    ])
    expect(JSON.stringify(get().handPrinters)).not.toContain('12345678')
    set({ printerId: klipper.printerId })
    const added: { name: string }[] = []
    const promoted: PrinterInfo = { id: 'voron', name: 'Voron', vendor: 'Voron', model: 'Voron 2.4 350', plugin: 'moonraker', nozzleCount: 1 }
    setBridgeConnector({
      automatic: false,
      connect: async () => ({
        printers: demoPrinters([promoted]),
        approvals: {} as ApprovalHost,
        setup: { discover: async () => [], testConnection: async () => ({ ok: true, steps: [] }), addPrinter: async (input) => (added.push(input as { name: string }), { printerId: 'voron' }) },
        close: () => undefined,
      }),
    })
    expect(await connectBridge(h, 'ABCD1234')).toBe(true)
    await new Promise((r) => setTimeout(r, 0))
    // The Klipper printer needs no code, so it is a real connection now and stays selected; the A1 waits for its code.
    expect(added.map((a) => a.name)).toEqual(['Voron'])
    expect(get().printerId).toBe('voron')
    expect(get().handPrinters.map((x) => x.id)).toEqual([bambu.printerId])
    expect((await rows(h)).map((r) => r.id)).toEqual(['bay-2', 'voron', bambu.printerId])
  })

  it('moves the old setup list into the store once and drops the key', async () => {
    localStorage.setItem(LEGACY_SETUP_KEY, JSON.stringify([{ printerId: 'local-bambu-a1', name: 'A1', profileId: 'bambu-a1', nozzleMm: 0.6 }, { printerId: 'local-bambu-p1s', name: 'P1S', profileId: 'bambu-p1s', nozzleMm: 0.4, family: 'bambu-lan', address: '192.168.1.41' }]))
    set({ printerId: 'local-bambu-a1' })
    migrateSetupPrinters()
    expect(localStorage.getItem(LEGACY_SETUP_KEY)).toBeNull()
    expect(get().handPrinters).toMatchObject([
      { id: 'local-bambu-a1', vendor: 'Bambu Lab', model: 'A1' },
      { id: 'local-bambu-p1s', model: 'P1S', connection: { family: 'bambu-lan', address: '192.168.1.41', needsSecret: true } },
    ])
    expect(get().printerNozzles['local-bambu-a1']).toBe(0.6)
    const list = await rows(host())
    expect(shownPrinter(list, get().printerId)?.id).toBe('local-bambu-a1')
    migrateSetupPrinters()
    expect(get().handPrinters).toHaveLength(2)
  })
})
