// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { act } from 'react'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sameValue } from '@slicerx/settings'
import { comparable, comparePreset, CopyChanged, copyValue, parentFor, parentSide, stockFor, undoCopy, whole } from '../src/presets/compare'
import { applyPreset, updatePreset } from '../src/presets/presets'
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
    // The preset applies over the stock settings, never over its parent, so the parent is read over them too.
    const side = parentSide(a, parent!)
    const stock = stockFor(a)
    const c = comparePreset(a, stock, side)
    const keys = c.groups.flatMap((g) => g.rows).map((r) => r.key)
    expect(keys).toContain('nozzle_temperature')
    for (const k of keys) if (k !== 'nozzle_temperature') expect(side.config[k], k).not.toEqual(stock[k])
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
    await undoCopy(before!)
    expect(get().userPresets.find((p) => p.id === 'a')!.values['layer_height']).toBe(0.2)
  })

  it('keeps the plate following the preset in use when a value is copied into it', async () => {
    set({ userPresets: [preset('a', 'filament', { nozzle_temperature: [231] }), preset('b', 'filament', { nozzle_temperature: [205] })], activePresets: { filament: 'a' }, overrides: { nozzle_temperature: [231], wall_loops: 4 } })
    const before = await copyValue('a', 'nozzle_temperature', whole(get().userPresets[1]!, stockFor(get().userPresets[1]!)), stockFor(get().userPresets[0]!))
    expect(get().overrides).toEqual({ nozzle_temperature: [205], wall_loops: 4 })
    await undoCopy(before!)
    expect(get().overrides).toEqual({ nozzle_temperature: [231], wall_loops: 4 })
  })

  it('copies a parent value into the preset, so the plate gets the parent value, not stock', async () => {
    set({ userPresets: [preset('a', 'filament', {}, { inherits: 'Bambu PLA Basic @BBL A1' })] })
    const a = get().userPresets[0]!
    const stock = stockFor(a)
    const side = parentSide(a, (await parentFor(a))!)
    const key = comparePreset(a, stock, side).groups.flatMap((g) => g.rows)[0]!.key
    expect(side.config[key]).not.toEqual(stock[key])
    const before = await copyValue('a', key, side.config, stock)
    expect(get().userPresets[0]!.values[key]).toEqual(side.config[key])
    applyPreset('a')
    expect(get().overrides[key]).toEqual(side.config[key])
    expect(comparePreset(get().userPresets[0]!, stock, side).groups.flatMap((g) => g.rows).some((r) => r.key === key)).toBe(false)
    await undoCopy(before!)
    expect(key in get().userPresets[0]!.values).toBe(false)
  })

  it('runs copies and undos one after another, so none is lost', async () => {
    set({ userPresets: [preset('a', 'process', {}), preset('b', 'process', { layer_height: 0.12, wall_loops: 6 })] })
    const base = stockFor(get().userPresets[0]!)
    const b = whole(get().userPresets[1]!, base)
    await Promise.all([copyValue('a', 'layer_height', b, base), copyValue('a', 'wall_loops', b, base)])
    expect(get().userPresets.find((p) => p.id === 'a')!.values).toEqual({ layer_height: 0.12, wall_loops: 6 })
    const before = (await copyValue('a', 'sparse_infill_density', { ...b, sparse_infill_density: 40 }, base))!
    // Undo, then a copy sent before the undo's write lands: the copy builds on the undone preset.
    await Promise.all([undoCopy(before), copyValue('a', 'top_shell_layers', { ...b, top_shell_layers: 9 }, base)])
    expect(get().userPresets.find((p) => p.id === 'a')!.values).toEqual({ layer_height: 0.12, wall_loops: 6, top_shell_layers: 9 })
  })

  it('puts back only the copied setting, keeping a later change to another one', async () => {
    set({ userPresets: [preset('a', 'process', { layer_height: 0.2 }), preset('b', 'process', { layer_height: 0.12 })] })
    const base = stockFor(get().userPresets[0]!)
    const rec = (await copyValue('a', 'layer_height', whole(get().userPresets[1]!, base), base))!
    // A later change elsewhere in the preset, here a save over it from the Presets list.
    await updatePreset('a', { values: { layer_height: 0.12, wall_loops: 7 } })
    await undoCopy(rec)
    expect(get().userPresets.find((p) => p.id === 'a')!.values).toEqual({ layer_height: 0.2, wall_loops: 7 })
  })

  it('refuses to put back a setting that changed again after the copy', async () => {
    set({ userPresets: [preset('a', 'process', { layer_height: 0.2 }), preset('b', 'process', { layer_height: 0.12 })] })
    const base = stockFor(get().userPresets[0]!)
    const rec = (await copyValue('a', 'layer_height', whole(get().userPresets[1]!, base), base))!
    await updatePreset('a', { values: { layer_height: 0.16 } })
    await expect(undoCopy(rec)).rejects.toBeInstanceOf(CopyChanged)
    expect(get().userPresets.find((p) => p.id === 'a')!.values).toEqual({ layer_height: 0.16 })
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
  /** Waits for `ok`, up to 20 s: the parent preset loads from a vendor file. */
  const until = async (ok: () => boolean) => {
    for (let t = Date.now(); !ok(); ) {
      if (Date.now() - t > 20_000) throw new Error('timed out')
      await act(async () => void (await new Promise((r) => setTimeout(r, 20))))
    }
  }

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

    // No setting key anywhere, tooltips included.
    expect(host.querySelector('[data-tip-key]')).toBeNull()
    const all = host.querySelector<HTMLButtonElement>('[role="switch"]')!
    act(() => all.click())
    expect(rows().length).toBeGreaterThan(50)
    for (const r of rows()) expect(r.querySelector('[data-testid="preset-compare-copy"]') !== null, r.dataset['key']).toBe(r.dataset['differs'] === 'true')
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

  it('says what a copy did on the status line, with the setting label and the preset name, until the next action', async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    set({ userPresets: [preset('a', 'process', { layer_height: 0.2, wall_loops: 9, raft_layers: 1 }, { name: 'Draft fast 0.28' }), preset('b', 'process', { layer_height: 0.12, raft_layers: 2 }, { name: 'Fine detail' })] })
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    act(() => root.render(createElement(ComparePanel)))
    pick('cmp-a', 'a')
    pick('cmp-b', 'preset:b')
    await flush()
    const status = () => host.querySelectorAll('[role="status"]')
    const text = () => status()[0]!.textContent
    const rows = () => [...host.querySelectorAll<HTMLElement>('[data-testid="preset-compare-row"]')]
    const copyRow = async (key: string) => {
      await act(async () => rows().find((r) => r.dataset['key'] === key)!.querySelector<HTMLButtonElement>('[data-testid="preset-compare-copy"]')!.click())
      await flush()
    }
    // One status line, the same element before and after, so nothing around it moves.
    expect(status().length).toBe(1)
    expect(text()).toBe('3 settings differ')
    // One layer reads in the singular.
    expect(rows().find((r) => r.dataset['key'] === 'raft_layers')!.textContent).toContain('1 layer')
    expect(rows().find((r) => r.dataset['key'] === 'raft_layers')!.textContent).not.toContain('1 layers')

    await copyRow('layer_height')
    expect(status().length).toBe(1)
    expect(text()).toBe('Copied Layer height to Draft fast 0.28')
    expect(text()).not.toContain('layer_height')
    // The next copy replaces it.
    await copyRow('raft_layers')
    expect(text()).toBe('Copied Raft layers to Draft fast 0.28')
    // Show all is the next action: the line goes back to the count.
    act(() => host.querySelector<HTMLButtonElement>('[role="switch"]')!.click())
    expect(text()).toBe('1 setting differs')
    await copyRow('wall_loops')
    expect(text()).toBe('Copied Wall loops to Draft fast 0.28')
    // So are Undo and choosing another preset.
    await act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent === 'Undo')!.click())
    await flush()
    expect(text()).not.toMatch(/^Copied/)
    await copyRow('wall_loops')
    expect(text()).toMatch(/^Copied/)
    pick('cmp-b', 'stock')
    expect(text()).not.toMatch(/^Copied/)
  })

  it('writes a setting only one side has as not set, and a copy from that side says it cleared the value', async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const name = 'PETG Translucent Galaxy Black'
    set({ userPresets: [preset('a', 'filament', { filament_wipe: [true], nozzle_temperature: [240] }, { name }), preset('b', 'filament', { nozzle_temperature: [210] }, { name: 'Generic PLA' })] })
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    act(() => root.render(createElement(ComparePanel)))
    pick('cmp-kind', 'filament')
    pick('cmp-a', 'a')
    pick('cmp-b', 'preset:b')
    await flush()
    const row = (key: string) => host.querySelector<HTMLElement>(`[data-testid="preset-compare-row"][data-key="${key}"]`)
    const cells = (key: string) => [...row(key)!.querySelectorAll('td')].slice(0, 2).map((td) => td.textContent)
    // The side that does not set it reads as the settings panel writes it, never a blank cell.
    expect(cells('filament_wipe')).toEqual(['on', 'not set'])
    const copy = row('filament_wipe')!.querySelector<HTMLButtonElement>('[data-testid="preset-compare-copy"]')!
    expect(copy.getAttribute('aria-label')).toBe(`Clear Filament wipe in ${name}`)
    await act(async () => copy.click())
    await flush()
    // The copy drops the preset's own value, so it goes back to its stock settings: the line says it cleared it.
    expect('filament_wipe' in get().userPresets.find((p) => p.id === 'a')!.values).toBe(false)
    expect(row('filament_wipe')).toBeNull()
    expect(host.querySelector('[role="status"]')!.textContent).toBe(`Cleared Filament wipe in ${name}`)
    // A side with a value still copies.
    await act(async () => row('nozzle_temperature')!.querySelector<HTMLButtonElement>('[data-testid="preset-compare-copy"]')!.click())
    await flush()
    expect(host.querySelector('[role="status"]')!.textContent).toBe(`Copied Nozzle temperature to ${name}`)
  })

  it('says when the parent does not ship with the app', async () => {
    set({ userPresets: [preset('a', 'filament', { nozzle_temperature: [231] }, { name: 'Odd PLA', inherits: 'No Such PLA @Nowhere' })] })
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    act(() => root.render(createElement(ComparePanel)))
    pick('cmp-kind', 'filament')
    pick('cmp-a', 'a')
    pick('cmp-b', 'parent')
    await until(() => /does not ship/.test(host.textContent ?? ''))
    expect(host.textContent).toContain('Odd PLA was made from No Such PLA @Nowhere, which does not ship with')
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
    const rows = () => [...host.querySelectorAll<HTMLElement>('[data-testid="preset-compare-row"]')]
    await until(() => rows().length > 0)
    expect(rows().map((r) => r.dataset['key'])).toContain('nozzle_temperature')
    // Copy from the parent: the preset keeps the parent's value, and the row goes.
    const first = rows()[0]!
    const key = first.dataset['key']!
    await act(async () => first.querySelector<HTMLButtonElement>('[data-testid="preset-compare-copy"]')!.click())
    await until(() => !rows().some((r) => r.dataset['key'] === key))
    const kept = get().userPresets.find((p) => p.id === 'a')!.values[key]
    expect(kept).toBeDefined()
    expect(sameValue(kept, stockFor(get().userPresets.find((p) => p.id === 'a')!)[key])).toBe(false)
    pick('cmp-a', 'b')
    expect(options()).toEqual(['', 'stock', 'preset:a'])
  })
})
