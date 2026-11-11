// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A kept project brought back by Reopen after the printer reported its spools. The project holds an empty list for each
// filament override its filament did not set (a cut retraction among them); the loaded filament sets one (18 mm). That
// empty list is no change and is never pinned over the filament's value, so a project with nothing else changed reopens
// as it was, and one with a real change reopens with that change only. Its note says it was opened again, never
// "Applied N settings from" alone, as if a new file had come in. Opening the file the first time still says Applied.
import { describe, expect, it } from 'vitest'
import type { Host, MeshHandle, SettingValue } from '@slicerx/contracts'
import type { PlateEntry } from '../src/state/store'

const { openModelBytes } = await import('../src/state/actions')
const { openSnapshot } = await import('../src/project/autosave')
const { profileReady, startProfileSync } = await import('../src/state/profile-sync')
const { startProjectPrinterSync } = await import('../src/project/project-printer')
const { get, set } = await import('../src/state/store')
const { goalEasy, resolveConfig } = await import('../src/adapters/config')
const { sx3mfBytes } = await import('../src/export/actions')
const { allPlates } = await import('../src/plate/plates')
const { setSlot } = await import('../src/filament/slots')
const { boxMesh } = await import('../src/plate/mesh-ops')
const { compose } = await import('../src/plate/transform')

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [20, 20, 20], openEdges: 0, parts: [] })
const host = { kind: 'web', capabilities: { threads: 1 }, slicer: { loadParts: async (name: string, parts: { name: string; slot?: number }[]) => ({ ...handle(name), parts: parts.map((p) => ({ name: p.name, slot: p.slot ?? 1, triangles: 12 })) }) } } as unknown as Host
const entry = (id: string): PlateEntry => ({ id, name: id, handle: handle(id), parts: [{ ...boxMesh(20, 20, 20), name: id }], colors: ['#bd93f9'], transform: compose({ position: [128, 128, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }) })
const A1 = { id: 'my-a1', vendor: 'Bambu Lab', model: 'A1' }
const CUT = 'filament_retraction_distances_when_cut'
const NAME = 'Cable_clip.sx3mf'
const buf = (b: Uint8Array): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer

async function settled(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 30))
    await profileReady()
  }
}
const config = (): Record<string, SettingValue> => resolveConfig(get().easy, get().overrides) as unknown as Record<string, SettingValue>

/** A fresh A1 plate on Standard, generic PLA, no edits. */
async function fresh(): Promise<void> {
  set((s) => ({ easy: { ...s.easy, ...goalEasy('standard') }, plate: [], plates: [{ ...s.plates[0]!, id: 'plate-1', name: 'Plate 1', objects: [], settings: {} }], activePlate: 'plate-1', projectSettings: null, projectPrinter: null, projectOpenAsk: null, fileSlotColors: [], slotSetup: {}, openNote: null, printerId: A1.id, printerModel: A1, printerNozzles: {}, nozzleReported: {}, easyTouched: [], goal: 'standard', goalBase: 'standard', overrides: {}, vouchedGcode: {}, toast: null }))
  startProfileSync()
  startProjectPrinterSync()
  await settled()
}

/** The plate kept on generic PLA, before the printer reports its spools, with the person's own `edits`. */
async function kept(edits: Record<string, SettingValue> = {}): Promise<Uint8Array> {
  await fresh()
  set({ plate: [entry('clip')], overrides: edits, ...(Object.keys(edits).length ? { goal: 'custom' as const } : {}) })
  await settled()
  expect(config()[CUT]).toEqual(edits[CUT] ?? [])
  return sx3mfBytes(allPlates(get()))
}

/** The printer reports its spool: Bambu PLA Basic, which sets an 18 mm cut retraction. */
async function spoolLoads(): Promise<void> {
  await fresh()
  setSlot(1, { type: 'PLA', vendor: 'BBL', family: 'Bambu PLA Basic', color: '#00AE42' })
  await settled()
  expect(config()[CUT]).toEqual([18])
}

async function reopen(data: Uint8Array): Promise<void> {
  await openSnapshot(host, { id: `recent:${NAME.toLowerCase()}`, name: NAME, savedAt: Date.now(), objects: 1, data, dirty: true })
  await settled()
}

describe('Reopen after the printer reported its spools', () => {
  it('changes nothing when only the filament differs, and says it was opened again', async () => {
    const data = await kept()
    await spoolLoads()
    await reopen(data)
    expect(get().plate.map((p) => p.name)).toEqual(['clip'])
    expect(get().openNote?.text).toBe(`Opened ${NAME} again`)
    expect(get().goal).not.toBe('custom')
    expect(get().overrides).not.toHaveProperty(CUT)
    expect(config()[CUT]).toEqual([18])
  })

  it('brings back a real change with its settings, and keeps the filament its cut retraction', async () => {
    const data = await kept({ layer_height: 0.12 })
    await spoolLoads()
    await reopen(data)
    expect(config()['layer_height']).toBe(0.12)
    expect(get().openNote?.text).toBe(`Opened ${NAME} again with its settings`)
    expect(get().openNote?.text).not.toMatch(/Applied/)
    expect(get().overrides).not.toHaveProperty(CUT)
    expect(config()[CUT]).toEqual([18])
  })

  it("brings back a person's own cut retraction", async () => {
    const data = await kept({ [CUT]: [12] })
    await spoolLoads()
    await reopen(data)
    expect(config()[CUT]).toEqual([12])
    expect(get().openNote?.text).toBe(`Opened ${NAME} again with its settings`)
  })
})

describe('A first open of our own project after the printer reported its spools', () => {
  it('takes no empty filament override, and says Applied for a real change', async () => {
    const plain = await kept()
    await spoolLoads()
    await openModelBytes(host, NAME, buf(plain), undefined, { fresh: true })
    await settled()
    expect(get().openNote?.text ?? '').not.toMatch(/Applied/)
    expect(get().goal).not.toBe('custom')
    expect(config()[CUT]).toEqual([18])

    const edited = await kept({ layer_height: 0.12 })
    await spoolLoads()
    await openModelBytes(host, NAME, buf(edited), undefined, { fresh: true })
    await settled()
    expect(get().openNote?.text ?? '').toMatch(new RegExp(`^Applied \\d+ settings from ${NAME.replace('.', '\\.')}`))
    expect(config()['layer_height']).toBe(0.12)
    expect(config()[CUT]).toEqual([18])
  })
})
