// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Each object's nozzle on a printer whose nozzles are not all one size: read from its filament and the plate's map,
// picked from the object row, sent to the engine as a map set by hand, and the chip that shows it.
import type { MeshHandle } from '@slicerx/contracts'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setProfileLayer } from '../src/adapters/config'
import { mapSource, mixedNozzleConfig, nozzleChoices, nozzleKind, nozzleLabel, objectNozzle, setObjectNozzle, sizesDiffer } from '../src/filament/object-nozzle'
import { resolveSlots } from '../src/filament/slots'
import { activeMeta } from '../src/plate/plates'
import { plateSliceConfig } from '../src/state/slice-plate'
import { get, set, type PlateEntry } from '../src/state/store'
import { nozzleSuffix } from '../src/workspaces/prepare/machine-card'
import { ObjectNozzleChip, paintWarningText } from '../src/workspaces/prepare/object-nozzle'

const H2D = { printer_model: 'Bambu Lab H2D', nozzle_diameter: [0.4, 0.6], master_extruder_id: 2, single_extruder_multi_material: true }
const U1 = { printer_model: 'Snapmaker U1', nozzle_diameter: [0.4, 0.6, 0.4, 0.4], single_extruder_multi_material: false }

function entry(id: string, slots: number[]): PlateEntry {
  const parts = slots.map((slot, i) => ({ name: `p${i}`, slot }))
  const handle = { id, hash: id, name: id, triangles: 12, bboxMm: [20, 10, 5], openEdges: 0, parts } as unknown as MeshHandle
  return { id, name: id, handle, parts: parts.map((p) => ({ ...p, positions: new Float32Array(), indices: new Uint32Array() })), colors: slots.map(() => '#bd93f9'), transform: [] } as unknown as PlateEntry
}

const slots = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [i + 1, { type: 'PLA', brand: '', color: ['#ff6a13', '#0a2989', '#22cc66', '#eeeeee'][i]! }]))

beforeEach(() => {
  set({ plates: [{ id: 'plate-1', name: 'Plate 1', objects: [], settings: { sequence: 'by-layer' } }], activePlate: 'plate-1', slice: { status: 'idle' }, objectSettings: {}, overrides: {} })
})

afterEach(() => {
  setProfileLayer(null, [])
  document.body.innerHTML = ''
})

