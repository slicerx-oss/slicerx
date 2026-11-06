// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The geometry workers alive now and the engine memory each last reported with an answer: the shared worker, the fit
// check's worker and the one-call workers (client.ts, fit-client.ts). A WebAssembly memory only grows, so a worker's
// last report is what it holds until it ends. Read by the agent bridge (app_state.geometry.workers); the app itself
// does not act on it.

/** One live worker: what it is for, its engine memory at its last answer, and when it started and last answered. */
interface Entry {
  kind: string
  memoryBytes: number
  startedAt: number
  answeredAt: number | null
}

const live = new Map<object, Entry>()

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now())

/** A worker started for `kind` (shared, fit, solo, spare). */
export function workerStarted(worker: object, kind: string): void {
  live.set(worker, { kind, memoryBytes: 0, startedAt: now(), answeredAt: null })
}

/** An answer from a worker, with the engine memory it reported (nothing when it sent none). */
export function workerAnswered(worker: object, memoryBytes: number | undefined): void {
  const e = live.get(worker)
  if (!e) return
  if (typeof memoryBytes === 'number') e.memoryBytes = memoryBytes
  e.answeredAt = now()
}

/** A worker ended (terminated); what it held goes with it. */
export function workerEnded(worker: object | null | undefined): void {
  if (worker) live.delete(worker)
}

export interface GeomWorkers {
  /** Workers alive now. */
  live: number
  /** The engine memory they last reported, together. */
  memoryBytes: number
  workers: { kind: string; memoryBytes: number; ageMs: number; idleMs: number | null }[]
}

/** The geometry workers alive now, for the agent bridge. */
export function geomWorkers(): GeomWorkers {
  const t = now()
  const workers = [...live.values()].map((e) => ({ kind: e.kind, memoryBytes: e.memoryBytes, ageMs: Math.round(t - e.startedAt), idleMs: e.answeredAt === null ? null : Math.round(t - e.answeredAt) }))
  return { live: workers.length, memoryBytes: workers.reduce((n, w) => n + w.memoryBytes, 0), workers }
}
