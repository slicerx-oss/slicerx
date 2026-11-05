// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The person's saved presets over the app link: listed and compared as Compare presets has them (read), and one
// setting's value copied into a preset and put back (edit), each asked of the person in the app and read back. A bad
// call changes nothing.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { presetAsks } from '../src/app-link/preset-asks'
import { APP_LINK_METHODS, LinkError, runCall } from '../src/app-link/methods'
import { copyValue, stockFor, undoCopy, whole } from '../src/presets/compare'
import { deletePreset, savePreset, updatePreset } from '../src/presets/presets'
import { memoryStore, setPresetStore } from '../src/presets/store'
import { get, set } from '../src/state/store'

const refused = async (method: string, args: Record<string, unknown>): Promise<string> => {
  const e = await runCall(method, args).catch((x: unknown) => x)
  expect(e, `${method} ${JSON.stringify(args)}`).toBeInstanceOf(LinkError)
  return (e as LinkError).code
}
type Rows = { groups: { label: string; rows: { key: string; label: string; differs: boolean }[] }[]; differ: number }
const keys = (c: Rows) => c.groups.flatMap((g) => g.rows).map((r) => r.key)

const client = { id: 'c1', name: 'Bench agent' }
/** The person's answer to each preset question as it appears, and the questions asked. */
let answer: boolean | null = true
let asked: string[] = []
const unsub: (() => void)[] = []
afterEach(() => unsub.splice(0).forEach((u) => u()))
function person(): void {
  answer = true
  asked = []
  unsub.push(
    presetAsks.subscribe((st) => {
      for (const a of st.asks) {
        if (asked.includes(`${a.id}`)) continue
        asked.push(`${a.id}`)
        asked.push(a.title)
        if (answer !== null) queueMicrotask(() => a.answer(answer!))
      }
    }),
  )
}
const titles = () => asked.filter((x) => !/^\d+$/.test(x))

