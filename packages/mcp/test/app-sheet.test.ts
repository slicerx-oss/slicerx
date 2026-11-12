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
    expect(call).toHaveBeenCalledWith('sheet.ask', expect.objectContaining({ title: 'Clip sizes', views: ['top', 'front', 'side', 'iso'] }))
    expect((await get!.run({ sheet_id: 'csheet_1' } as never, {} as never)).output).toMatchObject({ state: 'confirmed', answer: { values: { bore: 6.2 } } })
    expect(call).toHaveBeenLastCalledWith('sheet.get', { sheetId: 'csheet_1' })
  })

  it('pass the built design a sheet changes on to the app, with the rows placed on it', async () => {
    const call = vi.fn(async () => ({ sheetId: 'csheet_2', state: 'waiting' }))
    const [ask] = appSheetTools({ call } as unknown as AppLinkCaller, 'SlicerX')
    const sheet = {
      title: 'Case sizes',
      design: 'obj_case',
      dims: [
        { key: 'length', label: 'Length', value: 96, unit: 'mm', source: 'asked', at: { a: [100, 80, 0], b: [196, 80, 0], off: [0, 0, -8] } },
        { key: 'width', label: 'Width', value: 68, unit: 'mm', source: 'asked', at: { a: [196, 80, 0], b: [196, 148, 0], off: [8, 0, 0] } },
      ],
    }
    await ask!.run(ask!.input.parse(sheet) as never, {} as never)
    expect(call).toHaveBeenCalledWith('sheet.ask', expect.objectContaining({ design: 'obj_case', dims: expect.arrayContaining([expect.objectContaining({ key: 'width', at: sheet.dims[1]!.at })]) }))
    // its text tells a client about part, at and design
    expect(ask!.description).toMatch(/\bdesign\b/)
    expect(ask!.description).toMatch(/\bat\b/)
    expect(ask!.description).toMatch(/revolve, sweep or loft/)
  })

  it('is 1.2.0 and passes each row\'s kind on to the app', async () => {
    const call = vi.fn(async () => ({ sheetId: 'csheet_4', state: 'waiting' }))
    const [ask] = appSheetTools({ call } as unknown as AppLinkCaller, 'SlicerX')
    expect(ask!.version).toBe('1.3.0')
    await ask!.run(ask!.input.parse({ ...SHEET, dims: [{ ...SHEET.dims[0], key: 'spokes', kind: 'count' }] }) as never, {} as never)
    expect(call).toHaveBeenCalledWith('sheet.ask', expect.objectContaining({ dims: [expect.objectContaining({ key: 'spokes', kind: 'count' })] }))
  })

  it('check the sheet before it leaves', () => {
    const [ask] = appSheetTools({ call: vi.fn() } as unknown as AppLinkCaller, 'SlicerX')
    expect(ask!.input.safeParse({ title: 'Clip', dims: [] }).success).toBe(false)
    expect(ask!.input.safeParse({ ...SHEET, dims: [{ ...SHEET.dims[0], source: 'lookup' }] }).success).toBe(false)
    // a solid missing a field its kind needs is named, so the client can fix it
    const sweep = { kind: 'sweep', path: [[0, 0, 0], [0, 0, 50]], round: 10 }
    const bad = ask!.input.safeParse({ ...SHEET, part: [sweep] })
    expect(bad.success).toBe(false)
    expect(bad.error!.issues.map((i) => i.message).join('; ')).toContain('part 1 (sweep) needs profile')
  })

  it('send a part on to the app with each solid\'s kind and fields', async () => {
    const call = vi.fn(async () => ({ sheetId: 'csheet_3', state: 'waiting' }))
    const [ask] = appSheetTools({ call } as unknown as AppLinkCaller, 'SlicerX')
    const sweep = { kind: 'sweep', profile: { d: 20, hole: 16 }, path: [[0, 0, 0], [0, 0, 50], [50, 0, 50]], round: 25 }
    const parsed = ask!.input.safeParse({ ...SHEET, part: [sweep] })
    expect(parsed.success).toBe(true)
    await ask!.run(parsed.data as never, {} as never)
    expect(call).toHaveBeenCalledWith('sheet.ask', expect.objectContaining({ part: [expect.objectContaining(sweep)] }))
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
