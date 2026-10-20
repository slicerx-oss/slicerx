// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The print run's fingerprint: what a slice was made from. Moving a part, changing the printer or a filament profile
// changes it, so the slice reads as stale; a camera move does not. The tab's card registry has the send card for
// printer.queue and nothing else, and only the printer pick has a choice card of its own.
import { beforeEach, describe, expect, it } from 'vitest'
import type { MeshHandle } from '@slicerx/contracts'
import { boxMesh } from '../src/plate/mesh-ops'
import { compose } from '../src/plate/transform'
import { get, set, type PlateEntry } from '../src/state/store'
import { appPrintRun, canonicalJson, fnv1a } from '../src/workspaces/mimir/print-run'
import { RUN_APPROVAL_CARDS, runChoiceCard } from '../src/workspaces/mimir/run-cards'
import { SendCard } from '../src/workspaces/mimir/send-card'

const handle: MeshHandle = { id: 'm1', hash: 'm1', name: 'Clip', triangles: 12, bboxMm: [40, 20, 10], openEdges: 0, parts: [{ name: 'Body', slot: 1 }] as MeshHandle['parts'] }
const at = (x: number) => compose({ position: [x, 60, 0], rotation: [0, 0, 0], scale: [1, 1, 1] })
const clip: PlateEntry = { id: 'a', name: 'Clip', handle, parts: [{ ...boxMesh(40, 20, 10), name: 'Body', slot: 1 }], colors: ['#fff'], transform: at(60) }

describe('the print run fingerprint', () => {
  beforeEach(() => {
    set({
      plate: [clip],
      plates: [{ id: 'p1', name: 'Plate 1', objects: [], settings: {} }],
      activePlate: 'p1',
      printerId: 'bay-1',
      overrides: {},
      objectSettings: {},
      activePresets: { process: '0.20mm Standard', filament: 'Generic PLA' },
      slotSetup: { 1: { type: 'PLA', brand: 'Generic', color: '#ffffff' } },
      printerSlots: [{ id: 'A1', material: 'PLA', color: '#ffffff', remainingPct: 80 }],
    })
  })

  const fp = () => appPrintRun().fingerprint()

  it('the fingerprint changes when a part moves', () => {
    const before = fp()
    expect(fp()).toBe(before)
    set({ plate: [{ ...clip, transform: at(90) }] })
    expect(fp()).not.toBe(before)
  })

  it('when the printer changes', () => {
    const before = fp()
    set({ printerId: 'bay-2' })
    expect(fp()).not.toBe(before)
  })

  it('when a filament profile changes', () => {
    const before = fp()
    set({ slotSetup: { 1: { type: 'PETG', brand: 'Generic', color: '#ffffff' } } })
    const afterSlot = fp()
    expect(afterSlot).not.toBe(before)
    set({ activePresets: { ...get().activePresets, filament: 'Generic PETG' } })
    expect(fp()).not.toBe(afterSlot)
  })

  it('and stays the same for a camera move', () => {
    const before = fp()
    set({ camera: get().camera === 'top' ? 'front' : 'top', cameraSeq: get().cameraSeq + 1 })
    // what the spool has left is not what it holds
    set({ printerSlots: [{ id: 'A1', material: 'PLA', color: '#ffffff', remainingPct: 60 }] })
    expect(fp()).toBe(before)
  })

  it('says so for a cycle instead of overflowing the stack', () => {
    const a: Record<string, unknown> = { id: 'a' }
    a.self = a
    expect(() => canonicalJson(a)).toThrow(/circular/i)
    const list: unknown[] = [1]
    list.push({ list })
    expect(() => canonicalJson(list)).toThrow(/circular/i)
    // the same object twice is not a cycle
    const shared = { x: 1 }
    expect(canonicalJson({ a: shared, b: [shared, shared] })).toBe('{"a":{"x":1},"b":[{"x":1},{"x":1}]}')
    // and a cycle is reported again after a fine call (no state is kept between calls)
    expect(() => canonicalJson(a)).toThrow(/circular/i)
  })

  it('is FNV-1a over JSON with sorted keys', () => {
    expect(canonicalJson({ b: 1, a: [1, { d: undefined, c: 'x' }] })).toBe('{"a":[1,{"c":"x"}],"b":1}')
    // the published FNV-1a 32 bit check values
    expect(fnv1a('')).toBe('811c9dc5')
    expect(fnv1a('a')).toBe('e40c292c')
  })
})

describe('the tab card registry', () => {
  it('has the send card for printer.queue, and keeps the choice card for other asks', () => {
    expect(RUN_APPROVAL_CARDS['printer.queue']).toBe(SendCard)
    expect(Object.keys(RUN_APPROVAL_CARDS)).toEqual(['printer.queue'])
    expect(runChoiceCard({ askId: 'a', title: 'Which one?', question: 'Which one?', choices: [{ id: 'yes', label: 'Yes' }], picked: null, actionable: true })).toBeNull()
  })
})
