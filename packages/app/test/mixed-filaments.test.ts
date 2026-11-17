// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { beforeEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { costWords, cycleWords } from '../src/filament/mix-dialog'
import { SlotRail } from '../src/filament/slot-rail'
import { resolved } from '../src/filament/slots'
import { objectWarnings, setPartSlot } from '../src/plate/object-list'
import { objectSlots } from '../src/filament/slots'
import type { MeshHandle } from '@slicerx/contracts'
import { readProject, readProjectsWithGeom } from '../src/export/import3mf'
import { projectFiles, writeProject } from '../src/export/threemf'
import { addMix, colorsWithMixes, mergeMixes, mixesOf, printerClash, removeMix, stripes, updateMix } from '../src/filament/mixes'
import { clearClipboard, copySelection, pasteClipboard } from '../src/plate/clipboard'
import { slotConfig } from '../src/filament/slot-config'
import { colorPaintStates, remapPaintText } from '../src/plate/paint-states'
import { moveObjectsToPlate } from '../src/plate/move-to-plate'
import { runCall } from '../src/app-link/methods'
import { history } from '../src/plate/history'
import { setSlot } from '../src/filament/slots'
import { slotCount, usedSlots } from '../src/filament/slots'
import { boxMesh } from '../src/plate/mesh-ops'
import { plateConfig } from '../src/plate/plates'
import { compose } from '../src/plate/transform'
import { get, set, type PlateEntry } from '../src/state/store'

const bed = { widthMm: 256, depthMm: 256 }
const handle = (id: string, slot = 1): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [10, 10, 10], openEdges: 0, parts: [{ name: 'Body', slot, triangles: 12 }] })

function entry(id: string, slot: number): PlateEntry {
  return { id, name: 'Box', handle: handle(id, slot), parts: [{ ...boxMesh(10, 10, 10), name: 'Body', slot }], colors: ['#ffffff'], transform: compose({ position: [50, 60, 5], rotation: [0, 0, 0], scale: [1, 1, 1] }) }
}

const purple = { name: 'Purple', components: [1, 2] as [number, number], ratio: [2, 1] as [number, number] }

