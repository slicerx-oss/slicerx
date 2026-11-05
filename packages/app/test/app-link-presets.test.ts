// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The person's saved presets over the app link: listed and compared as Compare presets has them (read), and one
// setting's value copied into a preset and put back (edit), each read back. A bad call changes nothing.
import { beforeEach, describe, expect, it } from 'vitest'
import { APP_LINK_METHODS, LinkError, runCall } from '../src/app-link/methods'
import { stockFor } from '../src/presets/compare'
import { savePreset, updatePreset } from '../src/presets/presets'
import { memoryStore, setPresetStore } from '../src/presets/store'
import { get, set } from '../src/state/store'

const refused = async (method: string, args: Record<string, unknown>): Promise<string> => {
  const e = await runCall(method, args).catch((x: unknown) => x)
  expect(e, `${method} ${JSON.stringify(args)}`).toBeInstanceOf(LinkError)
  return (e as LinkError).code
}
type Rows = { groups: { label: string; rows: { key: string; label: string; differs: boolean }[] }[]; differ: number }
const keys = (c: Rows) => c.groups.flatMap((g) => g.rows).map((r) => r.key)

let fast: string
let fine: string
let pla: string
beforeEach(async () => {
  setPresetStore(memoryStore())
  set({ overrides: {}, userPresets: [], activePresets: {} })
  fast = (await savePreset('process', 'Fast draft', { values: { layer_height: 0.28, wall_loops: 5 } }, { activate: false })).id
  fine = (await savePreset('process', 'Fine detail', { values: { layer_height: 0.12 } }, { activate: false })).id
  pla = (await savePreset('filament', 'My PLA', { values: {}, inherits: 'Bambu PLA Basic @BBL A1' }, { activate: false })).id
})

describe('saved presets over the app link', () => {
  it('lists and compares as reads, and copies and undoes as edits', () => {
    expect(APP_LINK_METHODS['presets.list']).toBe('read')
    expect(APP_LINK_METHODS['presets.compare']).toBe('read')
    expect(APP_LINK_METHODS['presets.copy']).toBe('edit')
    expect(APP_LINK_METHODS['presets.undo']).toBe('edit')
  })

  it('lists the saved presets, of one kind on request', async () => {
    const all = (await runCall('presets.list', {})) as { presets: { id: string; name: string; kind: string; settings: number; inUse: boolean; parent?: string }[] }
    expect(all.presets.map((p) => p.name).sort()).toEqual(['Fast draft', 'Fine detail', 'My PLA'])
    expect(all.presets.find((p) => p.id === fast)).toEqual({ id: fast, kind: 'process', name: 'Fast draft', settings: 2, inUse: false })
    expect(all.presets.find((p) => p.id === pla)!.parent).toBe('Bambu PLA Basic @BBL A1')
    const filament = (await runCall('presets.list', { kind: 'filament' })) as { presets: { id: string }[] }
    expect(filament.presets.map((p) => p.id)).toEqual([pla])
  })

  it('compares as the panel does: with another preset by name, with stock, and with the parent', async () => {
    const two = (await runCall('presets.compare', { preset: 'Fast draft', with: 'Fine detail' })) as Rows & { with: { id: string } }
    expect(keys(two).sort()).toEqual(['layer_height', 'wall_loops'])
    expect(two.with.id).toBe(fine)
    for (const g of two.groups) for (const r of g.rows) expect(r.label).not.toMatch(/_/)
    const stock = (await runCall('presets.compare', { preset: fast, against: 'stock', all: true })) as Rows
    expect(stock.differ).toBe(2)
    expect(keys(stock).length).toBeGreaterThan(50)
    const parent = (await runCall('presets.compare', { preset: pla, against: 'parent' })) as Rows & { with: { against: string; name: string } }
    expect(parent.with).toEqual({ name: 'Bambu PLA Basic @BBL A1', against: 'parent' })
    expect(parent.differ).toBeGreaterThan(0)
  })

  it('copies a value into the preset and puts it back, both read back', async () => {
    const out = (await runCall('presets.copy', { preset: fast, key: 'layer_height', with: fine })) as { value: unknown; undoId: string; preset: { settings: number } }
    expect(out.value).toBe(0.12)
    expect(get().userPresets.find((p) => p.id === fast)!.values['layer_height']).toBe(0.12)
    const back = (await runCall('presets.undo', { undoId: out.undoId })) as { value: unknown }
    expect(back.value).toBe(0.28)
    expect(get().userPresets.find((p) => p.id === fast)!.values['layer_height']).toBe(0.28)
    expect(await refused('presets.undo', { undoId: out.undoId })).toBe('not_found')
  })

  it('copies a parent value as the parent value, which the preset then keeps', async () => {
    const c = (await runCall('presets.compare', { preset: pla, against: 'parent' })) as Rows
    const key = keys(c)[0]!
    const out = (await runCall('presets.copy', { preset: pla, key, against: 'parent' })) as { value: unknown }
    const preset = get().userPresets.find((p) => p.id === pla)!
    expect(out.value).not.toBeNull()
    expect(preset.values[key]).toEqual(out.value)
    expect(preset.values[key]).not.toEqual(stockFor(preset)[key])
    expect(keys((await runCall('presets.compare', { preset: pla, against: 'parent' })) as Rows)).not.toContain(key)
  })

  it('does not put a copy back over a later change to the preset', async () => {
    const out = (await runCall('presets.copy', { preset: fast, key: 'wall_loops', with: fine })) as { undoId: string }
    await new Promise((r) => setTimeout(r, 2))
    await updatePreset(fast, { values: { layer_height: 0.3 } })
    expect(await refused('presets.undo', { undoId: out.undoId })).toBe('refused')
    expect(get().userPresets.find((p) => p.id === fast)!.values).toEqual({ layer_height: 0.3 })
  })

  it('refuses a bad call and changes nothing', async () => {
    const before = structuredClone(get().userPresets)
    expect(await refused('presets.list', { kind: 'resin' })).toBe('invalid_input')
    expect(await refused('presets.compare', { preset: 'Nope', against: 'stock' })).toBe('not_found')
    expect(await refused('presets.compare', { preset: fast })).toBe('invalid_input')
    expect(await refused('presets.compare', { preset: fast, with: fine, against: 'stock' })).toBe('invalid_input')
    expect(await refused('presets.compare', { preset: fast, with: fast })).toBe('invalid_input')
    expect(await refused('presets.compare', { preset: fast, with: 'My PLA' })).toBe('not_found')
    expect(await refused('presets.compare', { preset: fast, against: 'parent' })).toBe('invalid_input')
    expect(await refused('presets.copy', { preset: fast, key: 'layer_height' })).toBe('invalid_input')
    expect(await refused('presets.copy', { preset: fast, key: 'top_shell_layers', with: fine })).toBe('invalid_input')
    expect(await refused('presets.copy', { preset: fast, key: 'layer_height', with: fine, values: {} })).toBe('invalid_input')
    expect(await refused('presets.undo', { undoId: 'pu_nope' })).toBe('not_found')
    expect(get().userPresets).toEqual(before)
  })
})
