// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Reports wait here until they are sent: offline, with no backend configured, or when the app crashed
// before it could send. The queue lives in local storage and is sent at the next launch, and whenever the
// connection comes back. Reports go in already scrubbed.
import { rpcArgs, type BugReport } from './report'

const KEY = 'slicerx.bugs.outbox.v1'
const MAX_QUEUED = 10
/** Log tails are trimmed in the queue so ten reports stay well inside the storage quota. */
const QUEUED_LOG_CHARS = 64_000
const MAX_ATTEMPTS = 8

export interface Queued {
  id: string
  at: string
  attempts: number
  report: BugReport
}

export type SendResult = { ok: true; id: string } | { ok: false; retry: boolean; message: string }
export type Sender = (r: BugReport) => Promise<SendResult>

function read(): Queued[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown
    return Array.isArray(v) ? (v.filter((q) => q && typeof q === 'object' && 'report' in q && 'id' in q) as Queued[]) : []
  } catch {
    return []
  }
}

function write(q: Queued[]): void {
  try {
    if (q.length) localStorage.setItem(KEY, JSON.stringify(q))
    else localStorage.removeItem(KEY)
  } catch {
    // Storage full or blocked: the report is lost, the app goes on.
  }
}

function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function queued(): Queued[] {
  return read()
}

/** Adds a report; the oldest go when the queue is full. Returns its queue id. */
export function enqueue(report: BugReport): string {
  const trimmed = report.logTail && report.logTail.length > QUEUED_LOG_CHARS ? { ...report, logTail: report.logTail.slice(report.logTail.length - QUEUED_LOG_CHARS) } : report
  const item: Queued = { id: newId(), at: new Date().toISOString(), attempts: 0, report: trimmed }
  write([...read(), item].slice(-MAX_QUEUED))
  return item.id
}

let flushing: Promise<FlushResult> | null = null

export interface FlushResult {
  sent: number
  kept: number
  dropped: number
}

/**
 * Sends what is queued, oldest first. A report the server refuses for good (a bad field) is dropped; one
 * that failed for now (offline, rate limited) stays for the next try, up to eight tries. `keep` says which
 * queued reports may go at all: crash reports stay put while crash reports are off.
 */
export function flush(send: Sender, keep: (r: BugReport) => boolean = () => true): Promise<FlushResult> {
  if (flushing) return flushing
  flushing = (async () => {
    const out: FlushResult = { sent: 0, kept: 0, dropped: 0 }
    for (const item of read()) {
      if (!keep(item.report)) continue
      const r = await send(item.report).catch((e: unknown): SendResult => ({ ok: false, retry: true, message: String(e) }))
      // Re-read each time: a crash may have queued another report meanwhile.
      const now = read()
      if (r.ok || !r.retry || item.attempts + 1 >= MAX_ATTEMPTS) {
        write(now.filter((q) => q.id !== item.id))
        if (r.ok) out.sent++
        else out.dropped++
      } else {
        write(now.map((q) => (q.id === item.id ? { ...q, attempts: q.attempts + 1 } : q)))
        out.kept++
        // Offline or rate limited: the rest would fail the same way.
        break
      }
    }
    return out
  })().finally(() => {
    flushing = null
  })
  return flushing
}

/** Removes one queued report, for example after the dialog sent it directly. */
export function dequeue(id: string): void {
  write(read().filter((q) => q.id !== id))
}

export interface SupabaseTarget {
  url: string
  anonKey: string
}

/**
 * Sends through public.submit_bug_report on the edition's Supabase project. `token` is the signed-in
 * session's access token, so the report names the account; without one it goes anonymously.
 */
export function supabaseSender(target: SupabaseTarget, installId: () => string, token: () => Promise<string | null> = async () => null): Sender {
  const post = async (report: BugReport, session: string | null): Promise<Response> => {
    const headers: Record<string, string> = { apikey: target.anonKey, 'Content-Type': 'application/json' }
    // Publishable keys (sb_publishable_) are not JWTs and go in apikey only.
    if (session) headers['Authorization'] = `Bearer ${session}`
    else if (!target.anonKey.startsWith('sb_')) headers['Authorization'] = `Bearer ${target.anonKey}`
    return fetch(`${target.url.replace(/\/+$/, '')}/rest/v1/rpc/submit_bug_report`, { method: 'POST', headers, body: JSON.stringify(rpcArgs(report, installId())) })
  }
  return async (report) => {
    const session = await token().catch(() => null)
    let res: Response
    try {
      res = await post(report, session)
      // An expired session should not stop the report: send it anonymously instead.
      if (res.status === 401 && session) res = await post(report, null)
    } catch (e) {
      return { ok: false, retry: true, message: e instanceof Error ? e.message : String(e) }
    }
    if (res.ok) {
      const id = (await res.json().catch(() => '')) as unknown
      return { ok: true, id: typeof id === 'string' ? id : '' }
    }
    const err = (await res.json().catch(() => ({}))) as { code?: string; message?: string }
    // Bad fields never pass; everything else (the rate limit, server trouble, a backend not updated yet) may later.
    const permanent = err.code === '22023' || err.code === '22001'
    return { ok: false, retry: !permanent, message: err.message ?? `HTTP ${res.status}` }
  }
}
