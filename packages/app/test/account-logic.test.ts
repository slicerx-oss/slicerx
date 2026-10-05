// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { ApiToken } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { activeTokens, daysLeft, deletionBanner, exportFileName, graceLabel, rateLabel, revokedLabel, tokenState } from '../src/features/store/account-logic'

const now = Date.parse('2026-09-30T12:00:00Z')
const tok = (o: Partial<ApiToken>): ApiToken => ({ id: 't', name: 'n', prefix: 'sx_abc', scopes: ['read'], rateLimitPerMinute: 60, createdAt: '2026-01-01T00:00:00Z', ...o })

describe('account rules', () => {
  it('counts days to deletion, rounding up and never below zero', () => {
    expect(daysLeft('2026-10-30T12:00:00Z', now)).toBe(30)
    expect(daysLeft('2026-10-01T00:00:00Z', now)).toBe(1)
    expect(daysLeft('2026-09-01T00:00:00Z', now)).toBe(0)
    expect(daysLeft('nonsense', now)).toBe(0)
  })
  it('words the pending banner', () => {
    expect(deletionBanner({ purgeAfter: '2026-10-30T12:00:00Z' }, now)).toBe('Your account is scheduled for removal on October 30, 2026, in 30 days. Cancel to keep it.')
    expect(deletionBanner({ purgeAfter: '2026-10-01T00:00:00Z' }, now)).toContain('in 1 day.')
  })
  it('labels the grace period and token rates', () => {
    expect(graceLabel({ graceDays: 30 })).toBe('30 days')
    expect(graceLabel({ graceDays: 1 })).toBe('1 day')
    expect(rateLabel({ rateLimitPerMinute: 1200 })).toBe('1,200 requests per minute')
  })
  it('separates active, revoked and expired tokens', () => {
    const list = [tok({ id: 'a' }), tok({ id: 'b', revokedAt: '2026-02-01T00:00:00Z' }), tok({ id: 'c', expiresAt: '2026-06-01T00:00:00Z' }), tok({ id: 'd', expiresAt: '2027-01-01T00:00:00Z' })]
    expect(activeTokens(list, now).map((t) => t.id)).toEqual(['a', 'd'])
    expect(list.map((t) => tokenState(t, now))).toEqual(['active', 'revoked', 'expired', 'active'])
  })
  it('words the revoke result and the export file', () => {
    expect(revokedLabel(0)).toBe('No active tokens to revoke.')
    expect(revokedLabel(1)).toBe('Revoked 1 token.')
    expect(revokedLabel(3)).toBe('Revoked 3 tokens.')
    expect(exportFileName(new Date('2026-09-30T05:00:00Z'))).toBe('slicerx-account-export-2026-09-30.json')
  })
})
