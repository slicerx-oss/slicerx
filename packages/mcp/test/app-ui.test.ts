// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The window tools forward to the open app, read the window back, check their arguments before anything leaves, and
// pass the app's refusals on with their meaning.
import { describe, expect, it, vi } from 'vitest'
import { appUiTools, type AppUi } from '../src/app-ui'
import type { AppLinkCaller } from '../src/app-route'
import { ToolInputError } from '../src/errors'

const refuse = (code: string, message = `refused: ${code}`) => (async () => {
  throw Object.assign(new Error(message), { code })
}) as AppLinkCaller['call']

const UI: AppUi = {
  workspace: 'prepare',
  workspaces: [{ id: 'prepare', label: 'Slice' }, { id: 'library', label: 'My models' }],
  tab: 'design',
  tabs: ['slice', 'design', 'mimir'],
  selection: { primary: { id: 'obj_2', name: 'Clip' }, objects: [{ id: 'obj_2', name: 'Clip' }, { id: 'obj_1', name: 'Box' }] },
  plate: { number: 2, id: 'plate-2', name: 'Brackets', count: 2 },
  printer: { name: 'Bay 2', vendor: 'Bambu Lab', model: 'P1S', nozzleMm: 0.4, fromProject: false },
  panels: { open: ['settings'], settingsSection: 'look', settable: ['settings', 'command', 'about'] },
}

