// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { expect, it } from 'vitest'
import type { AppLinkCaller } from '../src/app-route'
import { mimirAskTools } from '../src/mimir-ask'

it('slicerx_mimir_session is 1.2.0 and says a question answered on a phone carries answeredOn, and that a waiting size sheet shows', () => {
  const tool = mimirAskTools({ call: async () => ({}) } as unknown as AppLinkCaller, 'SlicerX').find((t) => t.name === 'mimir.session')
  expect(tool?.version).toBe('1.2.0')
  expect(tool?.description).toMatch(/answeredOn/)
  expect(tool?.description).toMatch(/size sheet it waits on \(its sheetId/)
})

it('slicerx_mimir_dismiss is 1.1.0 and says it sets a waiting size sheet aside, never confirming one', () => {
  const tool = mimirAskTools({ call: async () => ({}) } as unknown as AppLinkCaller, 'SlicerX').find((t) => t.name === 'mimir.dismiss')
  expect(tool?.version).toBe('1.1.0')
  expect(tool?.description).toMatch(/sets the sheet aside/)
  expect(tool?.description).toMatch(/never confirms a sheet/)
})
