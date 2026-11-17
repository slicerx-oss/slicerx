// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A painted project opens with every filament its file lists and its paint uses. A Bambu Studio project whose only
// object prints with filament 2 and is painted in filaments 1 to 3 listed only filaments 1 and 2 on the Filament card,
// drew its filament 3 paint in a fallback off-white, and sliced with two filaments. The card now lists all four of the
// file's filaments (the fourth used by nothing), paint draws in each filament's color, and the slice carries the three
// filaments the plate prints, with a color, a flush row and values for each. A printer reporting four AMS slots gives
// the same three. packages/app/test/project-route-parity.test.ts slices it and checks which filament prints each band.
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import type { FilamentSlot, Host, MeshHandle } from '@slicerx/contracts'
import { BAND_COLORS, bandedProject } from '../../mcp/test/banded-project'

const { openModelBytes } = await import('../src/state/actions')
const { profileReady, startProfileSync } = await import('../src/state/profile-sync')
const { startProjectPrinterSync } = await import('../src/project/project-printer')
const { get, set } = await import('../src/state/store')
const { plateSliceConfig } = await import('../src/state/slice-plate')
const { activeMeta } = await import('../src/plate/plates')
const { useResolvedSlots } = await import('../src/filament/use-slots')
const { paintColors } = await import('../src/viewport/viewport-host')
const { loadFlushData } = await import('../src/filament/flush')
const { loadedSlotCount, slotCount } = await import('../src/filament/slots')

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [20, 20, 20], openEdges: 0, parts: [] })
const host = { kind: 'web', capabilities: { threads: 1 }, slicer: { loadParts: async (name: string, parts: { name: string; slot?: number }[]) => ({ ...handle(name), parts: parts.map((p) => ({ name: p.name, slot: p.slot ?? 1, triangles: 12 })) }) } } as unknown as Host
const buf = (b: Uint8Array): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
const A1 = { id: 'my-a1', vendor: 'Bambu Lab', model: 'A1' }
const FILE = BAND_COLORS.map((c) => c.toLowerCase())
// An AMS lite loaded with other shades than the file's, so the slots read as the printer's.
const AMS: FilamentSlot[] = ['#F2F2F2', '#161616', '#D01010', '#7A1FA0'].map((color, i) => ({ id: `A${i + 1}`, material: 'PLA', color }))

async function settled(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 30))
    await profileReady()
  }
}

async function open(printerSlots: FilamentSlot[]): Promise<void> {
  set((s) => ({ plate: [], plates: [{ ...s.plates[0]!, id: 'plate-1', name: 'Plate 1', objects: [], settings: {} }], activePlate: 'plate-1', slotSetup: {}, slotMatch: {}, printerSlots, projectSettings: null, projectPrinter: null, projectOpenAsk: null, fileSlotColors: [], fileSlotTypes: [], printerId: A1.id, printerModel: A1, printerNozzles: {}, nozzleReported: {}, easyTouched: [], goal: 'standard', goalBase: 'standard', overrides: {}, vouchedGcode: {}, toast: null }))
  await settled()
  await openModelBytes(host, 'banded.3mf', buf(bandedProject()), undefined, { fresh: true })
  await settled()
  await loadFlushData()
}

beforeEach(() => {
  startProfileSync()
  startProjectPrinterSync()
})

describe('a project painted in filaments its parts do not print with', () => {
  it("lists every filament the file has on the Filament card, the paint's filaments used", async () => {
    await open([])
    const { result } = renderHook(() => useResolvedSlots())
    expect(result.current.map((r) => r.color)).toEqual(FILE)
    expect(result.current.map((r) => r.used)).toEqual([true, true, true, false])
    // Nothing was left unpainted, so the open says nothing.
    expect(get().toast).toBeNull()
  })

  it('counts the filaments its part and paint print with as loaded, and the one the file only lists as not', async () => {
    await open([])
    // a color change noted on filament 4 says it is not loaded (the layer pins read the loaded slots)
    expect(slotCount(get())).toBe(4)
    expect(loadedSlotCount(get())).toBe(3)
  })

  it("draws paint in each filament's color, filament 3 in red", async () => {
    await open([])
    const colors = paintColors(get())
    expect(colors).toEqual(FILE)
    // the painter draws paint on filament k in colors[k - 1]
    expect(colors[3 - 1]).toBe('#ff0000')
  })

  it('slices with the three filaments the plate prints, each with a color and a flush row', async () => {
    await open([])
    const cfg = plateSliceConfig(get(), activeMeta(get())) as unknown as Record<string, unknown>
    expect(cfg['filament_colour']).toEqual(FILE.slice(0, 3))
    expect(cfg['filament_type']).toEqual(['PLA', 'PLA', 'PLA'])
    expect((cfg['flush_volumes_matrix'] as unknown[]).length % 9).toBe(0)
  })

  it('gives the same three on a printer that reports four AMS slots', async () => {
    await open(AMS)
    const { result } = renderHook(() => useResolvedSlots())
    expect(result.current.map((r) => r.source)).toEqual(['printer', 'printer', 'printer', 'printer'])
    expect(result.current.map((r) => r.used)).toEqual([true, true, true, false])
    expect(paintColors(get())).toEqual(AMS.map((a) => a.color!.toLowerCase()))
    const cfg = plateSliceConfig(get(), activeMeta(get())) as unknown as Record<string, unknown>
    expect(cfg['filament_colour']).toEqual(AMS.slice(0, 3).map((a) => a.color!.toLowerCase()))
    expect((cfg['flush_volumes_matrix'] as unknown[]).length % 9).toBe(0)
  })
})
