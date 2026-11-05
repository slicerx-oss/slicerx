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
    expect(call).toHaveBeenLastCalledWith('presets.copy', { preset: 'A', key: 'layer_height', with: 'B' }, { timeoutMs: 120_000 })
    await undo!.run(undo!.input.parse({ undoId: 'pu_1' }) as never, {} as never)
    expect(call).toHaveBeenLastCalledWith('presets.undo', { undoId: 'pu_1' }, { timeoutMs: 120_000 })
  })

  it('refuses a call with no second side or two before anything leaves', async () => {
    const call = vi.fn()
    const [, compare, copy] = appPresetTools({ call } as unknown as AppLinkCaller, 'SlicerX')
    await expect(compare!.run(compare!.input.parse({ preset: 'A' }) as never, {} as never)).rejects.toMatchObject({ code: 'invalid_input', details: { reason: 'no_second' } })
    await expect(copy!.run(copy!.input.parse({ preset: 'A', key: 'k', with: 'B', against: 'stock' }) as never, {} as never)).rejects.toMatchObject({ code: 'invalid_input', details: { reason: 'two_seconds' } })
    expect(compare!.input.safeParse({ preset: 'A', against: 'maker' }).success).toBe(false)
    expect(call).not.toHaveBeenCalled()
  })

  it("passes the app's refusals on with their codes, from every tool", async () => {
    await expect(appPresetTools(undefined, 'SlicerX')[0]!.run({} as never, {} as never)).rejects.toMatchObject({ code: 'not_configured' })
    const args = [{}, { preset: 'A', with: 'B' }, { preset: 'A', key: 'layer_height', with: 'B' }, { undoId: 'pu_1' }]
    const table: [string, string][] = [
      ['app_closed', 'not_configured'], ['app_link_off', 'not_configured'], ['forbidden', 'not_configured'], ['unauthorized', 'not_configured'],
      ['read_only', 'not_supported'], ['denied', 'not_supported'], ['refused', 'not_supported'],
      ['not_found', 'not_found'], ['invalid_input', 'invalid_input'], ['bad_request', 'invalid_input'], ['busy', 'busy'], ['not_ready', 'busy'], ['something_new', 'internal_error'],
    ]
    for (const [code, want] of table) {
      const call = async () => { throw Object.assign(new Error(`the app said ${code}`), { code }) }
      for (const [i, tool] of appPresetTools({ call } as unknown as AppLinkCaller, 'SlicerX').entries()) {
        await expect(tool.run(args[i] as never, {} as never), `${tool.name} ${code}`).rejects.toMatchObject({ code: want, details: { appLink: code } })
      }
    }
    // A client allowed to read only hears why its copy did not happen.
    const readOnly = async () => { throw Object.assign(new Error('the person allowed Bench agent to read the open project, not to change it'), { code: 'read_only' }) }
    const [, , copy, undo] = appPresetTools({ call: readOnly } as unknown as AppLinkCaller, 'SlicerX')
    for (const t of [copy!, undo!]) await expect(t.run(args[t === copy ? 2 : 3] as never, {} as never)).rejects.toMatchObject({ code: 'not_supported', message: expect.stringContaining('read the open project, not to change it'), details: { appLink: 'read_only' } })
    // A person's decline keeps its reason.
    const declined = async () => { throw Object.assign(new Error('The person declined: A was not changed'), { code: 'refused', details: { reason: 'declined' } }) }
    await expect(appPresetTools({ call: declined } as unknown as AppLinkCaller, 'SlicerX')[2]!.run(args[2] as never, {} as never)).rejects.toMatchObject({ code: 'not_supported', details: { appLink: 'refused', reason: 'declined' } })
  })
})
