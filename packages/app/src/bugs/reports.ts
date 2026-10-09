// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Crash and bug reports (docs/bug-intake.md). Crashes are caught automatically: errors nothing handled,
// a workspace that crashed, and from the desktop shell Rust panics and a web view that died or reloaded.
// Each becomes a scrubbed report in the outbox, sent at once when possible and otherwise at the next
// launch. Help, Report a bug sends a manual report through the same path.
import type { Host } from '@slicerx/contracts'
import { crashReportsRequired, isFork, UPSTREAM_REPORTS, type EditionConfig } from '@slicerx/edition-config'
import { appStore, get, set, type AppState } from '../state/store'
import { nativeCrashHost, startCrashCapture, takeOver, type CrashInfo } from './crash'
import { logTail, note, previousLogTail, startLogCapture, unloadedCleanly } from './log'
import { enqueue, flush, supabaseSender, type FlushResult, type SendResult, type Sender } from './outbox'
import { browserFromUserAgent, finishReport, LIMITS, osFromUserAgent, type BugReport, type RawReport } from './report'

export { nativeCrashHost, registerCrashHost, type CrashHost, type NativeCrash, type NativeCrashes } from './crash'

const MAX_CRASHES_PER_SESSION = 5
/** Errors browsers raise that are not crashes of ours. */
const NOISE = /ResizeObserver loop|^Script error\.?$/

interface Context {
  host: Host
  edition: EditionConfig
  os: string
  /** The edition's own backend: manual reports and crash reports go here. */
  sender: Sender | null
  /** SlicerX's, when the edition turned on bugs.upstream: a copy of each crash report, tagged with the edition id. */
  upstream: Sender | null
}

let ctx: Context | null = null
const seen = new Set<string>()
let crashCount = 0
let pageCounted = false

/** Whether automatic crash reports may be sent: always in a pre-alpha build, else the person's setting. */
export function crashReportsOn(): boolean {
  // A fork sends crash reports only to its own backend; without one they are off.
  if (ctx && isFork(ctx.edition) && !ctx.sender && !ctx.upstream) return false
  return Boolean(ctx && crashReportsRequired(ctx.edition)) || get().crashReports
}

/** The install's random id, made on first use and kept in prefs. */
export function installId(): string {
  const have = get().installId
  if (have) return have
  const id = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : fallbackUuid()
  set({ installId: id })
  return id
}

function fallbackUuid(): string {
  const b = new Uint8Array(16)
  crypto.getRandomValues(b)
  b[6] = (b[6]! & 0x0f) | 0x40
  b[8] = (b[8]! & 0x3f) | 0x80
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

function webOs(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent
  const browser = browserFromUserAgent(ua)
  return `${osFromUserAgent(ua)}${browser ? `, ${browser}` : ''}`
}

/** "Bambu Lab A1 mini, firmware 01.04.00.00" for the printer in use, or null without one. */
export async function printerLine(host: Host = ctx?.host as Host): Promise<string | null> {
  const id = get().printerId
  if (!id || !host?.printers) return null
  const within = <T,>(p: Promise<T>) => Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), 1500))]).catch(() => null)
  const [list, status] = await Promise.all([within(host.printers.list()), within(host.printers.status(id))])
  const info = list?.find((p) => p.id === id)
  if (!info && !status) return null
  const model = [info?.vendor, status?.model ?? info?.model].filter(Boolean).join(' ') || 'Unknown printer'
  return `${model}, firmware ${status?.firmware ?? 'not reported'}`
}

/** App version, commit, OS and printer, for the dialog and for crash reports. */
export async function environment(): Promise<Pick<RawReport, 'appVersion' | 'commit' | 'os' | 'printer'>> {
  const host = ctx?.host
  return {
    appVersion: `${host?.build.version ?? 'unknown'}${host?.kind === 'desktop' ? ' desktop' : host?.kind === 'web' ? ' web' : ''}`,
    commit: host?.build.commit ?? 'unknown',
    os: ctx?.os ?? webOs(),
    printer: host ? await printerLine(host) : null,
  }
}

/** SlicerX's endpoint for an edition that opted in. Anonymous: no account token ever goes to SlicerX from an edition. */
function upstreamFor(edition: EditionConfig): Sender | null {
  return edition.bugs.upstream && UPSTREAM_REPORTS ? supabaseSender(UPSTREAM_REPORTS, installId) : null
}

function senderFor(edition: EditionConfig, host: Host): Sender | null {
  const sb = edition.backend.supabase
  if (!sb || edition.features.demoData) return null
  // A signed-in report names the account. The store loads on its own schedule; it is not loaded for this.
  const store = (host as { store?: { getAccessToken(): Promise<string | null> } }).store
  return supabaseSender(sb, installId, async () => (store ? store.getAccessToken() : null))
}