describe('mixed filaments of a project', () => {
  beforeEach(() => {
    set({ plates: [{ id: 'p1', name: 'Plate 1', objects: [], settings: {} }], activePlate: 'p1', plate: [entry('a', 1)], slotSetup: {}, printerSlots: [], mixes: [] })
  })

  it('take the top filament number, slice as the plate setting when used, and leave a plate without one as it was', () => {
    expect(plateConfig(get().plates[0])).toEqual({})
    const m = addMix(purple, 2)
    expect(m).toMatchObject({ id: 32, name: 'Purple', components: [1, 2], ratio: [2, 1] })
    // A mix nothing uses yet stays out of the slice.
    expect(plateConfig(get().plates[0])).toEqual({})
    set({ plate: [entry('a', 32)] })
    expect(plateConfig(get().plates[0])).toEqual({ mixed_filaments: ['32:1,2:2,1:Purple'] })
    // Paint in the mix counts as using it.
    set({ plate: [{ ...entry('a', 1), paint: { 0: { color: { 3: 'EFC' } } } }] })
    expect(plateConfig(get().plates[0])).toEqual({ mixed_filaments: ['32:1,2:2,1:Purple'] })
    set({ plate: [entry('a', 1)] })
    expect(addMix({ ...purple, components: [1, 1] }, 2)).toMatch(/two different/)
    expect(updateMix(32, { ratio: [3, 2] }, 2)).toMatchObject({ ratio: [3, 2] })
    expect(mixesOf(get())).toHaveLength(1)
  })

  it('count as their two filaments, never as a slot of their own', () => {
    addMix(purple, 2)
    set({ plate: [entry('a', 32)] })
    expect(slotCount(get())).toBe(2)
    expect([...usedSlots(get())].sort()).toEqual([1, 2])
  })

  it('show a predicted color at their number and stripes in a swatch', () => {
    addMix({ ...purple, ratio: [1, 1] }, 2)
    const colors = colorsWithMixes(get(), ['#ff0000', '#0000ff'])
    expect(colors).toHaveLength(32)
    expect(colors[31]).toBe('#bc00bc')
    expect(stripes({ components: [1, 2], ratio: [2, 1] }, ['#ff0000', '#0000ff'])).toBe('repeating-linear-gradient(135deg, #ff0000 0 8px, #0000ff 8px 12px)')
  })

  it('move the parts and paint on a removed mix to its first filament, in one undo step', () => {
    addMix({ ...purple, components: [2, 1] }, 2)
    set({ plate: [{ ...entry('a', 1), slotOverrides: { Body: 32 }, paint: { 0: { color: { 3: 'EFC', 4: '8', 5: '4EFC1' } } } }] })
    history().clear()
    expect(removeMix(32)).toBe(true)
    expect(mixesOf(get())).toEqual([])
    expect(get().plate[0]!.slotOverrides).toEqual({ Body: 2 })
    expect(colorPaintStates(get().plate[0]!)).toEqual(new Set([2, 1]))
    expect(get().plate[0]!.paint![0]!.color).toEqual({ 3: '8', 4: '8', 5: '481' })
    expect(history().state().undo).toBe(1)
  })

  it('rewrite paint texts state by state, keeping the splits', () => {
    // 32 is C F E (text EFC); a lone FC, as older files wrote 18, still reads 18.
    expect(remapPaintText('EFC', new Map([[32, 2]]))).toBe('8')
    expect(remapPaintText('8', new Map([[2, 32]]))).toBe('EFC')
    expect(remapPaintText('FC', new Map([[18, 2]]))).toBe('8')
    // A triangle split in two: one half in 32, the other in 1.
    expect(remapPaintText('4EFC1', new Map([[32, 1]]))).toBe('441')
    expect(remapPaintText('EFC', new Map([[32, 0]]))).toBe(null)
    expect(remapPaintText('8', new Map([[32, 1]]))).toBe('8')
    // Paint holds numbers up to 32: a higher one leaves the piece unpainted.
    expect(remapPaintText('EFC', new Map([[32, 40]]))).toBe(null)
  })

  it('leave out of the slice a mix only an object set not to print uses', () => {
    addMix(purple, 2)
    set({ plate: [{ ...entry('a', 32), printable: false }, entry('b', 1)] })
    expect(plateConfig(get().plates[0])).toEqual({})
  })

  it('count color paint as filaments the plate uses, a mix as its two', () => {
    set({ plate: [entry('a', 1), { ...entry('b', 2), paint: { 0: { color: { 0: '0C' } } } }] })
    expect([...usedSlots(get())].sort()).toEqual([1, 2, 3])
    addMix(purple, 3)
    set({ plate: [entry('a', 1), { ...entry('b', 1), paint: { 0: { color: { 0: 'EFC' } } } }] })
    expect([...usedSlots(get())].sort()).toEqual([1, 2])
  })

  it('move clear of a printer that reports filaments up to a mix number, parts and paint along, in one undo step', async () => {
    const teal = { id: 32, name: 'Teal', components: [2, 1] as [number, number], ratio: [1, 1] as [number, number] }
    set({ mixes: [{ id: 30, ...purple }, teal], plate: [{ ...entry('a', 1), slotOverrides: { Body: 30 }, paint: { 0: { color: { 3: 'CFC', 4: 'EFC' } } } }] })
    history().clear()
    const slots = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `A${i}` }))
    set({ printerSlots: slots(29) })
    await Promise.resolve()
    expect(mixesOf(get()).map((m) => m.id)).toEqual([30, 32])
    set({ printerSlots: slots(30) })
    await Promise.resolve()
    expect(mixesOf(get()).map((m) => [m.id, m.name])).toEqual([[31, 'Purple'], [32, 'Teal']])
    expect(get().plate[0]!.slotOverrides).toEqual({ Body: 31 })
    expect(get().plate[0]!.paint![0]!.color).toEqual({ 3: 'DFC', 4: 'EFC' })
    expect(history().state().undo).toBe(1)
    expect(printerClash(get())).toBeNull()
    // One free number above 31 filaments for two mixes: nothing moves, and the Mixes row says why.
    set({ printerSlots: slots(31) })
    await Promise.resolve()
    expect(mixesOf(get()).map((m) => m.id)).toEqual([31, 32])
    expect(printerClash(get())).toMatch(/reports 31 filaments, so filament 31 is also mix Purple's number, and the mixes have no free number above them/)
  })

  it('count a number left on a deleted mix as the filament it prints with', () => {
    // Mix 32 in the project; a part left on 31 prints in filament 1, and paint left in 29 on a part on 2 in filament 2.
    set({ mixes: [{ id: 32, ...purple }], plate: [entry('a', 31), { ...entry('b', 2), paint: { 0: { color: { 3: 'BFC' } } } }] })
    expect(slotCount(get())).toBe(2)
    expect([...usedSlots(get())].sort()).toEqual([1, 2])
    expect(objectSlots(undefined, get().plate[0]!)).toEqual([1])
    expect(objectSlots(undefined, get().plate[1]!)).toEqual([2])
    // The plate sends the mixes, so the engine prints those numbers with the filaments they fall back to.
    expect(plateConfig(get().plates[0])).toEqual({ mixed_filaments: ['32:1,2:2,1:Purple'] })
    // Without mixes the same numbers are filaments of their own, as before.
    set({ mixes: [] })
    expect(slotCount(get())).toBe(31)
    expect([...usedSlots(get())].sort((x, y) => x - y)).toEqual([2, 29, 31])
  })

  it('mean the same mix on every plate: moved, copied and pasted objects keep it, and each plate sends only what it uses', () => {
    addMix(purple, 2)
    set({ plates: [{ id: 'p1', name: 'Plate 1', objects: [], settings: {} }, { id: 'p2', name: 'Plate 2', objects: [], settings: {} }], plate: [{ ...entry('a', 1), slotOverrides: { Body: 32 } }, entry('b', 1)], selection: 'a', selectedIds: ['a'], bed: { widthMm: 256, depthMm: 256, heightMm: 256 } })
    clearClipboard()
    expect(copySelection()).toBe(1)
    expect(moveObjectsToPlate('p2', ['a'])).toBe(1)
    expect(get().plates.find((p) => p.id === 'p2')!.objects[0]!.slotOverrides).toEqual({ Body: 32 })
    // Plate 1 now has nothing on the mix, plate 2 has.
    expect(plateConfig(get().plates[0])).toEqual({})
    expect(plateConfig(get().plates[1])).toEqual({ mixed_filaments: ['32:1,2:2,1:Purple'] })
    expect(pasteClipboard()).toHaveLength(1)
    expect(get().plate.at(-1)!.slotOverrides).toEqual({ Body: 32 })
    expect(plateConfig(get().plates[0])).toEqual({ mixed_filaments: ['32:1,2:2,1:Purple'] })
  })

  it('read the filaments color paint names once per paint', () => {
    set({ plate: [entry('a', 1), { ...entry('b', 2), paint: { 0: { color: { 0: '0C' } } } }], slotSetup: { 3: { type: 'PLA', brand: '', color: '#00ff00' } } })
    expect(slotConfig(get())['filament_colour']).toHaveLength(3)
    // A new paint object is read again: the states follow the paint, not the object.
    const painted = get().plate[1]!
    expect(colorPaintStates(painted)).toEqual(new Set([3]))
    expect(colorPaintStates({ paint: { 0: { color: { 0: '8' } } } })).toEqual(new Set([2]))
    expect(colorPaintStates(painted)).toEqual(new Set([3]))
  })

  it('merge a file\'s mixes into the project\'s: shared when the same, renumbered when the number is taken', () => {
    const ours = [{ id: 32, ...purple }]
    const same = mergeMixes(ours, [{ id: 31, ...purple }], 2)
    expect(same.mixes).toEqual(ours)
    expect([...same.map]).toEqual([[31, 32]])
    const other = { id: 32, name: 'Teal', components: [2, 1] as [number, number], ratio: [1, 1] as [number, number] }
    const moved = mergeMixes(ours, [other], 2)
    expect(moved.mixes.map((m) => m.id)).toEqual([32, 31])
    expect([...moved.map]).toEqual([[32, 31]])
  })

  it('set the whole list through the app link, a dropped mix taking its parts back', async () => {
    addMix({ ...purple, components: [2, 1] }, 2)
    set({ plate: [{ ...entry('a', 1), slotOverrides: { Body: 32 }, paint: { 0: { color: { 2: 'EFC' } } } }], workspace: 'prepare', modelMode: 'slice' })
    expect(await runCall('mixes.get', {}, { id: 'c', name: 'Client' })).toEqual({ mixes: [{ id: 32, ...purple, components: [2, 1] }] })
    await runCall('mixes.set', { mixes: [] }, { id: 'c', name: 'Client' })
    expect(get().mixes).toEqual([])
    expect(get().plate[0]!.slotOverrides).toEqual({ Body: 2 })
    expect(get().plate[0]!.paint![0]!.color).toEqual({ 2: '8' })
    await expect(runCall('mixes.set', { mixes: [{ id: 2, name: 'Bad', components: [1, 2], ratio: [1, 1] }] }, { id: 'c', name: 'Client' })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(runCall('mixes.set', { mixes: [32, 31, 30, 29, 28].map((id) => ({ id, name: 'M', components: [1, 2], ratio: [1, 1] })) }, { id: 'c', name: 'Client' })).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('keep added filaments off a mix number', () => {
    set({ mixes: [32, 31, 30, 29].map((id) => ({ id, ...purple })) })
    setSlot(28, {})
    expect(get().slotSetup[28]).toBeDefined()
    setSlot(29, {})
    expect(get().slotSetup[29]).toBeUndefined()
  })

  it('save with the project once, and open again', async () => {
    const mixes = [{ id: 32, ...purple }, { id: 31, name: 'Teal: "soft" & <warm>', components: [2, 1] as [number, number], ratio: [3, 2] as [number, number] }]
    const input = { plates: [{ id: 'p1', name: 'Plate 1', objects: [entry('a', 32)], settings: {} }], bed, settings: {}, mixes }
    const files = projectFiles(input)
    expect(JSON.parse(String(files.find((f) => f.name === 'Metadata/slicerx_mixed_filaments.json')!.data))).toEqual({ version: 1, mixes: ['32:1,2:2,1:Purple', '31:2,1:3,2:Teal: "soft" & <warm>'] })
    expect(String(files.find((f) => f.name === 'Metadata/model_settings.config')!.data)).not.toContain('mixed_filaments')
    readProjectsWithGeom(false)
    const p = await readProject(writeProject(input), bed)
    expect(p.mixes).toEqual(mixes)
    expect(p.plates[0]!.objects[0]!.parts[0]!.slot).toBe(32)
    // No mix, no file.
    expect(projectFiles({ ...input, mixes: [] }).some((f) => f.name === 'Metadata/slicerx_mixed_filaments.json')).toBe(false)
  })

  it('read only the mixes a slice can use from a file, and nothing from one that does not read', async () => {
    const { projectMixesOf } = await import('../src/export/import3mf')
    const bytes = (v: unknown) => new TextEncoder().encode(typeof v === 'string' ? v : JSON.stringify(v))
    expect(projectMixesOf(bytes('not json'))).toEqual([])
    expect(projectMixesOf(bytes({ a: 1 }))).toEqual([])
    expect(projectMixesOf(bytes({ version: 1, mixes: ['32:1,1:1,1:Same', '31:32,2:1,1:Of a mix', '28:1,2:1,1:Low', '30:1,2:1,1:Fine', '30:2,1:1,1:Again', '29:1,29:1,1:Past'] }))).toEqual([{ id: 30, name: 'Fine', components: [1, 2], ratio: [1, 1] }])
  })
})

describe('the Mix editor and the pickers', () => {
  beforeEach(() => {
    set({ plates: [{ id: 'p1', name: 'Plate 1', objects: [], settings: {} }], activePlate: 'p1', plate: [entry('a', 1)], slotSetup: { 1: { type: 'PLA', brand: '', color: '#ff0000' }, 2: { type: 'PLA', brand: '', color: '#0000ff' } }, printerSlots: [], mixDialog: null, mixes: [] })
  })

  it('reads the cycle and the cost in plain words', () => {
    expect(cycleWords([2, 1])).toBe('A A B')
    expect(cycleWords([3, 2])).toBe('A A B A B')
    expect(costWords({ changes: 40, grams: 12.5, many: true, layers: 50, basis: 'parts' })).toBe('About 40 tool changes and 12.5 g of flush for the parts on it.')
    expect(costWords({ changes: 0, grams: 0, many: false, layers: 1, basis: 'tallest' })).toBe('No extra tool changes for the tallest object, if it printed with this mix.')
    expect(costWords(null)).toMatch(/Add an object/)
  })

  it('shows the Mix button and each mix as a striped spool on the filament rail', () => {
    const rail = (mixes: boolean): string => {
      const el = document.createElement('div')
      const root = createRoot(el)
      flushSync(() => root.render(createElement(SlotRail, { slots: resolved(), left: () => null, mixes })))
      const html = el.innerHTML
      flushSync(() => root.unmount())
      return html
    }
    expect(rail(false)).not.toContain('slice-filament-mix')
    // Simple mode leaves making a mix to Advanced and Expert, and shows the row once the project has one.
    set({ settingsMode: 'simple' })
    expect(rail(true)).not.toContain('slice-filament-mix')
    set({ settingsMode: 'advanced' })
    expect(rail(true)).toContain('data-testid="slice-filament-mix"')
    expect(rail(true)).not.toContain('slice-filament-mix-spool')
    addMix(purple, 2)
    set({ settingsMode: 'simple' })
    expect(rail(true)).toContain('data-testid="slice-filament-mix-spool"')
    set({ settingsMode: 'advanced' })
    const html = rail(true)
    expect(html).toContain('data-testid="slice-filament-mix-spool"')
    expect(html).toContain('data-slot="32"')
    expect(html).toContain('data-mix="true"')
    expect(html).toContain('aria-label="Purple, mix of 1 and 2, 2 to 1 layers"')
    expect(html).toContain('<span class="spool-id">2:1</span><span class="spool-type">Mix</span>')
  })

  it('lets a part pick a mix like a filament, and nothing past the loaded ones that is not a mix', () => {
    addMix(purple, 2)
    setPartSlot('a', 'Body', 32)
    expect(get().plate[0]!.slotOverrides).toEqual({ Body: 32 })
    // Past the filaments a project holds, a number that is not a mix stays off.
    setPartSlot('a', 'Body', 33)
    expect(get().plate[0]!.slotOverrides).toEqual({ Body: 32 })
    // On a printer with two filaments loaded, a part on the mix of both needs nothing more.
    const loaded = { ...get(), printerSlots: [{ id: 'A1', material: 'PLA', color: '#ff0000' }, { id: 'A2', material: 'PLA', color: '#0000ff' }] }
    expect(objectWarnings(get().plate[0]!, loaded).filter((w) => w.kind === 'filament')).toEqual([])
  })
})
