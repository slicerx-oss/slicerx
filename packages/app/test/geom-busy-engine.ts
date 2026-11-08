// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A stand-in for geom-worker.ts in a real thread, with its protocol (worker-loop.ts): a call that can be canceled
// waits for the page's go, the worker says when a call starts, and `array` spins forever, as a join stuck in the
// engine does. Tests of the time limit (geom-client-deadline.test.ts, mimir-geom-deadline.test.ts) use it.
import { Worker as Thread } from 'node:worker_threads'
import { vi } from 'vitest'

const BUSY_ENGINE = `
const { parentPort } = require('node:worker_threads')
const waiting = new Map()
parentPort.on('message', (m) => {
  if ('cancel' in m) return
  if ('skip' in m) return parentPort.postMessage({ id: m.skip, error: 'Canceled' })
  if (m.gate) {
    waiting.set(m.id, m)
    return parentPort.postMessage({ ready: m.id })
  }
  if ('go' in m) m = waiting.get(m.go)
  parentPort.postMessage({ started: m.id })
  if (m.op === 'array') for (;;) {}
  parentPort.postMessage({ id: m.id, result: { op: m.op } })
})
`

export class BusyWorker {
  onmessage: ((e: MessageEvent) => void) | null = null
  onerror: ((e: ErrorEvent) => void) | null = null
  thread = new Thread(BUSY_ENGINE, { eval: true })
  /** the ops sent to this worker */
  ops: string[] = []
  constructor() {
    this.thread.on('message', (data: unknown) => this.onmessage?.({ data } as MessageEvent))
    this.thread.on('error', (e) => this.onerror?.({ message: e.message } as ErrorEvent))
  }
  postMessage(m: { op?: string }) {
    if (m.op !== undefined) this.ops.push(m.op)
    this.thread.postMessage(m)
  }
  terminate() {
    void this.thread.terminate()
  }
}

/** Every worker the app starts is a BusyWorker, listed here; `end` stops their threads. */
export function busyWorkers(): { workers: BusyWorker[]; end: () => Promise<void> } {
  const workers: BusyWorker[] = []
  vi.stubGlobal('Worker', function () {
    const w = new BusyWorker()
    workers.push(w)
    return w
  })
  return { workers, end: async () => void (await Promise.all(workers.map((w) => w.thread.terminate()))) }
}
