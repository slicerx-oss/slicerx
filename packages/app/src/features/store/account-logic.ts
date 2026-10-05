// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Account screen rules that need no screen: wording for deletion and tokens, and the export file.
import type { AccountDeletionPlan, ApiToken } from '@slicerx/contracts'

const DAY = 86_400_000

/** Whole days left before the account is removed, never below zero. */
export function daysLeft(purgeAfter: string, now: number = Date.now()): number {
  const t = Date.parse(purgeAfter)
  return Number.isFinite(t) ? Math.max(0, Math.ceil((t - now) / DAY)) : 0
}

export function deletionBanner(pending: { purgeAfter: string }, now: number = Date.now()): string {
  const d = daysLeft(pending.purgeAfter, now)
  const date = new Date(pending.purgeAfter).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })
  return d === 0 ? `Your account is removed on ${date}. Cancel today to keep it.` : `Your account is scheduled for removal on ${date}, in ${d} ${d === 1 ? 'day' : 'days'}. Cancel to keep it.`
}

export function graceLabel(plan: Pick<AccountDeletionPlan, 'graceDays'>): string {
  return `${plan.graceDays} ${plan.graceDays === 1 ? 'day' : 'days'}`
}

export function activeTokens(tokens: readonly ApiToken[], now: number = Date.now()): ApiToken[] {
  return tokens.filter((t) => !t.revokedAt && (!t.expiresAt || Date.parse(t.expiresAt) > now))
}

export function rateLabel(t: Pick<ApiToken, 'rateLimitPerMinute'>): string {
  return `${t.rateLimitPerMinute.toLocaleString('en-US')} requests per minute`
}

export function tokenState(t: ApiToken, now: number = Date.now()): 'revoked' | 'expired' | 'active' {
  if (t.revokedAt) return 'revoked'
  if (t.expiresAt && Date.parse(t.expiresAt) <= now) return 'expired'
  return 'active'
}

export function revokedLabel(n: number): string {
  return n === 0 ? 'No active tokens to revoke.' : `Revoked ${n} ${n === 1 ? 'token' : 'tokens'}.`
}

export function exportFileName(now: Date = new Date()): string {
  return `slicerx-account-export-${now.toISOString().slice(0, 10)}.json`
}
