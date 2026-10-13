// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The sheet tools forward to the open app and pass its refusals on with their meaning.
import { describe, expect, it, vi } from 'vitest'
import type { AppLinkCaller } from '../src/app-route'
import { appSheetTools } from '../src/app-sheet'
import { ToolInputError } from '../src/errors'

const SHEET = { title: 'Clip sizes', dims: [{ key: 'bore', label: 'Cable bore', value: 6.2, unit: 'mm', source: 'asked' }] }
const refuse = (code: string) => (async () => {
  throw Object.assign(new Error(`refused: ${code}`), { code })
}) as AppLinkCaller['call']

describe('app sheet tools', () => {
  it('ask and read back through the app link', async () => {
    const call = vi.fn(async (method: string) => (method === 'sheet.ask' ? { sheetId: 'csheet_1', state: 'waiting' } : { sheetId: 'csheet_1', state: 'confirmed', answer: { values: { bore: 6.2 }, changed: [] } }))
    const [ask, get] = appSheetTools({ call } as AppLinkCaller, 'SlicerX')
    const asked = await ask!.run(ask!.input.parse(SHEET) as never, {} as never)
    expect(asked.output).toEqual({ sheetId: 'csheet_1', state: 'waiting' })
    expect(call).toHaveBeenCalledWith('sheet.ask', expect.objectContaining({ title: 'Clip sizes', views: ['iso'] }))
    expect((await get!.run({ sheet_id: 'csheet_1' } as never, {} as never)).output).toMatchObject({ state: 'confirmed', answer: { values: { bore: 6.2 } } })
    expect(call).toHaveBeenLastCalledWith('sheet.get', { sheetId: 'csheet_1' })
  })

  it('check the sheet before it leaves', () => {
    const [ask] = appSheetTools({ call: vi.fn() } as unknown as AppLinkCaller, 'SlicerX')
    expect(ask!.input.safeParse({ title: 'Clip', dims: [] }).success).toBe(false)
    expect(ask!.input.safeParse({ ...SHEET, dims: [{ ...SHEET.dims[0], source: 'lookup' }] }).success).toBe(false)
  })

  it('say how to reach the person while the link is off, and keep the app\'s own refusals', async () => {
    for (const code of ['app_link_off', 'app_closed', 'forbidden']) {
      const [, get] = appSheetTools({ call: refuse(code) }, 'SlicerX')
      const e = (await get!.run({ sheet_id: 'x' } as never, {} as never).catch((x: unknown) => x)) as ToolInputError
      expect(e.code, code).toBe('not_configured')
      expect(e.message, code).toMatch(/SlicerX is closed/)
    }
    for (const [code, want] of [['busy', 'busy'], ['not_found', 'not_found'], ['read_only', 'not_supported']]) {
      const [, get] = appSheetTools({ call: refuse(code!) }, 'SlicerX')
      expect(((await get!.run({ sheet_id: 'x' } as never, {} as never).catch((x: unknown) => x)) as ToolInputError).code, code).toBe(want)
    }
  })
})
