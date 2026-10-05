// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// One bug or crash report, as submit_bug_report takes it (docs/bug-intake.md). finishReport scrubs every
// field and fits it to the column limits; what it returns is exactly what is sent.
import { fingerprint, scrub } from './scrub'

export type ReportKind = 'crash' | 'manual'

/** A report as the app gathers it, before scrubbing. */
export interface RawReport {
  kind: ReportKind
  title: string
  body: string
  stack?: string | null
  logTail?: string | null
  appVersion: string
  commit: string
  os: string
  printer?: string | null
}

/** A scrubbed report that fits the table: the payload, field for field. */
export interface BugReport {
  kind: ReportKind
  title: string
  body: string
  stack: string | null
  logTail: string | null
  fingerprint: string | null
  appVersion: string
  commit: string
  os: string
  printer: string | null
}

/** Column limits of public.bug_reports, in characters. */
export const LIMITS = { appVersion: 40, commit: 40, os: 80, printer: 120, title: 200, body: 20_000, stack: 50_000, logTail: 200_000, fingerprint: 128 } as const

const head = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 6)} [cut]`)

/** The end of a long log, starting on a whole line. */
function tail(s: string, n: number): string {
  if (s.length <= n) return s
  const cut = s.slice(s.length - n)
  const nl = cut.indexOf('\n')
  return nl >= 0 && nl < 2000 ? cut.slice(nl + 1) : cut
}

const opt = (s: string | null | undefined, n: number, fit = head): string | null => {
  const v = s ? scrub(s).trim() : ''
  return v ? fit(v, n) : null
}

export function finishReport(r: RawReport): BugReport {
  const title = head(scrub(r.title).replace(/\s+/g, ' ').trim(), LIMITS.title) || (r.kind === 'crash' ? 'Crash' : 'Bug report')
  const stack = opt(r.stack, LIMITS.stack)
  return {
    kind: r.kind,
    title,
    body: head(scrub(r.body).trim(), LIMITS.body),
    stack,
    logTail: opt(r.logTail, LIMITS.logTail, tail),
    // Crashes group by their stack; manual reports are each their own.
    fingerprint: r.kind === 'crash' ? fingerprint(title, stack) : null,
    appVersion: head(scrub(r.appVersion).trim(), LIMITS.appVersion) || 'unknown',
    commit: head(r.commit.trim(), LIMITS.commit) || 'unknown',
    os: head(scrub(r.os).trim(), LIMITS.os) || 'unknown',
    printer: opt(r.printer, LIMITS.printer),
  }
}

/** The arguments of public.submit_bug_report. */
export function rpcArgs(r: BugReport, installId: string): Record<string, string | null> {
  return {
    p_kind: r.kind,
    p_install_id: installId,
    p_app_version: r.appVersion,
    p_commit: r.commit,
    p_os: r.os,
    p_printer: r.printer,
    p_title: r.title,
    p_body: r.body,
    p_stack: r.stack,
    p_log_tail: r.logTail,
    p_fingerprint: r.fingerprint,
  }
}

/** The operating system from the browser's user agent, for builds without a shell to ask. */
export function osFromUserAgent(ua: string): string {
  const mac = /Mac OS X (\d+)[._](\d+)/.exec(ua)
  if (/iPhone|iPad/.test(ua)) return `iOS ${/OS (\d+)_(\d+)/.exec(ua)?.slice(1, 3).join('.') ?? ''}`.trim()
  if (/Android (\d+(?:\.\d+)?)/.test(ua)) return `Android ${/Android (\d+(?:\.\d+)?)/.exec(ua)![1]}`
  if (/Windows NT 10/.test(ua)) return 'Windows 10 or 11'
  if (/Windows NT (\d+\.\d+)/.test(ua)) return `Windows NT ${/Windows NT (\d+\.\d+)/.exec(ua)![1]}`
  // Browsers freeze the macOS version at 10.15 in the user agent, so only the platform is certain.
  if (mac) return mac[1] === '10' && mac[2] === '15' ? 'macOS' : `macOS ${mac[1]}.${mac[2]}`
  if (/CrOS/.test(ua)) return 'ChromeOS'
  if (/Linux/.test(ua)) return 'Linux'
  return 'unknown'
}

/** The browser and its version, so a browser build's report says where it ran. */
export function browserFromUserAgent(ua: string): string {
  const m = /(Edg|Firefox|Chrome|Version)\/(\d+)/.exec(ua)
  if (!m) return ''
  const name = m[1] === 'Edg' ? 'Edge' : m[1] === 'Version' ? 'Safari' : m[1]
  return `${name} ${m[2]}`
}