describe('which nozzle prints an object', () => {
  it('is nothing to pick when every nozzle is one size', () => {
    setProfileLayer({ ...H2D, nozzle_diameter: [0.4, 0.4] }, [])
    set({ plate: [entry('a', [1])], slotSetup: slots(2) })
    expect(sizesDiffer({ nozzle_diameter: [0.4, 0.4] })).toBe(false)
    expect(objectNozzle(get(), get().plate[0]!)).toBeNull()
    expect(nozzleChoices(get(), get().plate[0]!)).toEqual([])
    expect(setObjectNozzle('a', 2)).toMatchObject({ ok: false, reason: 'one_size' })
  })

  it('on a tool changer is its filament: filament n on tool n, and a pick moves the object there', () => {
    setProfileLayer(U1, [])
    set({ plate: [entry('a', [1]), entry('b', [1])], slotSetup: slots(4) })
    expect(nozzleKind(U1)).toBe('tools')
    expect(objectNozzle(get(), get().plate[1]!)).toEqual({ extruder: 1, mm: 0.4 })
    expect(setObjectNozzle('b', 2)).toEqual({ ok: true, filament: 2, extruder: 2 })
    expect(get().plate[1]!.slotOverrides).toEqual({ p0: 2 })
    expect(objectNozzle(get(), get().plate[1]!)).toEqual({ extruder: 2, mm: 0.6 })
    // The other object stays on tool 1.
    expect(objectNozzle(get(), get().plate[0]!)).toEqual({ extruder: 1, mm: 0.4 })
    expect(nozzleLabel(U1, 2)).toBe('Tool 2, 0.6 mm')
    expect(setObjectNozzle('b', 3, { filament: 2 })).toMatchObject({ ok: false, reason: 'filament' })
    expect(setObjectNozzle('b', 9)).toMatchObject({ ok: false, reason: 'no_nozzle' })
  })

  it('refuses an object whose parts print on nozzles of two sizes, in the engine words', () => {
    setProfileLayer(U1, [])
    set({ plate: [entry('a', [1, 2])], slotSetup: slots(2) })
    const n = objectNozzle(get(), get().plate[0]!)
    expect(n && 'conflict' in n ? n.conflict : '').toMatch(/a prints on nozzles of two sizes \(0\.4 mm and 0\.6 mm\)/)
  })

  it('on an H2D is the nozzle the plate map sends its filament to, and a pick sets the map', () => {
    setProfileLayer(H2D, [])
    set({ plate: [entry('a', [1]), entry('b', [2])], slotSetup: slots(2) })
    expect(nozzleKind(H2D)).toBe('map')
    // No map of its own: the master extruder for every filament until the plate sets one.
    expect(objectNozzle(get(), get().plate[0]!)).toEqual({ extruder: 2, mm: 0.6 })
    expect(setObjectNozzle('a', 1)).toEqual({ ok: true, filament: 1, extruder: 1 })
    expect(activeMeta(get())!.settings.nozzleMap).toEqual([1, 2])
    expect(objectNozzle(get(), get().plate[0]!)).toEqual({ extruder: 1, mm: 0.4 })
    expect(objectNozzle(get(), get().plate[1]!)).toEqual({ extruder: 2, mm: 0.6 })
    expect(nozzleLabel(H2D, 1)).toBe('Left nozzle, 0.4 mm')
  })

  it('on an H2D refuses to split a filament two objects share, unless asked to move it or give a new one', () => {
    setProfileLayer(H2D, [])
    set({ plate: [entry('a', [1]), entry('b', [1])], slotSetup: slots(1) })
    const refused = setObjectNozzle('b', 1)
    expect(refused).toMatchObject({ ok: false, reason: 'split', sharedWith: ['a'] })
    expect(!refused.ok && refused.message).toMatch(/new_filament: true.*move_filament: true/)
    expect(activeMeta(get())!.settings.nozzleMap).toBeUndefined()
    expect(setObjectNozzle('b', 1, { newFilament: true, moveFilament: true })).toMatchObject({ ok: false, reason: 'filament' })
    // The menu offers both ways on the other nozzle.
    const choices = nozzleChoices(get(), get().plate[1]!)
    expect(choices.map((c) => [c.extruder, c.current, c.sharedWith])).toEqual([
      [1, false, ['a']],
      [2, true, []],
    ])
    // A new filament: a copy of filament 1 on the left nozzle, and only b moves.
    expect(setObjectNozzle('b', 1, { newFilament: true })).toEqual({ ok: true, filament: 2, extruder: 1, added: 2 })
    expect(resolveSlots(get())[1]).toMatchObject({ type: 'PLA', color: '#ff6a13' })
    expect(activeMeta(get())!.settings.nozzleMap).toEqual([2, 1])
    expect(objectNozzle(get(), get().plate[0]!)).toEqual({ extruder: 2, mm: 0.6 })
    expect(objectNozzle(get(), get().plate[1]!)).toEqual({ extruder: 1, mm: 0.4 })
  })

  it('on an H2D moves a shared filament with every object on it when asked', () => {
    setProfileLayer(H2D, [])
    set({ plate: [entry('a', [1]), entry('b', [1])], slotSetup: slots(1) })
    expect(setObjectNozzle('b', 1, { moveFilament: true })).toEqual({ ok: true, filament: 1, extruder: 1 })
    expect(objectNozzle(get(), get().plate[0]!)).toEqual({ extruder: 1, mm: 0.4 })
  })
})

