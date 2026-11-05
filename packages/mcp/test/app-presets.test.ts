// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The saved preset tools forward to the open app's presets.* link methods, check their arguments before anything
// leaves, keep copies behind the edit permission, and pass the app's refusals on with their meaning.
import { describe, expect, it, vi } from 'vitest'
import { appPresetTools } from '../src/app-presets'
import type { AppLinkCaller } from '../src/app-route'

describe('saved preset tools', () => {
  it('reads as reads and copies as edits, forwarding the arguments as given', async () => {
    const call = vi.fn(async (method: string) => (method === 'presets.list' ? { presets: [] } : method === 'presets.compare' ? { preset: { name: 'A' }, with: { name: 'B' }, differ: 1, groups: [] } : method === 'presets.copy' ? { preset: { name: 'A' }, label: 'Layer height', value: 0.12, from: 'B', undoId: 'pu_1' } : { preset: { name: 'A' }, key: 'layer_height', value: 0.2 }))
    const tools = appPresetTools({ call } as unknown as AppLinkCaller, 'SlicerX')
    expect(tools.map((t) => [t.name, t.permission])).toEqual([['app.presets', 'read'], ['app.preset_compare', 'read'], ['app.preset_copy', 'slice'], ['app.preset_undo', 'slice']])
    const [list, compare, copy, undo] = tools
    await list!.run(list!.input.parse({ kind: 'filament' }) as never, {} as never)
    expect(call).toHaveBeenLastCalledWith('presets.list', { kind: 'filament' })
    expect((await compare!.run(compare!.input.parse({ preset: 'A', with: 'B' }) as never, {} as never)).summary).toBe('A and B: 1 setting differs.')
    expect(call).toHaveBeenLastCalledWith('presets.compare', { preset: 'A', with: 'B' })
    await compare!.run(compare!.input.parse({ preset: 'A', against: 'parent', all: true }) as never, {} as never)
    expect(call).toHaveBeenLastCalledWith('presets.compare', { preset: 'A', against: 'parent', all: true })
    await copy!.run(copy!.input.parse({ preset: 'A', key: 'layer_height', with: 'B' }) as never, {} as never)
    expect(call).toHaveBeenLastCalledWith('presets.copy', { preset: 'A', key: 'layer_height', with: 'B' })
    await undo!.run(undo!.input.parse({ undoId: 'pu_1' }) as never, {} as never)
    expect(call).toHaveBeenLastCalledWith('presets.undo', { undoId: 'pu_1' })
  })

  it('refuses a call with no second side or two before anything leaves', async () => {
    const call = vi.fn()
    const [, compare, copy] = appPresetTools({ call } as unknown as AppLinkCaller, 'SlicerX')
    await expect(compare!.run(compare!.input.parse({ preset: 'A' }) as never, {} as never)).rejects.toMatchObject({ code: 'invalid_input', details: { reason: 'no_second' } })
    await expect(copy!.run(copy!.input.parse({ preset: 'A', key: 'k', with: 'B', against: 'stock' }) as never, {} as never)).rejects.toMatchObject({ code: 'invalid_input', details: { reason: 'two_seconds' } })
    expect(compare!.input.safeParse({ preset: 'A', against: 'maker' }).success).toBe(false)
    expect(call).not.toHaveBeenCalled()
  })

  it("passes the app's refusals on with their codes", async () => {
    await expect(appPresetTools(undefined, 'SlicerX')[0]!.run({} as never, {} as never)).rejects.toMatchObject({ code: 'not_configured' })
    for (const [code, want] of [['app_closed', 'not_configured'], ['forbidden', 'not_configured'], ['not_found', 'not_found'], ['invalid_input', 'invalid_input'], ['refused', 'not_supported'], ['busy', 'busy']]) {
      const call = async () => { throw Object.assign(new Error('refused'), { code }) }
      const undo = appPresetTools({ call } as unknown as AppLinkCaller, 'SlicerX')[3]!
      await expect(undo.run({ undoId: 'pu_1' } as never, {} as never), code).rejects.toMatchObject({ code: want })
    }
  })
})
