// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Keeps plates the user sent while offline and submits them, in order, once
// the service is reachable again.
import type { CloudClient, PlateInput } from './client'
import type { KeyValueStore } from './kv'
import { type CloudErrorCode, isRetryable } from './result'
import type { CloudJob } from './schemas'

export interface OutboxEntry {
  id: string
  createdAt: string
  input: PlateInput
  attempts: number
  /** Set when the service refused the plate; the entry is kept for the user and not retried. */
  refused?: { code: CloudErrorCode; message: string }
}

export interface FlushReport {
  sent: { entryId: string; job: CloudJob }[]
  refused: { entryId: string; code: CloudErrorCode; message: string }[]
  /** Entries still waiting for the network. */
  waiting: number
}

export type SubmitOutcome =
  | { kind: 'submitted'; job: CloudJob }
  | { kind: 'queued'; entryId: string }
  | { kind: 'refused'; code: CloudErrorCode; message: string }

export interface JobOutbox {
  /** Submits now, or queues the plate when the service cannot be reached. */
  submit(input: PlateInput): Promise<SubmitOutcome>
  entries(): Promise<OutboxEntry[]>
  remove(entryId: string): Promise<void>
  flush(): Promise<FlushReport>
}

export interface OutboxOptions {
  client: CloudClient
  store: KeyValueStore
  /** Storage key, default `sx-cloud:outbox`. */
  key?: string
  now?: () => Date
}

export function createJobOutbox(opts: OutboxOptions): JobOutbox {
  const key = opts.key ?? 'sx-cloud:outbox'
  const now = opts.now ?? (() => new Date())
  let flushing: Promise<FlushReport> | null = null

  const load = async (): Promise<OutboxEntry[]> => {
    const v = await opts.store.get(key)
    return Array.isArray(v) ? (v as OutboxEntry[]) : []
  }
  const save = (entries: OutboxEntry[]) => opts.store.set(key, entries)

  async function enqueue(input: PlateInput): Promise<string> {
    const entries = await load()
    const id = globalThis.crypto.randomUUID()
    entries.push({ id, createdAt: now().toISOString(), input, attempts: 0 })
    await save(entries)
    return id
  }

  async function doFlush(): Promise<FlushReport> {
    const report: FlushReport = { sent: [], refused: [], waiting: 0 }
    const entries = await load()
    const keep: OutboxEntry[] = []
    let blocked = false
    for (const entry of entries) {
      if (entry.refused || blocked) {
        keep.push(entry)
        if (!entry.refused) report.waiting += 1
        continue
      }
      const res = await opts.client.slicePlate(entry.input)
      if (res.ok) {
        report.sent.push({ entryId: entry.id, job: res.value })
      } else if (isRetryable(res.code)) {
        // Keep order: later plates wait behind this one.
        blocked = true
        keep.push({ ...entry, attempts: entry.attempts + 1 })
        report.waiting += 1
      } else {
        keep.push({ ...entry, attempts: entry.attempts + 1, refused: { code: res.code, message: res.message } })
        report.refused.push({ entryId: entry.id, code: res.code, message: res.message })
      }
    }
    // Plates queued or removed while this flush ran are kept or dropped as the store now says.
    const seen = new Set(entries.map((e) => e.id))
    const latest = await load()
    const present = new Set(latest.map((e) => e.id))
    await save([...keep.filter((e) => present.has(e.id)), ...latest.filter((e) => !seen.has(e.id))])
    return report
  }

  return {
    async submit(input) {
      const pendingBefore = (await load()).some((e) => !e.refused)
      if (!pendingBefore) {
        const res = await opts.client.slicePlate(input)
        if (res.ok) return { kind: 'submitted', job: res.value }
        if (!isRetryable(res.code)) return { kind: 'refused', code: res.code, message: res.message }
      }
      return { kind: 'queued', entryId: await enqueue(input) }
    },

    entries: load,

    async remove(entryId) {
      await save((await load()).filter((e) => e.id !== entryId))
    },

    flush() {
      flushing ??= doFlush().finally(() => {
        flushing = null
      })
      return flushing
    },
  }
}
