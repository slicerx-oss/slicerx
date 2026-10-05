// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// STEP files for the import path: the bytes go to a worker of their own (step-worker.ts) that meshes
// them with OpenCASCADE, and come back as OBJ for the geometry engine. The worker ends after a failure
// and after a minute without work, which hands its memory back.
import type { StepQuality, StepUnit } from './step-read'

export interface StepConverted {
  base64: string
  notes: string[]
  triangles: number
  toleranceMm: number
  unit: StepUnit | null
}

export type StepConverter = (file: { name: string; data: ArrayBuffer; quality?: StepQuality }) => Promise<StepConverted>

const IDLE_MS = 60_000

let worker: Worker | null = null
let idle: ReturnType<typeof setTimeout> | null = null
let seq = 0
const pending = new Map<number, { resolve: (v: StepConverted) => void; reject: (e: Error) => void }>()

function stop(): void {
  worker?.terminate()
  worker = null
}

function start(): Worker {
  if (idle) clearTimeout(idle)
  idle = null
  if (worker) return worker
  const w = new Worker(new URL('./step-worker.ts', import.meta.url), { type: 'module' })
  w.onmessage = (e: MessageEvent<{ id: number; result?: StepConverted; error?: string }>) => {
    const p = pending.get(e.data.id)
    if (!p) return
    pending.delete(e.data.id)
    if (e.data.error !== undefined) {
      p.reject(new Error(e.data.error))
      if (pending.size === 0) stop()
    } else p.resolve(e.data.result!)
    if (pending.size === 0 && worker) idle = setTimeout(stop, IDLE_MS)
  }
  w.onerror = (e) => {
    for (const p of pending.values()) p.reject(new Error(e.message ? `could not be read: ${e.message}` : 'could not be read: the STEP reader did not start.'))
    pending.clear()
    stop()
  }
  worker = w
  return w
}

/** Meshes a STEP file in the worker. Errors are plain reasons meant to follow the file name. */
export const convertStep: StepConverter = ({ name, data, quality = 'normal' }) =>
  new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    // The bytes are copied so the caller keeps its buffer.
    const copy = data.slice(0)
    start().postMessage({ id, name, data: copy, quality }, [copy])
  })
