// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// STEP files for the import path: the bytes go to a worker of their own (step-worker.ts) that meshes
// them with OpenCASCADE, and come back as OBJ for the geometry engine. The worker ends after a failure
// and after a minute without work, which hands its memory back.
//
// A read has a deadline and can be canceled from the bar over the plate (step-reading.ts). OpenCASCADE
// has no way to stop part way, so both end the worker itself, and the next STEP file starts a fresh one.
// Every open comes through here: a picked file, a drop, a file the system hands over (a double click, an
// MCP client's open in app) and bytes from the library.
import type { StepQuality, StepUnit } from './step-read'
import { setStepReading } from './step-reading'

export interface StepConverted {
  base64: string
  notes: string[]
  triangles: number
  toleranceMm: number
  unit: StepUnit | null
}

export type StepConverter = (file: { name: string; data: ArrayBuffer; quality?: StepQuality }) => Promise<StepConverted>

const IDLE_MS = 60_000

/**
 * How long a read may take before it is stopped: a minute, plus 2 s per megabyte. The STEP test models mesh in
 * under a second, the largest in 5 s (step-read.ts), so a minute is far past any part we have measured, and the
 * share per megabyte gives a file at the 100 MB limit (STEP_MAX_MB) 4 minutes 20 s. A read still going by then is
 * stuck, not slow, and Cancel is there for anyone who does not want to wait that long.
 */
export const STEP_DEADLINE_MS = 60_000
export const STEP_DEADLINE_PER_MB_MS = 2_000

export function stepDeadlineMs(bytes: number): number {
  return STEP_DEADLINE_MS + Math.ceil(bytes / (1024 * 1024)) * STEP_DEADLINE_PER_MB_MS
}

/** "1 minute", "3 minutes", or seconds under two minutes when they are not whole minutes. */
function spell(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s % 60 === 0) return s === 60 ? '1 minute' : `${s / 60} minutes`
  return s < 120 ? `${s} seconds` : `${Math.round(s / 60)} minutes`
}

/** Why a read was stopped, each meant to follow the file name. */
export const stepCanceledReason = 'was not opened: reading it was canceled.'
export const stepTimedOutReason = (ms: number): string =>
  `took longer than ${spell(ms)} to read, so reading it was stopped. It may be too detailed or damaged. Try exporting it again from your CAD program.`
export const stepBehindReason = 'was not opened: the STEP file before it took too long to read. Open it again.'

interface Pending {
  name: string
  startedAt: number
  timer: ReturnType<typeof setTimeout>
  resolve: (v: StepConverted) => void
  reject: (e: Error) => void
}

let worker: Worker | null = null
let idle: ReturnType<typeof setTimeout> | null = null
let seq = 0
const pending = new Map<number, Pending>()

function stop(): void {
  worker?.terminate()
  worker = null
}

/** The bar names the newest read still waiting, and goes once none is. */
function showReading(): void {
  const last = [...pending.values()].pop()
  setStepReading(last ? { name: last.name, startedAt: last.startedAt } : null, cancelReads)
}

function settle(id: number): Pending | undefined {
  const p = pending.get(id)
  if (!p) return undefined
  pending.delete(id)
  clearTimeout(p.timer)
  showReading()
  return p
}

/** Ends the worker and every read waiting on it, each with its reason. */
function abandon(reason: (id: number) => string): void {
  if (idle) clearTimeout(idle)
  idle = null
  stop()
  for (const id of [...pending.keys()]) settle(id)?.reject(new Error(reason(id)))
}

function cancelReads(): void {
  abandon(() => stepCanceledReason)
}

function start(): Worker {
  if (idle) clearTimeout(idle)
  idle = null
  if (worker) return worker
  const w = new Worker(new URL('./step-worker.ts', import.meta.url), { type: 'module' })
  w.onmessage = (e: MessageEvent<{ id: number; result?: StepConverted; error?: string }>) => {
    const p = settle(e.data.id)
    if (!p) return
    if (e.data.error !== undefined) {
      p.reject(new Error(e.data.error))
      if (pending.size === 0) stop()
    } else p.resolve(e.data.result!)
    if (pending.size === 0 && worker) idle = setTimeout(stop, IDLE_MS)
  }
  w.onerror = (e) => {
    const why = e.message ? `could not be read: ${e.message}` : 'could not be read: the STEP reader did not start.'
    abandon(() => why)
  }
  worker = w
  return w
}

/** Meshes a STEP file in the worker. Errors are plain reasons meant to follow the file name. */
export const convertStep: StepConverter = ({ name, data, quality = 'normal' }) =>
  new Promise((resolve, reject) => {
    const id = ++seq
    const ms = stepDeadlineMs(data.byteLength)
    // The worker reads one file at a time, so a stuck one holds up those behind it, and they go with it.
    const timer = setTimeout(() => abandon((other) => (other === id ? stepTimedOutReason(ms) : stepBehindReason)), ms)
    pending.set(id, { name, startedAt: Date.now(), timer, resolve, reject })
    showReading()
    // The bytes are copied so the caller keeps its buffer.
    const copy = data.slice(0)
    try {
      start().postMessage({ id, name, data: copy, quality }, [copy])
    } catch {
      settle(id)
      stop()
      reject(new Error('could not be read: the STEP reader did not start.'))
    }
  })