/** Crash reports already copied to SlicerX this session, so a retry to the edition's own backend does not send a second copy. */
const copied = new Set<string>()

/** The crash report as SlicerX gets it: the edition id leads the title and the body, so SlicerX can tell editions apart. */
export function upstreamCopy(report: BugReport, editionId: string): BugReport {
  const title = `[${editionId}] ${report.title}`
  return { ...report, title: title.length > LIMITS.title ? `${title.slice(0, LIMITS.title - 6)} [cut]` : title, body: `Edition: ${editionId}\n${report.body}`.slice(0, LIMITS.body) }
}

/**
 * What the outbox sends through. The edition's own backend takes every report. With bugs.upstream on, each crash
 * report is also copied to SlicerX, once and best effort: a copy that fails is not retried and never holds up the
 * report to the edition's own backend. An edition with no backend of its own sends only that copy.
 */
function outbound(c: Context): Sender | null {
  const { sender, upstream, edition } = c
  if (!upstream) return sender
  return async (report) => {
    if (report.kind !== 'crash') return sender ? sender(report) : { ok: false, retry: false, message: 'This build has no report service configured.' }
    const key = `${report.fingerprint ?? ''}|${report.title}|${report.body}`
    const copy: SendResult = copied.has(key) ? { ok: true, id: '' } : await upstream(upstreamCopy(report, edition.id)).catch((e: unknown): SendResult => ({ ok: false, retry: true, message: String(e) }))
    if (copy.ok) copied.add(key)
    if (sender) return sender(report)
    return copy
  }
}

/** Sends the queue now; queued crash reports wait while crash reports are off. */
export function sendQueued(): Promise<FlushResult> {
  const send = ctx ? outbound(ctx) : null
  if (!send) return Promise.resolve({ sent: 0, kept: 0, dropped: 0 })
  const on = crashReportsOn()
  return flush(send, (r) => (r.kind === 'manual' ? Boolean(ctx?.sender) : on))
}

function messageOf(error: unknown): { title: string; stack: string | null } {
  if (error instanceof Error) {
    const title = `${error.name || 'Error'}: ${error.message}`
    return { title, stack: error.stack ?? null }
  }
  if (typeof error === 'string') return { title: error, stack: null }
  try {
    return { title: `Non-error thrown: ${JSON.stringify(error)}`, stack: null }
  } catch {
    return { title: `Non-error thrown: ${String(error)}`, stack: null }
  }
}

function crashBody(what: string, extra: string[] = []): string {
  const s = get()
  return [what, '', `Workspace: ${s.workspace}`, `Build: ${ctx?.host.kind ?? 'unknown'}`, ...extra].join('\n')
}

async function queueCrash(raw: Omit<RawReport, 'appVersion' | 'commit' | 'os' | 'printer'>): Promise<BugReport | null> {
  if (!crashReportsOn()) return null
  const report = finishReport({ ...raw, ...(await environment()) })
  if (report.fingerprint) {
    if (seen.has(report.fingerprint)) return null
    seen.add(report.fingerprint)
  }
  if (++crashCount > MAX_CRASHES_PER_SESSION) return null
  enqueue(report)
  void sendQueued()
  return report
}

/**
 * Reports a crash: an error nothing handled, or one a boundary caught. `componentStack` is React's, from
 * an error boundary.
 */
export function reportCrash(error: unknown, o: CrashInfo = {}): void {
  if (o.rejection && !(error instanceof Error)) error = messageOf(error).title.replace(/^Non-error thrown: /, 'Unhandled rejection: ')
  const { title, stack } = messageOf(error)
  if (NOISE.test(title.replace(/^Error: /, ''))) return
  const fullStack = [stack, o.componentStack ? `Component stack:${o.componentStack}` : null].filter(Boolean).join('\n\n') || null
  note(`Crash${o.where ? ` (${o.where})` : ''}: ${title}`)
  void queueCrash({ kind: 'crash', title, body: crashBody(o.where ? `Automatic crash report: ${o.where}.` : 'Automatic crash report.'), stack: fullStack, logTail: logTail() }).catch(() => undefined)
}

