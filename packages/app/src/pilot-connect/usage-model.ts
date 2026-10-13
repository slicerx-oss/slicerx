// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Free mimir use as the usage page shows it: what is left of each allowance, reset times in the person's own clock.
// No money.

/** One install's free mimir use. The day's `used` is a share of the daily limit, 0 to 1, and resets at the server's
 * day boundary (an ISO time). There is no weekly limit; the last 7 days are use only. */
export interface MimirUsage {
  day: { used: number; resetsAt: string }
  /** The last 24 hours, oldest first, each hour as a share of the daily limit. */
  hourly: number[]
  /** The last 7 days, oldest first with today last, each as a share of the daily limit; absent from an older proxy. */
  daily?: number[]
  perMinute: { limit: number }
}

/** The share used as a whole percent, held to 0..100. */
export function usedPercent(used: number): number {
  return Math.round(Math.min(1, Math.max(0, Number.isFinite(used) ? used : 0)) * 100)
}

/** What is left, as a whole percent; with usedPercent it always adds up to 100. */
export function leftPercent(used: number): number {
  return 100 - usedPercent(used)
}

/** "Resets in 5 h 12 min (12:00 AM)": the server's reset time on the person's own clock, with the day once it is a day or more away. */
export function resetsIn(resetsAt: string, now: Date = new Date(), locale?: string, timeZone?: string): string {
  const at = new Date(resetsAt)
  if (Number.isNaN(at.getTime())) return ''
  const mins = Math.max(0, Math.ceil((at.getTime() - now.getTime()) / 60_000))
  const h = Math.floor(mins / 60)
  const m = mins % 60
  const span = h >= 24 ? `${Math.floor(h / 24)} d ${h % 24} h` : h > 0 ? `${h} h ${m} min` : `${m} min`
  const clock = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', ...(h >= 24 ? { weekday: 'short' } : {}), ...(timeZone ? { timeZone } : {}) }).format(at)
  return `Resets in ${span} (${clock})`
}

/** The last `count` values as bar heights 0..1 against the busiest one (an empty stretch stays flat). */
export function chartBars(values: readonly number[], count: number): number[] {
  const last = Array.from({ length: count }, (_, i) => values[values.length - count + i] ?? 0).map((v) => (Number.isFinite(v) && v > 0 ? v : 0))
  const top = Math.max(...last)
  return top > 0 ? last.map((v) => v / top) : last
}
