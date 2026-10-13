// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What a refusal or a failure reads like to the app: a plain message, and a stable code to
// match on (the database's own hint stays in `reason` for older apps). The provider's own
// words never reach the person; they go to the function log, cut to 300 characters.

/** Every code the proxy answers with. Apps match on these; never rename one. */
export type MimirCode =
  | 'day_used'
  | 'edition_day_used'
  | 'still_answering'
  | 'slow_down'
  | 'busy'
  | 'paused'
  | 'not_registered'
  | 'register_refused'
  | 'no_ip'
  | 'invalid_request'
  | 'too_large'
  | 'provider_busy'
  | 'provider_error'
  | 'unreachable'
  | 'server_error'
  | 'not_found'

/** The next midnight in Melbourne, when every daily cap starts over (mimir_day in 0020). */
export function resetsAt(now: Date): Date {
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne' }).format(now).split('-').map(Number)
  const [y, m, d] = ymd as [number, number, number]
  // Melbourne is 10 or 11 hours ahead; take the offset that lands on 00:00 there
  for (const off of [11, 10]) {
    const t = new Date(Date.UTC(y, m - 1, d + 1) - off * 3_600_000)
    const at = new Intl.DateTimeFormat('en-GB', { timeZone: 'Australia/Melbourne', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(t)
    if (at === '00:00') return t
  }
  return new Date(Date.UTC(y, m - 1, d + 1) - 10 * 3_600_000)
}

/** "5 h 12 min", "12 min", "1 min". */
export function inWords(ms: number): string {
  const min = Math.max(1, Math.ceil(ms / 60_000))
  const h = Math.floor(min / 60)
  return h ? `${h} h ${min % 60} min` : `${min} min`
}

/** A short id that ties what the person saw to the log line. */
export const errorId = (): string => crypto.randomUUID().replaceAll('-', '').slice(0, 8)

export const PAUSED = 'Free mimir is paused right now. We know and are fixing it. Your own key or a local model still works.'

/** The database's refusal hints, as the app sees them. */
export function capRefusal(hint: string, now: Date): { status: number; code: MimirCode; message: string; resetsAt?: string } | null {
  const reset = resetsAt(now)
  const left = inWords(reset.getTime() - now.getTime())
  switch (hint) {
    case 'install_daily':
    case 'ip_daily':
    case 'net_daily':
    case 'net_full':
      return { status: 429, code: 'day_used', message: `You've used today's free mimir. It resets in ${left}.`, resetsAt: reset.toISOString() }
    case 'edition_daily':
      return { status: 429, code: 'edition_day_used', message: `Free mimir is busy for today. It resets in ${left}.`, resetsAt: reset.toISOString() }
    case 'install_busy':
    case 'ip_busy':
    case 'net_busy':
      return { status: 429, code: 'still_answering', message: 'mimir is still answering your last message. Try again when it finishes.' }
    case 'install_rate':
    case 'ip_rate':
      return { status: 429, code: 'slow_down', message: 'Slow down a moment, then try again.' }
    case 'edition_busy':
      return { status: 503, code: 'busy', message: 'Free mimir is busy right now. Try again in a moment.' }
    case 'paused':
      return { status: 503, code: 'paused', message: PAUSED }
    case 'unknown_install':
      return { status: 401, code: 'not_registered', message: 'This install is not registered with mimir.' }
    case 'register_key':
      return { status: 403, code: 'register_refused', message: 'This build of the app cannot use free mimir.' }
    case 'register_limit':
      return { status: 429, code: 'register_refused', message: 'Too many new installs from this network today. Try again tomorrow.' }
    case 'edition_register_limit':
      return { status: 429, code: 'register_refused', message: 'Free mimir is taking no new installs today. Try again tomorrow.' }
    case 'no_ip':
      return { status: 400, code: 'no_ip', message: 'mimir could not tell which network this came from.' }
    default:
      return null
  }
}

/**
 * Whether the provider refused us for money or access: Anthropic's low credit balance (a 400),
 * a 402, a 403, or a 401 for a key it no longer takes. Free mimir is down for everyone then.
 */
export function providerPaused(status: number, type?: string, message?: string): boolean {
  if (status === 401 || status === 402 || status === 403) return true
  return /credit balance|billing|payment/i.test(`${type ?? ''} ${message ?? ''}`)
}

/** One line in the function log per refusal or provider error, as JSON so it can be searched. */
export function logLine(level: 'info' | 'error', fields: Record<string, unknown>): void {
  const line = JSON.stringify({ mimir: level === 'error' ? 'provider_error' : 'refusal', ...fields })
  if (level === 'error') console.error(line)
  else console.log(line)
}

/** The install as the log shows it: a hash, never the token. */
export async function installRef(tok: string | null): Promise<string | null> {
  if (!tok) return null
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`mimir-log|${tok}`))
  return [...new Uint8Array(d).slice(0, 6)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
