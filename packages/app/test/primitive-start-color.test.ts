// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A shape added in the app starts in its filament's color, off-white for filament 1 when nothing is set, and draws so in
// Model and Slice: never the edition's accent. A filament the person sets shows over it, and it goes back when unset.
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { beforeEach, describe, expect, it } from 'vitest'
import { brandAccent } from '../src/edition'
import { resolveSlots, setSlot, resetSlots, startColor } from '../src/filament/slots'
import { addPrimitive } from '../src/plate/edit'
import { get, set } from '../src/state/store'
import { modelLook, platePayload } from '../src/viewport/viewport-host'

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [1, 1, 1], openEdges: 0, parts: [{ name: id, slot: 1, triangles: 12 }] })
const loader = { loadParts: async (name: string, _parts: MeshPart[]) => handle(name) }
const OFF_WHITE = '#f8f8f2'

beforeEach(() => set({ plate: [], plates: [{ id: 'p1', name: 'Plate 1', objects: [], settings: { sequence: 'by-layer' } }], activePlate: 'p1', slotSetup: {}, printerSlots: [], fileSlotColors: [], slotMatch: {}, layerMarks: {}, historyEdit: null, selection: null, selectedIds: [], workspace: 'prepare', look: 'studio' }))

/** The colors the view draws the plate's parts in. */
const drawn = () => platePayload(get(), null).objects.flatMap((o) => o.parts.map((p) => p.color))

describe('a shape added in the app', () => {
  for (const shape of ['box', 'cylinder'] as const) {
    it(`a ${shape} starts in filament 1's color, off-white with nothing set, in Model and in Slice`, async () => {
      expect(await addPrimitive(loader, shape, 'object')).not.toBeNull()
      const e = get().plate[0]!
      expect(e.colors).toEqual([OFF_WHITE])
      expect(e.colors).not.toContain(brandAccent())
      // filament 1 reads off-white too, so nothing on screen shows the accent
      expect(resolveSlots(get())[0]!.color).toBe(OFF_WHITE)
      for (const modelMode of ['design', 'slice'] as const) {
        set({ modelMode })
        expect(drawn()).toEqual([OFF_WHITE])
      }
      expect(modelLook({ workspace: 'prepare', modelMode: 'design', look: 'studio' })).toBe('cadColor')
    })
  }

  it('shows a filament color the person sets over its own, and its own again once unset', async () => {
    await addPrimitive(loader, 'cylinder', 'object')
    setSlot(1, { color: '#2b6cb0' })
    expect(drawn()).toEqual(['#2b6cb0'])
    // the object keeps its own start color: the person's choice is not copied into it
    expect(get().plate[0]!.colors).toEqual([OFF_WHITE])
    resetSlots(1)
    expect(drawn()).toEqual([OFF_WHITE])
  })

  it('keeps a black filament black in what it stores and sends: the lift is the view drawing it', async () => {
    await addPrimitive(loader, 'box', 'object')
    setSlot(1, { color: '#101012' })
    expect(get().slotSetup[1]!.color).toBe('#101012')
    expect(resolveSlots(get())[0]!.color).toBe('#101012')
    // the view is handed the filament's own color, in Model and in Slice; only the CAD look's drawing lifts it
    // (packages/ui/viewport/test/cad-look.test.ts)
    for (const modelMode of ['design', 'slice'] as const) {
      set({ modelMode })
      expect(drawn()).toEqual(['#101012'])
    }
  })

  it('starts a shape on another filament in that filament color', () => {
    expect(startColor(2)).toBe(resolveSlots(get(), 2)[1]!.color)
    expect(startColor(2)).not.toBe(brandAccent())
  })
})
