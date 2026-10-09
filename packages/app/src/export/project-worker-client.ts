// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The page's side of the project worker (project-worker.ts): started with the first file it reads and ended soon after
// the last, which hands its memory back: after a big project the worker held about 350 MB until it went, and a new one
// starts in a few tens of milliseconds.
import type { ScannedProject } from './project-scan'
import type { ScannedStl } from './stl-scan'
import { ProjectReadError } from './unzip'

const IDLE_MS = 2_000

let worker: Worker | null = null
let idle: ReturnType<typeof setTimeout> | null = null
let seq = 0
const pending = new Map<number, { resolve: (r: unknown) => void; reject: (e: Error) => void }>()

function stop(): void {
  worker?.terminate()
  worker = null
}

function workerFor(): Worker {
  if (idle) clearTimeout(idle)
  idle = null
  if (worker) return worker
  const w = new Worker(new URL('./project-worker.ts', import.meta.url), { type: 'module' })
  w.onmessage = (e: MessageEvent<{ id: number; result?: unknown; error?: string; plain?: boolean }>) => {
    const p = pending.get(e.data.id)
    if (!p) return
    pending.delete(e.data.id)
    if ('result' in e.data) p.resolve(e.data.result)
    else p.reject(e.data.plain ? new ProjectReadError(e.data.error ?? '') : new Error(e.data.error ?? 'The file could not be read.'))
    if (pending.size === 0 && worker) idle = setTimeout(stop, IDLE_MS)
  }
  w.onerror = (e) => {
    for (const p of pending.values()) p.reject(new Error(e.message || 'The file reader did not start.'))
    pending.clear()
    stop()
  }
  worker = w
  return w
}

function ask<T>(message: Record<string, unknown>, buffer: ArrayBuffer): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve: resolve as (r: unknown) => void, reject })
    workerFor().postMessage({ id, ...message }, [buffer])
  })
}

/** Inflates and scans a 3MF project in the worker. The caller keeps its bytes (the worker gets a copy). */
export function scanProjectInWorker(bytes: Uint8Array): Promise<ScannedProject> {
  const copy = bytes.slice().buffer
  return ask<ScannedProject>({ data: copy }, copy)
}

/** Reads a binary STL in the worker (stl-scan.ts); null when it is not one. The caller keeps its bytes. */
export function scanStlInWorker(bytes: Uint8Array): Promise<ScannedStl | null> {
  const copy = bytes.slice().buffer
  return ask<ScannedStl | null>({ stl: copy }, copy)
}
