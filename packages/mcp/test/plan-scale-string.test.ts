// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A plan's scale as a number, as "1:N", or as bare digits, the way the command form sends a number.
import { expect, it } from 'vitest'
import { planDetailFields } from '../src/plan-detail'
it('takes scale as a number, "1200" or "1:1200"', () => {
  for (const v of [1200, '1200', '1:1200', '1 : 1200']) expect(planDetailFields.scale.safeParse(v).success, String(v)).toBe(true)
  expect(planDetailFields.scale.safeParse('big').success).toBe(false)
})
