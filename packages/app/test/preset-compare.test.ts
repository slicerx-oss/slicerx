// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { act } from 'react'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { comparable, comparePreset, copyValue, parentFor, stockFor, undoCopy, whole } from '../src/presets/compare'
import { ComparePanel } from '../src/presets/compare-panel'
import { memoryStore, setPresetStore, type UserPreset } from '../src/presets/store'
import { get, set } from '../src/state/store'

const preset = (id: string, kind: UserPreset['kind'], values: UserPreset['values'], more: Partial<UserPreset> = {}): UserPreset => ({ id, kind, name: id, values, createdAt: 1, updatedAt: 1, ...more })

beforeEach(() => {
  setPresetStore(memoryStore())
  set({ overrides: {}, userPresets: [], activePresets: {} })
})

describe('compare presets', () => {
  it('lists only the settings that differ, by settings group, with labels and the value each side really gets', () => {
    const a = preset('a', 'process', { layer_height: 0.2, sparse_infill_density: '15%', wall_loops: 5 })
    const b = preset('b', 'process', { layer_height: 0.12, sparse_infill_density: '15%' })
    const base = stockFor(a)
    const c = comparePreset(a, base, { name: b.name, config: whole(b, stockFor(b)) })
    const rows = c.groups.flatMap((g) => g.rows)
    expect(rows.map((r) => r.key).sort()).toEqual(['layer_height', 'wall_loops'])
    const walls = rows.find((r) => r.key === 'wall_loops')!
    // The side that leaves it alone gets the stock value, not "not set".
    expect(walls.bText).not.toBe('not set')
    expect(walls.b).toEqual(base['wall_loops'])
    for (const g of c.groups) {
      expect(g.label).not.toMatch(/_/)
      for (const r of g.rows) expect(r.label).not.toMatch(/_/)
    }
  })

  it('compares a preset with the stock settings it goes over, and with all every setting of its kind', () => {
    const a = preset('a', 'filament', { nozzle_temperature: [231] })
    const base = stockFor(a)
    const stock = { name: 'Stock', config: base }
    expect(comparePreset(a, base, stock).groups.flatMap((g) => g.rows).map((r) => r.key)).toEqual(['nozzle_temperature'])
    const all = comparePreset(a, base, stock, { all: true })
    expect(all.differ).toBe(1)
    expect(all.groups.flatMap((g) => g.rows).length).toBeGreaterThan(50)
  })

  it('compares a preset with the maker preset it was made from', async () => {
    const a = preset('a', 'filament', { nozzle_temperature: [231] }, { inherits: 'Bambu PLA Basic @BBL A1' })
    const parent = await parentFor(a)
    expect(parent?.name).toBe('Bambu PLA Basic @BBL A1')
    const c = comparePreset(a, parent!.config, parent!)
    expect(c.groups.flatMap((g) => g.rows).map((r) => r.key)).toEqual(['nozzle_temperature'])
    expect(await parentFor(preset('b', 'filament', {}, { inherits: 'No such preset @Nowhere' }))).toBeUndefined()
    expect(await parentFor(preset('c', 'filament', {}))).toBeUndefined()
  })

  it('copies a value into the first preset, drops it when it is the stock value, and puts it back', async () => {
    set({ userPresets: [preset('a', 'process', { wall_loops: 5, layer_height: 0.2 }), preset('b', 'process', { layer_height: 0.12 })] })
    const a = get().userPresets[0]!
    const base = stockFor(a)
    const b = whole(get().userPresets[1]!, stockFor(get().userPresets[1]!))
    const before = await copyValue('a', 'layer_height', b, base)
    expect(get().userPresets.find((p) => p.id === 'a')!.values['layer_height']).toBe(0.12)
    // B leaves walls at stock, so copying it drops A's change instead of storing the stock value.
    await copyValue('a', 'wall_loops', b, base)
    expect('wall_loops' in get().userPresets.find((p) => p.id === 'a')!.values).toBe(false)
    await undoCopy(before!, 'layer_height')
    expect(get().userPresets.find((p) => p.id === 'a')!.values['layer_height']).toBe(0.2)
  })

  it('keeps the plate following the preset in use when a value is copied into it', async () => {
    set({ userPresets: [preset('a', 'filament', { nozzle_temperature: [231] }), preset('b', 'filament', { nozzle_temperature: [205] })], activePresets: { filament: 'a' }, overrides: { nozzle_temperature: [231], wall_loops: 4 } })
    const before = await copyValue('a', 'nozzle_temperature', whole(get().userPresets[1]!, stockFor(get().userPresets[1]!)), stockFor(get().userPresets[0]!))
    expect(get().overrides).toEqual({ nozzle_temperature: [205], wall_loops: 4 })
    await undoCopy(before!, 'nozzle_temperature')
    expect(get().overrides).toEqual({ nozzle_temperature: [231], wall_loops: 4 })
  })

  it('compares only presets of the same kind', () => {
    const a = preset('a', 'filament', { nozzle_temperature: [210] })
    expect(comparable(a, [a, preset('b', 'filament', {}), preset('c', 'process', {})]).map((p) => p.id)).toEqual(['b'])
  })
})