/** Queues what the shell recorded since the last launch, and a report when the web view reloaded by itself. */
async function takeNative(host: Host, pageLoad: boolean): Promise<void> {
  const crashHost = nativeCrashHost()
  if (!crashHost) return
  const got = await crashHost.take(pageLoad)
  if (ctx) ctx.os = got.os || ctx.os
  const started = typeof performance !== 'undefined' ? performance.timeOrigin : Date.now()
  for (const c of got.reports) {
    // A panic from before this page loaded ended the session whose log was saved; a newer one belongs to this one.
    const earlier = c.at < started
    await queueCrash({
      kind: 'crash',
      title: c.title,
      body: crashBody(c.source === 'panic' ? 'Automatic crash report: the app panicked.' : 'Automatic crash report: the window\'s web content process stopped and the window reloaded.', [`When: ${new Date(c.at).toISOString()}`]),
      stack: c.stack,
      logTail: earlier ? previousLogTail() : logTail(),
    })
  }
  if (got.reports.length) await crashHost.ack(got.reports.map((c) => c.file)).catch(() => undefined)
  // The page loaded again in the same run of the shell, and the dev server's reloads do not count.
  const webviewDied = got.reports.some((c) => c.source === 'webview')
  if (got.pageLoads > 1 && !webviewDied && host.build.commit !== 'dev') {
    const saved = previousLogTail()
    // A page unloads on its own terms for a deliberate reload; a page whose process stopped never gets to. Each has its
    // own title, so the two group apart.
    if (saved && unloadedCleanly(saved)) {
      await queueCrash({ kind: 'crash', title: 'The window was reloaded deliberately', body: crashBody('Automatic report: the page unloaded normally before it loaded again, so this was a deliberate reload (key, menu or script), not a crash. The log is from before the reload.'), stack: null, logTail: saved })
    } else {
      const how = saved ? 'The page did not unload first, so it most likely stopped or hung.' : 'No log was saved before the reload.'
      await queueCrash({ kind: 'crash', title: 'The window reloaded unexpectedly', body: crashBody(`Automatic crash report: the window reloaded by itself. ${how} The log is from before the reload.`), stack: null, logTail: saved })
    }
  }
}

/** Notes in the log what a report should show happened before it: workspace changes and slicing. */
function noteChanges(s: AppState, prev: AppState): void {
  if (s.workspace !== prev.workspace) note(`Workspace: ${s.workspace}`)
  if (s.slice.status === prev.slice.status) return
  const sl = s.slice
  if (sl.status === 'running') note('Slicing started')
  else if (sl.status === 'done') note(`Slicing finished: ${sl.result.layerZ.length} layers`)
  else if (sl.status === 'error') note(`Slicing failed: ${sl.message}`)
}

/**
 * Starts crash capture and sends what is queued. In a pre-alpha build crash reports are locked on.
 * Returns a function that stops listening (tests, hot reload).
 */
export function startBugReports(host: Host, edition: EditionConfig): () => void {
  startLogCapture()
  ctx = { host, edition, os: webOs(), sender: senderFor(edition, host), upstream: upstreamFor(edition) }
  note(`${edition.brand.name} ${host.build.version} (${host.build.commit}, ${host.kind}) started in ${get().workspace}`)
  const offNotes = appStore.subscribe(noteChanges)
  if (crashReportsRequired(edition) && !get().crashReports) set({ crashReports: true })
  installId()
  const onOnline = () => void sendQueued()
  // The error listeners are crash.ts's, from startup; crashes that came before this loaded arrive now.
  const offCapture = startCrashCapture()
  takeOver(reportCrash)
  window.addEventListener('online', onOnline)
  // Once per page: a second start (React's development double mount) must not count as a reload.
  const first = !pageCounted
  pageCounted = true
  void (first ? takeNative(host, true) : Promise.resolve())
    .catch(() => undefined)
    .then(() => sendQueued())
    .catch(() => undefined)
  return () => {
    offNotes()
    takeOver(null)
    offCapture()
    window.removeEventListener('online', onOnline)
  }
}

export type ManualResult = { status: 'sent'; id: string } | { status: 'queued'; reason: string }

/** Sends a manual report now, or queues it when that fails. `report` is the finished one the preview showed. */
export async function sendManual(report: BugReport): Promise<ManualResult> {
  if (!ctx?.sender) {
    enqueue(report)
    return { status: 'queued', reason: 'This build has no report service configured.' }
  }
  const r = await ctx.sender(report).catch((e: unknown) => ({ ok: false as const, retry: true, message: String(e) }))
  if (r.ok) return { status: 'sent', id: r.id }
  if (!r.retry) throw new Error(r.message)
  enqueue(report)
  return { status: 'queued', reason: r.message }
}

/** The developer test: an error nothing catches, which goes through the same path as a real one. */
export function triggerTestCrash(): void {
  // Each test sends, even when one with the same stack went earlier in this session.
  seen.clear()
  crashCount = 0
  setTimeout(() => {
    throw new Error(`Test crash from the developer command at ${new Date().toISOString()}`)
  }, 0)
}

/** The developer test for the shell: a Rust panic, picked up and queued right after. */
export async function triggerTestPanic(): Promise<void> {
  const crashHost = nativeCrashHost()
  if (!crashHost || !ctx) return
  seen.clear()
  crashCount = 0
  // The shell joins the panicking thread, so the report file is there when this returns.
  await crashHost.testPanic()
  await takeNative(ctx.host, false)
  await sendQueued()
}

/** For tests. */
export function resetBugReports(): void {
  ctx = null
  copied.clear()
  seen.clear()
  crashCount = 0
  pageCounted = false
}
