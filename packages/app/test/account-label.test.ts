// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { accountLabel } from '../src/features/store/queries'

describe('the account label', () => {
  it('is the email local part as typed until there is a creator page, not the derived handle', () => {
    expect(accountLabel({ email: 'qa-win@qa.slicerx.app', handle: 'qawin', displayName: 'qawin' }, null)).toBe('qa-win')
  })

  it('is the creator page name once there is one', () => {
    expect(accountLabel({ email: 'qa-win@qa.slicerx.app', handle: 'qawin', displayName: 'qawin' }, { displayName: 'QA Win' })).toBe('QA Win')
    expect(accountLabel({ email: 'qa-win@qa.slicerx.app', handle: 'qawin' }, { displayName: '  ' })).toBe('qa-win')
  })

  it('falls back to the profile name without an email', () => {
    expect(accountLabel({ handle: 'rv', displayName: 'RV' }, null)).toBe('RV')
    expect(accountLabel({}, null)).toBe('Account')
  })
})
