// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A design made in the app has no file colors: each part's color follows its filament. Setting a filament's color,
// adding one, moving a part to another or swapping two on the plate reaches the design's own colors at once, and a
// filament nobody set reads its default, never the color the design was first built with. A model from a file keeps
// its own colors.
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import type { History } from '@slicerx/cad-history'
import { beforeEach, describe, expect, it } from 'vitest'
import { partColors } from '../src/cad/commit'
import { followedDesignColors, madeDesign, modelSlotColors, resolveSlots, setSlot, swapPlateSlots } from '../src/filament/slots'
import { createHistory } from '../src/plate/history'
import { setPartSlot } from '../src/plate/object-list'
import { appStore, get, set, type PlateEntry } from '../src/state/store'

const STALE = '#bd93f9'
const part = (name: string, slot: number): MeshPart => ({ name, slot, positions: new Float32Array(9), indices: new Uint32Array([0, 1, 2]) }) as MeshPart
const handle = (id: string, parts: MeshPart[]): MeshHandle => ({ id, hash: id, name: id, triangles: 1, bboxMm: [1, 1, 1], openEdges: 0, parts: parts.map((p) => ({ name: p.name, slot: p.slot, triangles: 1 })) })
const made: History = { version: 1, base: [], steps: [] } as unknown as History
const imported: History = { version: 1, base: [{ name: 'shell' }], steps: [] } as unknown as History

/** A design built here: a bracket of three parts on filaments 1, 2 and 3, colored the way a build left it. */
function design(id = 'bracket'): PlateEntry {
  const parts = [part('plate', 1), part('rib', 2), part('boss', 3)]
  return { id, name: id, handle: handle(id, parts), parts, colors: [STALE, STALE, STALE], transform: [], history: made }
}

/** A lamp shade from a file, its two parts in the file's own colors. */
function fromFile(id = 'shade', history?: History): PlateEntry {
  const parts = [part('shade', 1), part('cap', 2)]
  return { id, name: id, handle: handle(id, parts), parts, colors: ['#e8d8b0', '#2a2a2a'], transform: [], ...(history ? { history } : {}) }
}

const reset = (plate: PlateEntry[]) => set({ plate, plates: [{ id: 'p1', name: 'Plate 1', objects: [], settings: { sequence: 'by-layer' } }], activePlate: 'p1', slotSetup: {}, printerSlots: [], fileSlotColors: [], slotMatch: {}, layerMarks: {}, historyEdit: null, selection: null, selectedIds: [] })
const colorsOf = (id: string) => get().plate.find((p) => p.id === id)!.colors
const slotColor = (n: number) => resolveSlots(get())[n - 1]!.color

beforeEach(() => reset([]))

describe('a made design follows its filaments', () => {
  it('tells a made design from a model with a file behind it', () => {
    expect(madeDesign(design())).toBe(true)
    expect(madeDesign(fromFile())).toBe(false)
    expect(madeDesign(fromFile('vase', imported))).toBe(false)
  })

  it('takes each filament color the moment it is set, and the default for one nobody set', () => {
    reset([design()])
    setSlot(1, { color: '#1a1a1d' })
    setSlot(3, { color: '#c8a040' })
    expect(colorsOf('bracket')).toEqual(['#1a1a1d', slotColor(2), '#c8a040'])
    // filament 2 was never set: it reads its default, not the color the design was built with
    expect(resolveSlots(get())[1]!.source).toBe('default')
    expect(slotColor(2)).not.toBe(STALE)
    setSlot(2, { color: '#f0f0ea' })
    expect(colorsOf('bracket')).toEqual(['#1a1a1d', '#f0f0ea', '#c8a040'])
  })

  it('follows a part moved to another filament, and a filament added for it', () => {
    reset([design()])
    setSlot(2, { color: '#3060c0' })
    setPartSlot('bracket', 'boss', 2)
    expect(colorsOf('bracket')[2]).toBe('#3060c0')
    setSlot(4, { color: '#20a060' })
    setPartSlot('bracket', 'rib', 4)
    expect(colorsOf('bracket')).toEqual([slotColor(1), '#20a060', '#3060c0'])
  })

  it('follows a swap of two filaments on the plate', () => {
    reset([design()])
    setSlot(1, { color: '#aa2222' })
    setSlot(2, { color: '#2222aa' })
    swapPlateSlots('p1', 1, 2)
    expect(colorsOf('bracket').slice(0, 2)).toEqual(['#2222aa', '#aa2222'])
  })

  it('follows on a plate that is not open', () => {
    reset([])
    set((s) => ({ plates: [...s.plates, { id: 'p2', name: 'Plate 2', objects: [design('hook')], settings: { sequence: 'by-layer' } }] }))
    setSlot(3, { color: '#808020' })
    expect(get().plates.find((p) => p.id === 'p2')!.objects[0]!.colors[2]).toBe('#808020')
  })

  it('never feeds its old colors back as a filament color', () => {
    reset([design()])
    expect(modelSlotColors(get()).filter(Boolean)).toEqual([])
    for (const r of resolveSlots(get())) expect(r.color).not.toBe(STALE)
  })

  it('undoes with the filament change, in one step', () => {
    reset([design()])
    const h = createHistory(appStore)
    try {
      const before = colorsOf('bracket')
      setSlot(2, { color: '#d04080' })
      expect(colorsOf('bracket')[1]).toBe('#d04080')
      expect(h.state().undo).toBe(1)
      h.undo()
      expect(get().slotSetup[2]).toBeUndefined()
      expect(colorsOf('bracket')).toEqual(before)
    } finally {
      h.dispose()
    }
  })

  it('builds new parts in their filament colors', () => {
    reset([design()])
    setSlot(2, { color: '#6040a0' })
    const parts = [part('plate', 1), part('rib', 2), part('boss', 3), part('lug', 2)]
    expect(partColors(design(), parts, made, STALE)).toEqual([slotColor(1), '#6040a0', slotColor(3), '#6040a0'])
  })
})

describe('a model from a file keeps its own colors', () => {
  it('as they are when a filament is set, with or without a history on it', () => {
    reset([fromFile(), fromFile('vase', imported)])
    setSlot(1, { color: '#102030' })
    expect(colorsOf('shade')).toEqual(['#e8d8b0', '#2a2a2a'])
    expect(colorsOf('vase')).toEqual(['#e8d8b0', '#2a2a2a'])
    // and they still name the filament a person has not set
    expect(slotColor(2)).toBe('#2a2a2a')
    expect(followedDesignColors(get())).toBeNull()
    expect(partColors(fromFile('vase', imported), [part('shade', 1), part('cap', 2), part('foot', 2)], imported, STALE)).toEqual(['#e8d8b0', '#2a2a2a', '#2a2a2a'])
  })
})
