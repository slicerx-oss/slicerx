// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { expect, it } from 'vitest'
import type { AppLinkCaller } from '../src/app-route'
import { sheetTool } from '@slicerx/pilot'
import { appSheetTools } from '../src/app-sheet'
import { mimirAskTools } from '../src/mimir-ask'

it('slicerx_mimir_session is 1.5.0 and says a question answered on a phone carries answeredOn, error lines their code and waiting, that a waiting size sheet shows with each unit as the sheet shows it, and that a new part is a reason Auto gives', () => {
  const tool = mimirAskTools({ call: async () => ({}) } as unknown as AppLinkCaller, 'SlicerX').find((t) => t.name === 'mimir.session')
  expect(tool?.version).toBe('1.5.0')
  expect(tool?.description).toMatch(/person_sizes, new_part or default/)
  expect(tool?.description).toMatch(/answeredOn/)
  expect(tool?.description).toMatch(/the error lines with their code \(one with waiting true is free mimir waiting out its limit/)
  expect(tool?.description).toMatch(/size sheet it waits on \(its sheetId/)
  expect(tool?.description).toMatch(/each size's unit as the sheet shows it: mm, deg, % or count/)
})

it('slicerx_mimir_dismiss is 1.1.0 and says it sets a waiting size sheet aside, never confirming one', () => {
  const tool = mimirAskTools({ call: async () => ({}) } as unknown as AppLinkCaller, 'SlicerX').find((t) => t.name === 'mimir.dismiss')
  expect(tool?.version).toBe('1.1.0')
  expect(tool?.description).toMatch(/sets the sheet aside/)
  expect(tool?.description).toMatch(/never confirms a sheet/)
  // a 1.0 client sends no ids; it must never set a sheet aside or cancel it
  expect(tool?.description).toMatch(/a call without sheetId never touches one/)
  expect((tool?.input as unknown as { shape: Record<string, { description?: string }> }).shape['sheetId']?.description).toMatch(/only when this is given/)
})

it('slicerx_app_sheet_ask is 1.3.0 and pilot.sheet 1.4.0, and both say a part can be a revolve, sweep or loft', () => {
  const ask = appSheetTools({ call: async () => ({}) } as unknown as AppLinkCaller, 'SlicerX').find((t) => t.name === 'app.sheet_ask')
  const sheet = sheetTool()
  expect(ask?.version).toBe('1.3.0')
  expect(sheet.version).toBe('1.4.0')
  for (const tool of [ask, sheet]) {
    expect(tool?.description, tool?.name).toMatch(/revolve, sweep or loft/)
  }
  // both take a bent tube as the sweep it is built as
  const elbow = { title: 'Pipe elbow', dims: [{ key: 'od', label: 'Outside diameter', value: 32, unit: 'mm', source: 'asked' }], part: [{ kind: 'sweep', profile: { d: 32, hole: 27 }, path: [[0, 0, 0], [0, 0, 70], [70, 0, 70]], round: 50 }] }
  for (const tool of [ask, sheet]) expect(tool?.input.safeParse(elbow).success, tool?.name).toBe(true)
})
