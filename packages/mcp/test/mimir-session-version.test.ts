// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { expect, it } from 'vitest'
import type { AppLinkCaller } from '../src/app-route'
import { mimirAskTools } from '../src/mimir-ask'

it('slicerx_mimir_session is 1.1.0 and says a question answered on a phone carries answeredOn', () => {
  const tool = mimirAskTools({ call: async () => ({}) } as unknown as AppLinkCaller, 'SlicerX').find((t) => t.name === 'mimir.session')
  expect(tool?.version).toBe('1.1.0')
  expect(tool?.description).toMatch(/answeredOn/)
})