let fast: string
let fine: string
let pla: string
beforeEach(async () => {
  setPresetStore(memoryStore())
  set({ overrides: {}, userPresets: [], activePresets: {} })
  fast = (await savePreset('process', 'Fast draft', { values: { layer_height: 0.28, wall_loops: 5 } }, { activate: false })).id
  fine = (await savePreset('process', 'Fine detail', { values: { layer_height: 0.12 } }, { activate: false })).id
  pla = (await savePreset('filament', 'My PLA', { values: {}, inherits: 'Bambu PLA Basic @BBL A1' }, { activate: false })).id
  set({ toast: null, plateLoading: false, slice: { ...get().slice, status: 'idle' } as never })
  person()
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
    const out = (await runCall('presets.copy', { preset: fast, key: 'layer_height', with: fine }, client)) as { value: unknown; undoId: string; preset: { settings: number } }
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

  it('puts back only the copied setting, and refuses once that setting changed again', async () => {
    const out = (await runCall('presets.copy', { preset: fast, key: 'layer_height', with: fine }, client)) as { undoId: string }
    // A change to another setting stays through the undo, with no wait between them.
    await updatePreset(fast, { values: { layer_height: 0.12, wall_loops: 5, top_shell_layers: 9 } })
    await runCall('presets.undo', { undoId: out.undoId }, client)
    expect(get().userPresets.find((p) => p.id === fast)!.values).toEqual({ layer_height: 0.28, wall_loops: 5, top_shell_layers: 9 })
    const again = (await runCall('presets.copy', { preset: fast, key: 'layer_height', with: fine }, client)) as { undoId: string }
    await updatePreset(fast, { values: { layer_height: 0.16, wall_loops: 5 } })
    expect(await refused('presets.undo', { undoId: again.undoId })).toBe('refused')
    expect(get().userPresets.find((p) => p.id === fast)!.values).toEqual({ layer_height: 0.16, wall_loops: 5 })
  })

  it("keeps the panel's copy when the client undoes its own, and the client's when the panel undoes", async () => {
    const base = stockFor(get().userPresets.find((p) => p.id === fast)!)
    const fineWhole = whole(get().userPresets.find((p) => p.id === fine)!, base)
    const panel = (await copyValue(fast, 'layer_height', fineWhole, base))!
    const link = (await runCall('presets.copy', { preset: fast, key: 'wall_loops', with: fine }, client)) as { undoId: string }
    await undoCopy(panel)
    expect(get().userPresets.find((p) => p.id === fast)!.values).toEqual({ layer_height: 0.28 })
    await runCall('presets.undo', { undoId: link.undoId }, client)
    expect(get().userPresets.find((p) => p.id === fast)!.values).toEqual({ layer_height: 0.28, wall_loops: 5 })
  })

  it('runs an undo after a write already queued, and keeps that write', async () => {
    const out = (await runCall('presets.copy', { preset: fast, key: 'layer_height', with: fine }, client)) as { undoId: string }
    const base = stockFor(get().userPresets.find((p) => p.id === fast)!)
    await Promise.all([copyValue(fast, 'top_shell_layers', { ...base, top_shell_layers: 9 }, base), runCall('presets.undo', { undoId: out.undoId }, client)])
    expect(get().userPresets.find((p) => p.id === fast)!.values).toEqual({ layer_height: 0.28, wall_loops: 5, top_shell_layers: 9 })
  })

  it('asks the person each time and changes nothing when they decline', async () => {
    answer = false
    expect(await refused('presets.copy', { preset: fast, key: 'layer_height', with: fine })).toBe('refused')
    expect(get().userPresets.find((p) => p.id === fast)!.values['layer_height']).toBe(0.28)
    answer = true
    await runCall('presets.copy', { preset: fast, key: 'layer_height', with: fine }, client)
    await runCall('presets.copy', { preset: fast, key: 'wall_loops', with: fine }, client)
    expect(titles()).toEqual(['Set Layer height in Fast draft to 0.12 mm?', 'Set Layer height in Fast draft to 0.12 mm?', expect.stringMatching(/^Set Wall loops in Fast draft to /)])
  })

  it('tells the person which client changed what', async () => {
    const out = (await runCall('presets.copy', { preset: fast, key: 'layer_height', with: fine }, client)) as { undoId: string }
    expect(get().toast?.text).toBe('Bench agent changed Layer height in Fast draft.')
    await runCall('presets.undo', { undoId: out.undoId }, client)
    expect(get().toast?.text).toBe('Bench agent put back Layer height in Fast draft.')
  })

  it('refuses a write to the preset in use while the plate loads or slices, before asking', async () => {
    set({ activePresets: { process: fast }, slice: { ...get().slice, status: 'running' } as never })
    expect(await refused('presets.copy', { preset: fast, key: 'layer_height', with: fine })).toBe('busy')
    set({ slice: { ...get().slice, status: 'idle' } as never, plateLoading: true })
    expect(await refused('presets.copy', { preset: fast, key: 'layer_height', with: fine })).toBe('busy')
    expect(titles()).toEqual([])
    expect(get().userPresets.find((p) => p.id === fast)!.values['layer_height']).toBe(0.28)
    // A preset not in use is not the plate's, so it may change during a slice.
    set({ plateLoading: false, activePresets: {}, slice: { ...get().slice, status: 'running' } as never })
    await runCall('presets.copy', { preset: fast, key: 'layer_height', with: fine }, client)
    expect(get().userPresets.find((p) => p.id === fast)!.values['layer_height']).toBe(0.12)
  })

  it('copies a stock value by dropping the change, says what the preset gets, and puts it back', async () => {
    const out = (await runCall('presets.copy', { preset: fast, key: 'wall_loops', against: 'stock' }, client)) as { value: unknown; kept: boolean; undoId: string }
    const p = get().userPresets.find((x) => x.id === fast)!
    expect('wall_loops' in p.values).toBe(false)
    expect(out).toMatchObject({ value: stockFor(p)['wall_loops'], kept: false })
    const back = (await runCall('presets.undo', { undoId: out.undoId }, client)) as { value: unknown; kept: boolean }
    expect(back).toEqual(expect.objectContaining({ value: 5, kept: true }))
  })

  it('refuses an undo for a deleted preset, and a name two presets share', async () => {
    const out = (await runCall('presets.copy', { preset: fast, key: 'layer_height', with: fine }, client)) as { undoId: string }
    await deletePreset(fast)
    expect(await refused('presets.undo', { undoId: out.undoId })).toBe('not_found')
    // savePreset keeps names unique, so a clash comes from a sync file or another device.
    const twin = { ...get().userPresets.find((p) => p.id === fine)!, id: 'up_twin' }
    set({ userPresets: [...get().userPresets, twin] })
    await (await import('../src/presets/store')).presetStore().put(twin)
    const dup = (await runCall('presets.compare', { preset: 'Fine detail', against: 'stock' }).catch((x: unknown) => x)) as LinkError
    expect(dup.code).toBe('invalid_input')
    expect(dup.details?.['ids']).toEqual(expect.arrayContaining([fine, 'up_twin']))
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
    expect(await refused('presets.compare', { preset: fast, against: 'stock', all: 'yes' })).toBe('invalid_input')
    expect(await refused('presets.copy', { preset: fast, key: 'k'.repeat(101), with: fine })).toBe('invalid_input')
    expect(get().userPresets).toEqual(before)
  })
})

describe('the question a preset change puts to the person', () => {
  it('names the client and the change, arms its buttons after a moment, and answers', async () => {
    const { createElement } = await import('react')
    const { act } = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { AppLinkPrompt, ARM_MS } = await import('../src/app-link/prompt')
    const { askPresetWrite } = await import('../src/app-link/preset-asks')
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const proto = HTMLDialogElement.prototype as HTMLDialogElement & { showModal: () => void }
    proto.showModal = function (this: HTMLDialogElement) { this.setAttribute('open', '') }
    proto.close = function (this: HTMLDialogElement) { this.removeAttribute('open') }
    unsub.splice(0).forEach((u) => u())
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    act(() => root.render(createElement(AppLinkPrompt)))
    let yes: boolean | undefined
    act(() => void askPresetWrite({ id: 'c9', name: 'Bench agent' }, 'Set Layer height in Fast draft to 0.12 mm?', ['It is 0.28 mm now.']).then((v) => (yes = v)))
    const allow = () => host.querySelector<HTMLButtonElement>('[data-testid="app-link-preset-allow"]')!
    expect(host.querySelector('[data-testid="app-link-preset"]')!.textContent).toContain('Bench agent')
    expect(host.querySelector('[data-testid="app-link-preset-what"]')!.textContent).toBe('Set Layer height in Fast draft to 0.12 mm?')
    expect(allow().disabled).toBe(true)
    expect(allow().hasAttribute('data-agent-refuse')).toBe(true)
    await act(async () => void (await new Promise((r) => setTimeout(r, ARM_MS + 50))))
    await act(async () => allow().click())
    expect(yes).toBe(true)
    expect(host.querySelector('[data-testid="app-link-preset"]')).toBeNull()
    act(() => root.unmount())
    host.remove()
  })
})
