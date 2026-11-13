// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { expect, it, vi } from 'vitest'
import { appPartInputs, appPartTools, type AppParts } from '../src/app-parts'
import type { AppLinkCaller } from '../src/app-route'

const state: AppParts = { object: { id: 'box', name: 'Box' }, plate: 'plate-1', parts: [], history: null, cloned: { index: 2, name: 'Lid 2' }, changed: true }

it('forwards list, clone, order and rename to the app with read and edit permissions and the parts read back', async () => {
  const call = vi.fn(async () => state)
  const tools = appPartTools({ call } as AppLinkCaller, 'SlicerX')
  expect(tools.map((t) => t.name)).toEqual(['app.parts', 'app.part_clone', 'app.parts_order', 'app.part_rename'])
  const cases = [
    ['parts.list', { object: 'box' }],
    ['parts.clone', { object: 'box', part: 'Lid' }],
    ['parts.clone', { object: 'box', part: 1 }],
    ['parts.order', { object: 'box', order: [1, 0, 2] }],
    ['parts.order', { object: 'box', part: 2, to: 0 }],
    ['parts.rename', { object: 'box', part: 'Hull top top', name: 'Decks' }],
    ['parts.rename', { object: 'box', part: 2, name: 'Decks' }],
  ] as const
  const toolOf: Record<string, string> = { 'parts.list': 'app.parts', 'parts.clone': 'app.part_clone', 'parts.order': 'app.parts_order', 'parts.rename': 'app.part_rename' }
  for (const [method, input] of cases) {
    const tool = tools.find((t) => t.name === toolOf[method])!
    expect(tool.permission).toBe(method === 'parts.list' ? 'read' : 'slice')
    const args = tool.input.parse(input)
    expect((await tool.run(args, {} as never)).output).toEqual(state)
    expect(call).toHaveBeenLastCalledWith(method, args)
  }
})

it('rejects a missing object, negative indices, an order and a move together, and unrelated fields', async () => {
  expect(appPartInputs.clone.safeParse({ object: '', part: 0 }).success).toBe(false)
  expect(appPartInputs.clone.safeParse({ object: 'box', part: -1 }).success).toBe(false)
  expect(appPartInputs.order.safeParse({ object: 'box', order: [0, -1] }).success).toBe(false)
  expect(appPartInputs.list.safeParse({ object: 'box', path: 'x.stl' }).success).toBe(false)
  expect(appPartInputs.rename.safeParse({ object: 'box', part: 0 }).success).toBe(false)
  expect(appPartInputs.rename.safeParse({ object: 'box', part: 0, name: 'Decks', to: 1 }).success).toBe(false)
  const call = vi.fn(async () => state)
  const order = appPartTools({ call } as AppLinkCaller, 'SlicerX')[2]!
  await expect(order.run({ object: 'box' } as never, {} as never)).rejects.toMatchObject({ code: 'invalid_input' })
  for (const mixed of [{ order: [0], part: 0, to: 1 }, { order: [0, 1], part: 0 }, { order: [0, 1], to: 1 }, { part: 0 }, { to: 1 }]) {
    await expect(order.run({ object: 'box', ...mixed } as never, {} as never)).rejects.toMatchObject({ code: 'invalid_input' })
  }
  expect(call).not.toHaveBeenCalled()
})

it('keeps app refusals and needs the app link', async () => {
  await expect(appPartTools(undefined, 'SlicerX')[0]!.run({ object: 'box' } as never, {} as never)).rejects.toMatchObject({ code: 'not_configured' })
  for (const [code, expected] of [['app_closed', 'not_configured'], ['refused', 'not_supported'], ['busy', 'busy'], ['not_found', 'not_found']]) {
    const link = { call: async () => { throw Object.assign(new Error(code), { code }) } }
    await expect(appPartTools(link, 'SlicerX')[1]!.run({ object: 'box', part: 0 } as never, {} as never)).rejects.toMatchObject({ code: expected })
  }
})

it('says whether a rename changed the name', async () => {
  const rename = (changed: boolean) => appPartTools({ call: vi.fn(async () => ({ ...state, cloned: undefined, changed, parts: [{ index: 0, name: 'Decks' }] })) } as unknown as AppLinkCaller, 'SlicerX')[3]!
  expect((await rename(true).run({ object: 'box', part: 0, name: 'Decks' } as never, {} as never)).summary).toBe('Box: renamed, 1 parts read back.')
  expect((await rename(false).run({ object: 'box', part: 0, name: 'Decks' } as never, {} as never)).summary).toBe('Box: already called that, 1 parts read back.')
})

it('asks the person before an edit, naming the object', async () => {
  const tools = appPartTools({ call: vi.fn(async () => state) } as AppLinkCaller, 'SlicerX')
  expect(tools[0]!.approval).toBeUndefined()
  for (const t of tools.slice(1)) expect((await t.approval!({ object: 'Box' } as never, {} as never))!.title).toBe('Change the parts of Box?')
})