describe('app ui tools', () => {
  it('read the window, switch it and set the selection and panels, each answer read back from the app', async () => {
    let ui = UI
    const call = vi.fn(async (method: string, args?: Record<string, unknown>) => {
      if (method === 'ui.set') ui = { ...ui, ...(args?.['tab'] ? { tab: args['tab'] as AppUi['tab'] } : {}) }
      if (method === 'ui.select') ui = { ...ui, panels: { ...ui.panels, open: [] } }
      return ui
    })
    const [get, set, select] = appUiTools({ call } as AppLinkCaller, 'SlicerX')
    expect([get!.name, set!.name, select!.name]).toEqual(['app.ui', 'app.ui_set', 'app.ui_select'])
    // switching the window reads; the selection and panels are an edit
    expect([get!.permission, set!.permission, select!.permission]).toEqual(['read', 'read', 'slice'])
    const read = await get!.run({} as never, {} as never)
    expect(call).toHaveBeenLastCalledWith('ui.get', {})
    expect(read.output).toEqual(UI)
    expect(read.summary).toBe('Model tab; 2 selected (Clip, Box); plate 2 of 2 (Brackets); printer Bay 2; open: settings (look).')
    const switched = await set!.run(set!.input.parse({ tab: 'slice' }) as never, {} as never)
    expect(call).toHaveBeenLastCalledWith('ui.set', { tab: 'slice' })
    expect(switched.summary).toBe('Slice tab; 2 selected (Clip, Box); plate 2 of 2 (Brackets); printer Bay 2; open: settings (look).')
    const closed = await select!.run(select!.input.parse({ close: 'all' }) as never, {} as never)
    expect(call).toHaveBeenLastCalledWith('ui.select', { close: 'all' })
    expect(closed.summary).toBe('Slice tab; 2 selected (Clip, Box); plate 2 of 2 (Brackets); printer Bay 2; no panel open.')
    await select!.run(select!.input.parse({ selection: [], open: 'settings', section: 'controls' }) as never, {} as never)
    expect(call).toHaveBeenLastCalledWith('ui.select', { selection: [], open: 'settings', section: 'controls' })
  })

  it('read a by-object plate back with its clearance plan and say how many problems it has', async () => {
    const byObject = { needMm: 68, pairs: [{ a: { id: 'obj_1', name: 'Box' }, b: { id: 'obj_2', name: 'Clip' }, gapMm: 47, severity: 'block' as const }], tall: [], gantry: { rodMm: 34, reachMm: 20 }, outlines: [] }
    const [get] = appUiTools({ call: async () => ({ ...UI, tab: 'slice', byObject }) } as unknown as AppLinkCaller, 'SlicerX')
    const read = await get!.run({} as never, {} as never)
    expect((read.output as AppUi).byObject).toEqual(byObject)
    expect(read.summary).toBe('Slice tab; 2 selected (Clip, Box); plate 2 of 2 (Brackets); printer Bay 2; open: settings (look); by object, 1 clearance problem (slicerx_arrange spaces the objects).')
    const [calm] = appUiTools({ call: async () => ({ ...UI, tab: 'slice', byObject: { ...byObject, pairs: [{ ...byObject.pairs[0]!, severity: 'soft' as const }] } }) } as unknown as AppLinkCaller, 'SlicerX')
    expect((await calm!.run({} as never, {} as never)).summary).toMatch(/; by object, 1 close call sx slices \(slicerx_arrange spaces the objects\)\.$/)
    const [clear] = appUiTools({ call: async () => ({ ...UI, tab: 'slice', byObject: { ...byObject, pairs: [] } }) } as unknown as AppLinkCaller, 'SlicerX')
    expect((await clear!.run({} as never, {} as never)).summary).toMatch(/; by object, clear\.$/)
  })

  it('say when nothing is selected, no printer is chosen and another workspace is up', async () => {
    const other: AppUi = { ...UI, workspace: 'library', selection: { primary: null, objects: [] }, printer: null, panels: { ...UI.panels, open: [], settingsSection: null } }
    const [get] = appUiTools({ call: async () => other } as unknown as AppLinkCaller, 'SlicerX')
    expect((await get!.run({} as never, {} as never)).summary).toBe('My models workspace; nothing selected; plate 2 of 2 (Brackets); no printer chosen; no panel open.')
  })

  it('check the arguments before anything leaves, each tool taking only its own', () => {
    const [, set, select] = appUiTools({ call: vi.fn() } as unknown as AppLinkCaller, 'SlicerX')
    for (const bad of [{}, { tab: 'paint' }, { workspace: '' }]) expect(set!.input.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    for (const good of [{ tab: 'mimir' }, { workspace: 'library' }, { workspace: 'prepare', tab: 'design' }]) expect(set!.input.safeParse(good).success, JSON.stringify(good)).toBe(true)
    // the read tool drops the edit arguments, so nothing but a workspace or tab reaches ui.set
    expect(set!.input.safeParse({ selection: ['Box'] }).success).toBe(false)
    expect(set!.input.parse({ tab: 'slice', open: 'about' } as never)).toEqual({ tab: 'slice' })
    for (const bad of [{}, { open: 'agreement' }, { close: 'setup' }, { selection: 'Box' }, { selection: [''] }, { section: 'look' }, { open: 'about', section: 'look' }, { tab: 'slice' }]) {
      expect(select!.input.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    }
    for (const good of [{ selection: [] }, { selection: ['Box', 'obj_2'] }, { open: 'settings', section: 'agents' }, { close: 'all' }, { open: 'printerSettings' }]) {
      expect(select!.input.safeParse(good).success, JSON.stringify(good)).toBe(true)
    }
  })

  it("say how to reach the app while the link is off or missing, and keep the app's own refusals", async () => {
    const [none] = appUiTools(undefined, 'SlicerX')
    expect(((await none!.run({} as never, {} as never).catch((x: unknown) => x)) as ToolInputError).code).toBe('not_configured')
    for (const code of ['app_link_off', 'app_closed', 'forbidden']) {
      const [get] = appUiTools({ call: refuse(code) }, 'SlicerX')
      const e = (await get!.run({} as never, {} as never).catch((x: unknown) => x)) as ToolInputError
      expect(e.code, code).toBe('not_configured')
      expect(e.message, code).toMatch(/SlicerX is closed/)
    }
    const [unpaired] = appUiTools({ call: refuse('unauthorized') }, 'SlicerX')
    expect(((await unpaired!.run({} as never, {} as never).catch((x: unknown) => x)) as ToolInputError).message).toMatch(/not connected to SlicerX's open project/)
    for (const [code, want] of [['invalid_input', 'invalid_input'], ['not_found', 'not_found'], ['busy', 'busy'], ['read_only', 'not_supported'], ['strange', 'internal_error']]) {
      const [, , select] = appUiTools({ call: refuse(code!, 'the person is using a tool') }, 'SlicerX')
      const e = (await select!.run({ close: 'all' } as never, {} as never).catch((x: unknown) => x)) as ToolInputError
      expect(e, code).toBeInstanceOf(ToolInputError)
      expect(e.code, code).toBe(want)
      if (code === 'busy') expect(e.message).toBe('the person is using a tool (busy in SlicerX: wait a moment and call again)')
    }
  })
})