describe('Compare presets panel', () => {
  let host: HTMLDivElement
  let root: ReturnType<typeof createRoot>
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })
  const pick = (id: string, value: string) =>
    act(() => {
      const el = host.querySelector<HTMLSelectElement>(`#${id}`)!
      el.value = value
      el.dispatchEvent(new Event('change', { bubbles: true }))
    })
  const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))))

  it('groups what differs, shows all on request, copies a value across and undoes it', async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    set({ userPresets: [preset('a', 'process', { layer_height: 0.2, wall_loops: 9 }, { name: 'Fast draft' }), preset('b', 'process', { layer_height: 0.12 }, { name: 'Fine detail' })] })
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    act(() => root.render(createElement(ComparePanel)))
    pick('cmp-a', 'a')
    pick('cmp-b', 'preset:b')
    await flush()
    const groups = () => [...host.querySelectorAll('[data-testid="preset-compare-group"]')].map((g) => g.querySelector('h5')!.textContent)
    const rows = () => [...host.querySelectorAll<HTMLElement>('[data-testid="preset-compare-row"]')]
    expect(groups()).toEqual(['Quality', 'Strength'])
    expect(rows().map((r) => r.dataset['key'])).toEqual(['layer_height', 'wall_loops'])
    // Labels only: no internal keys in the text.
    expect(host.textContent).toContain('Layer height')
    expect(host.textContent).not.toContain('layer_height')
    expect(host.querySelector('[role="status"]')!.textContent).toBe('2 settings differ')

    const all = host.querySelector<HTMLButtonElement>('[role="switch"]')!
    act(() => all.click())
    expect(rows().length).toBeGreaterThan(50)
    expect(host.querySelector('[role="status"]')!.textContent).toBe('2 settings differ')
    act(() => all.click())

    const undo = () => [...host.querySelectorAll('button')].find((b) => b.textContent === 'Undo')!
    expect(undo().disabled).toBe(true)
    const copy = rows()[0]!.querySelector<HTMLButtonElement>('button')!
    expect(copy.getAttribute('aria-label')).toBe('Use the Fine detail value of Layer height in Fast draft')
    await act(async () => copy.click())
    await flush()
    expect(get().userPresets.find((p) => p.id === 'a')!.values['layer_height']).toBe(0.12)
    expect(rows().map((r) => r.dataset['key'])).toEqual(['wall_loops'])
    expect(undo().disabled).toBe(false)
    await act(async () => undo().click())
    await flush()
    expect(get().userPresets.find((p) => p.id === 'a')!.values['layer_height']).toBe(0.2)
    expect(rows().map((r) => r.dataset['key'])).toEqual(['layer_height', 'wall_loops'])
    expect(undo().disabled).toBe(true)
  })

  it('says how a G-code setting differs, line by line', async () => {
    set({ userPresets: [preset('a', 'printer', { machine_end_gcode: 'M104 S0\nM140 S0\nM84 ; mine' }, { name: 'Quiet end' })] })
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    act(() => root.render(createElement(ComparePanel)))
    pick('cmp-kind', 'printer')
    pick('cmp-a', 'a')
    pick('cmp-b', 'stock')
    await flush()
    const row = host.querySelector<HTMLElement>('[data-key="machine_end_gcode"]')!
    expect(row.querySelector('td')!.textContent).toBe('3 lines')
    expect(row.querySelector('.cmp-note')!.textContent).toMatch(/^\d+ lines? only in Quiet end, \d+ only in Stock$/)
  })

  it('offers the stock settings, and the parent only for a preset made from a maker preset', async () => {
    set({ userPresets: [preset('a', 'filament', { nozzle_temperature: [231] }, { name: 'My PLA', inherits: 'Bambu PLA Basic @BBL A1' }), preset('b', 'filament', {}, { name: 'Other' })] })
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    act(() => root.render(createElement(ComparePanel)))
    pick('cmp-kind', 'filament')
    pick('cmp-a', 'a')
    await flush()
    const options = () => [...host.querySelectorAll<HTMLOptionElement>('#cmp-b option')].map((o) => o.value)
    expect(options()).toEqual(['', 'parent', 'stock', 'preset:b'])
    pick('cmp-b', 'parent')
    await flush()
    await act(async () => void (await new Promise((r) => setTimeout(r, 50))))
    expect([...host.querySelectorAll<HTMLElement>('[data-testid="preset-compare-row"]')].map((r) => r.dataset['key'])).toEqual(['nozzle_temperature'])
    pick('cmp-a', 'b')
    expect(options()).toEqual(['', 'stock', 'preset:a'])
  })
})
