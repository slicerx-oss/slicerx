// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { ApiToken } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { activeTokens, daysLabel, daysLeft, deletionBanner, expiryLabel, exportFileName, graceLabel, ownTokens, partnerTokens, rateLabel, revokedLabel, tokenState } from '../src/features/store/account-logic'

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
  it('keeps partner app tokens apart from the member\'s own tokens, sorted by app', () => {
    const all = [
      tok({ id: 'cli', name: 'Laptop CLI' }),
      tok({ id: 'b2', name: 'Phone B', partnerApp: 'Phone B', scopes: ['cloud_slice'], createdAt: '2026-02-01T00:00:00Z' }),
      tok({ id: 'a', name: 'App A', partnerApp: 'App A', scopes: ['cloud_slice'] }),
      tok({ id: 'b1', name: 'Phone B', partnerApp: 'Phone B', scopes: ['cloud_slice'], createdAt: '2026-01-01T00:00:00Z' }),
    ]
    expect(ownTokens(all).map((t) => t.id)).toEqual(['cli'])
    expect(partnerTokens(all).map((t) => t.id)).toEqual(['a', 'b2', 'b1'])
  })
  it('words a token\'s expiry and the expiry choices', () => {
    expect(expiryLabel({ expiresAt: '2026-12-29T00:00:00Z' }, now)).toBe('expires Dec 29, 2026')
    expect(expiryLabel({ expiresAt: '2026-09-01T00:00:00Z' }, now)).toBe('expired Sep 1, 2026')
    expect(expiryLabel({}, now)).toBe('never expires')
    expect(expiryLabel({ revokedAt: '2026-09-02T00:00:00Z', expiresAt: '2026-12-29T00:00:00Z' }, now)).toBe('revoked Sep 2, 2026')
    expect([30, 90, 365].map(daysLabel)).toEqual(['30 days', '90 days', '1 year'])
  })
})