describe('what the slice sends', () => {
  it('a map by hand when the H2D nozzles differ, seeded from the shown map, and nothing new when they are one size', () => {
    setProfileLayer(H2D, [])
    set({ plate: [entry('a', [1]), entry('b', [2])], slotSetup: slots(2) })
    const cfg = plateSliceConfig(get(), activeMeta(get())) as unknown as Record<string, unknown>
    expect(cfg['filament_map_mode']).toBe('Manual')
    expect(cfg['filament_map']).toEqual([2, 2])
    expect(mapSource(get(), activeMeta(get()), H2D)).toBe('seeded')
    // The seed is not written to the plate.
    expect(activeMeta(get())!.settings.nozzleMap).toBeUndefined()
    setProfileLayer({ ...H2D, nozzle_diameter: [0.4, 0.4] }, [])
    const same = plateSliceConfig(get(), activeMeta(get())) as unknown as Record<string, unknown>
    expect(same['filament_map_mode']).toBeUndefined()
    expect(mapSource(get(), activeMeta(get()), { ...H2D, nozzle_diameter: [0.4, 0.4] })).toBe('auto')
  })

  it('the plate own map when it has one', () => {
    setProfileLayer(H2D, [])
    set({ plate: [entry('a', [1]), entry('b', [2])], slotSetup: slots(2) })
    setObjectNozzle('a', 1)
    const cfg = plateSliceConfig(get(), activeMeta(get())) as unknown as Record<string, unknown>
    expect([cfg['filament_map_mode'], cfg['filament_map']]).toEqual(['Manual', [1, 2]])
    expect(mapSource(get(), activeMeta(get()), H2D)).toBe('manual')
  })

  it('each nozzle its own widths and layer height, the plate value on the first, and one layer height with a prime tower', () => {
    const lists = { layer_height: [0.2, 0.3, 0.2, 0.2], outer_wall_line_width: [0.42, 0.62, 0.42, 0.42] }
    const cfg = { ...U1, layer_height: 0.16, outer_wall_line_width: 0.42 }
    const meta = { id: 'p', name: 'P', objects: [], settings: {} }
    // The person's 0.16 mm stays on the first nozzle; the others keep their preset.
    expect(mixedNozzleConfig(get(), meta, cfg, false, lists)).toEqual({ layer_height: [0.16, 0.3, 0.2, 0.2], outer_wall_line_width: [0.42, 0.62, 0.42, 0.42] })
    expect(mixedNozzleConfig(get(), meta, cfg, true, lists)).toEqual({ outer_wall_line_width: [0.42, 0.62, 0.42, 0.42] })
    // Lists for another printer's nozzle count are left out, and one size sends nothing.
    expect(mixedNozzleConfig(get(), meta, cfg, false, { layer_height: [0.2, 0.3] })).toEqual({})
    expect(mixedNozzleConfig(get(), meta, { ...cfg, nozzle_diameter: [0.4, 0.4, 0.4, 0.4] }, false, lists)).toEqual({})
  })

  it('the profile layer lists into the slice', () => {
    setProfileLayer({ ...U1, layer_height: 0.2, enable_prime_tower: false }, [], { layer_height: [0.2, 0.3, 0.2, 0.2] })
    set({ plate: [entry('a', [1]), entry('b', [2])], slotSetup: slots(2) })
    const cfg = plateSliceConfig(get(), activeMeta(get())) as unknown as Record<string, unknown>
    expect(cfg['layer_height']).toEqual([0.2, 0.3, 0.2, 0.2])
  })
})

describe('the machine card', () => {
  it('names every size when they differ', () => {
    expect(nozzleSuffix(0.4, { nozzle_diameter: [0.4] })).toBe(', 0.4 mm')
    expect(nozzleSuffix(0.4, { ...H2D, nozzle_diameter: [0.4, 0.4] })).toBe(', 0.4 mm')
    expect(nozzleSuffix(0.4, H2D)).toBe(', left 0.4 mm, right 0.6 mm')
    expect(nozzleSuffix(0.4, { ...U1, nozzle_diameter: [0.4, 0.4, 0.6, 0.4, 0.4] })).toBe(', tools 0.4, 0.4, 0.6, 0.4, 0.4 mm')
  })
})

