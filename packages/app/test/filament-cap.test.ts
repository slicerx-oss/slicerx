// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A project holds up to 32 filaments: the rail adds the 17th through the 32nd, parts and spools move onto them, a body
// color plan fills them, and the 33rd is refused in plain words. Paint names filaments 1 to 18 only.
import { COLOR_SLOT_MAX, PAINT_FILAMENT_MAX, planColorSlots, type MeshHandle } from '@slicerx/contracts'
import { beforeEach, describe, expect, it } from 'vitest'
import { bodyColorLimit } from '../src/filament/body-colors'
import { moveToSpool } from '../src/filament/pick'
import { addFilamentTip, addSlot } from '../src/filament/slot-rail'
import { MAX_SLOTS, paintLimitNote, paintSlots, resolved, setSlot, slotCount } from '../src/filament/slots'
import { setPartSlot } from '../src/plate/object-list'
import { get, set, type PlateEntry } from '../src/state/store'

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [1, 1, 1], openEdges: 0, parts: [{ name: 'body', slot: 1, triangles: 12 }] })
const entry = (id: string): PlateEntry => ({ id, name: id, handle: handle(id), parts: [], colors: [], transform: [] })

beforeEach(() => set({ plate: [entry('a')], plates: [{ id: 'plate-1', name: 'Plate 1', objects: [], settings: { sequence: 'by-layer' } }], activePlate: 'plate-1', selection: 'a', selectedIds: ['a'], slotSetup: {}, printerSlots: [], slotDialog: null }))

describe('a project of up to 32 filaments', () => {
  it('holds 32', () => {
    expect(MAX_SLOTS).toBe(32)
    expect(COLOR_SLOT_MAX).toBe(32)
  })

  it('adds the 17th and the 32nd filament from the rail', () => {
    for (let i = 2; i <= 17; i++) addSlot(i)
    expect(resolved()).toHaveLength(17)
    for (let i = 18; i <= 32; i++) addSlot(i)
    expect(resolved()).toHaveLength(32)
    expect(get().slotDialog).toBe(32)
    expect(slotCount(get())).toBe(32)
  })

  it('refuses a 33rd and says why', () => {
    for (let i = 2; i <= 32; i++) setSlot(i, {})
    addSlot(33)
    expect(get().slotSetup[33]).toBeUndefined()
    expect(resolved()).toHaveLength(32)
    expect(addFilamentTip(32)).toEqual({ title: 'Add filament', body: 'Adds filament 32 and opens it to pick the material and color.', reason: 'A project holds 32 filaments at most.' })
    expect(addFilamentTip(16)).toEqual({ title: 'Add filament', body: 'Adds filament 17 and opens it to pick the material and color.' })
  })

  it('moves a part and a spool target onto filament 32, never 33', () => {
    setPartSlot('a', 'body', 32)
    expect(get().plate[0]!.slotOverrides).toEqual({ body: 32 })
    setPartSlot('a', 'body', 33)
    expect(get().plate[0]!.slotOverrides).toEqual({ body: 32 })
    expect(moveToSpool({ kind: 'plate' }, 17)).toBe(1)
    expect(get().plate[0]!.slotOverrides).toEqual({ body: 17 })
    expect(moveToSpool({ kind: 'plate' }, 33)).toBe(0)
  })

  it('plans body colors onto up to 32 filaments', () => {
    expect(bodyColorLimit({ printerSlots: [] })).toBe(32)
    const colors = Array.from({ length: 40 }, (_, i) => `#${(i * 6).toString(16).padStart(2, '0')}00ff`)
    const plan = planColorSlots(colors, [], { limit: 99, threshold: 0 })
    expect(Math.max(...plan.add.map((a) => a.slot))).toBe(32)
  })
})

describe('paint names filaments 1 to 18', () => {
  it('lists only the paintable filaments, and one line says why when some are left out', () => {
    expect(PAINT_FILAMENT_MAX).toBe(18)
    const slots = Array.from({ length: 24 }, (_, i) => ({ index: i + 1 }))
    expect(paintSlots(slots).map((s) => s.index)).toEqual(Array.from({ length: 18 }, (_, i) => i + 1))
    expect(paintLimitNote(24)).toBe('Paint uses filaments 1 to 18. Filaments 19 to 24 print whole parts only.')
    expect(paintLimitNote(19)).toBe('Paint uses filaments 1 to 18. Filament 19 prints whole parts only.')
    expect(paintLimitNote(18)).toBeNull()
  })
})