describe('the nozzle chip', () => {
  const render = (e: PlateEntry) => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const root = createRoot(el)
    flushSync(() => root.render(createElement(ObjectNozzleChip, { entry: e })))
    return { el, root }
  }

  it('shows nothing on one size, the short size and side on mixed sizes, and opens the nozzle menu', () => {
    setProfileLayer({ ...H2D, nozzle_diameter: [0.4, 0.4] }, [])
    set({ plate: [entry('a', [1])], slotSetup: slots(1) })
    expect(render(get().plate[0]!).el.querySelector('[data-testid="object-nozzle"]')).toBeNull()
    document.body.innerHTML = ''
    setProfileLayer(H2D, [])
    const { el, root } = render(get().plate[0]!)
    const chip = el.querySelector<HTMLButtonElement>('[data-testid="object-nozzle"]')!
    expect(chip.textContent).toBe('0.6 R')
    flushSync(() => chip.click())
    const menu = document.querySelector('[data-testid="object-nozzle-pick"]')!
    const items = [...menu.querySelectorAll('[data-testid="object-nozzle-item"]')]
    expect(items.map((i) => i.textContent)).toEqual(['Left nozzle, 0.4 mmfilament 1', 'Right nozzle, 0.6 mmfilament 1'])
    flushSync(() => (items[0] as HTMLButtonElement).click())
    expect(activeMeta(get())!.settings.nozzleMap).toEqual([1])
    flushSync(() => root.render(createElement(ObjectNozzleChip, { entry: get().plate[0]! })))
    expect(el.querySelector('[data-testid="object-nozzle"]')!.textContent).toBe('0.4 L')
    root.unmount()
  })

  it('warns on Move filament when the move would print a painted object on two nozzles, and still lets the person move it', () => {
    setProfileLayer(H2D, [])
    // a is filament 1 with a face painted filament 2; b is filament 1. Moving filament 1 left splits a's paint off.
    set({ plate: [{ ...entry('a', [1]), paint: { 0: { color: { 0: '8' } } } } as PlateEntry, entry('b', [1])], slotSetup: slots(2) })
    expect(nozzleChoices(get(), get().plate[1]!).map((c) => c.paintSplit)).toEqual([['a'], []])
    const { el, root } = render(get().plate[1]!)
    flushSync(() => el.querySelector<HTMLButtonElement>('[data-testid="object-nozzle"]')!.click())
    const menu = document.querySelector('[data-testid="object-nozzle-pick"]')!
    const warning = menu.querySelector('[data-testid="object-nozzle-paint-warning"]')
    expect(warning?.textContent).toBe('a is painted with this filament and another, so its paint would print on the other nozzle.')
    // The line sits under its item and the item names it as its description; it is not a control of its own.
    const move = menu.querySelector<HTMLButtonElement>('[data-testid="object-nozzle-move"]')!
    expect(move.getAttribute('aria-describedby')).toBe(warning?.id)
    expect(move.nextElementSibling).toBe(warning)
    expect(warning?.querySelector('button')).toBeNull()
    flushSync(() => move.click())
    expect(activeMeta(get())!.settings.nozzleMap).toEqual([1, 2])
    root.unmount()
    // No warning without paint.
    document.body.innerHTML = ''
    set({ plates: [{ id: 'plate-1', name: 'Plate 1', objects: [], settings: { sequence: 'by-layer' } }], plate: [entry('a', [1]), entry('b', [1])] })
    const plain = render(get().plate[1]!)
    flushSync(() => plain.el.querySelector<HTMLButtonElement>('[data-testid="object-nozzle"]')!.click())
    expect(document.querySelector('[data-testid="object-nozzle-paint-warning"]')).toBeNull()
    plain.root.unmount()
  })

  it('names two painted objects, then counts the rest', () => {
    expect(paintWarningText(['a', 'b'])).toBe('a and b are painted with this filament and another, so their paint would print on the other nozzle.')
    expect(paintWarningText(['a', 'b', 'c', 'd'])).toBe('a, b and 2 more are painted with this filament and another, so their paint would print on the other nozzle.')
  })
})
