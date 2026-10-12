// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The page's side of the project worker (project-worker.ts): started with the first file it reads and ended soon after
// the last, which hands its memory back: after a big project the worker held about 350 MB until it went, and a new one
// starts in a few tens of milliseconds.
import type { ScannedProject } from './project-scan'
import type { ScannedStl } from './stl-scan'
import type { ProjectInput } from './threemf'
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

function ask<T>(message: Record<string, unknown>, transfer: Transferable[]): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve: resolve as (r: unknown) => void, reject })
    try {
      workerFor().postMessage({ id, ...message }, transfer)
    } catch (e) {
      pending.delete(id)
      reject(e instanceof Error ? e : new Error(String(e)))
    }
  })
}

/** An ArrayBuffer (not a shared one, which cannot be handed over), from any realm. */
const isBuffer = (v: unknown): v is ArrayBuffer => Object.prototype.toString.call(v) === '[object ArrayBuffer]'

/** Every buffer under `value` (typed arrays, once each), to hand over with it. */
export function buffersIn(value: unknown): ArrayBuffer[] {
  const out = new Set<ArrayBuffer>()
  const seen = new Set<object>()
  const walk = (v: unknown): void => {
    if (!v || typeof v !== 'object' || seen.has(v)) return
    seen.add(v)
    if (ArrayBuffer.isView(v)) {
      if (isBuffer(v.buffer)) out.add(v.buffer)
      return
    }
    if (isBuffer(v)) return void out.add(v)
    for (const x of v instanceof Map ? v.values() : v instanceof Set ? v.values() : Object.values(v)) walk(x)
  }
  walk(value)
  return [...out]
}

/** Hands the page back to the browser for a moment, so it can draw a frame between two pieces of work. */
function breather(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler
  return scheduler?.yield ? scheduler.yield() : new Promise((r) => setTimeout(r, 0))
}

/** Painted triangles per message: 16,384 of them take the page about 5 ms to send. */
export const PAINT_CHUNK = 16_384

/**
 * Writes a project file (threemf.ts, deflated) in the worker. The page keeps its plates and meshes: the worker gets
 * one copy of them, handed over rather than copied again, and the file comes back handed over. The copy goes over in
 * pieces, with the page free to draw between them: each mesh part, then the painted triangles a few thousand at a
 * time, then the rest of the project. Sent in one go, a plate of 3.4 million triangles with 118,000 painted ones held
 * the page for about 90 ms. Rejects when the project cannot be copied or the worker fails; the caller writes it on the
 * page then.
 */
export async function writeProjectInWorker(input: ProjectInput): Promise<Uint8Array> {
  const id = ++seq
  const done = new Promise<Uint8Array>((resolve, reject) => pending.set(id, { resolve: resolve as (r: unknown) => void, reject }))
  // A failure below rejects here too; the caller hears of it from the throw.
  done.catch(() => undefined)
  const send = (message: Record<string, unknown>, transfer: Transferable[] = []): void => {
    // The worker failed while the page was away: the pieces sent so far went with it.
    if (!pending.has(id)) throw new Error('The project writer stopped.')
    workerFor().postMessage({ id, ...message }, transfer)
  }
  try {
    for (const [i, plate] of input.plates.entries()) {
      for (const [j, object] of plate.objects.entries()) {
        for (const [k, part] of object.parts.entries()) {
          await breather()
          const copy = structuredClone(part)
          send({ part: { at: [i, j, k], part: copy } }, buffersIn(copy))
        }
        for (const [part, layers] of Object.entries(object.paint ?? {})) {
          for (const [layer, codes] of Object.entries(layers ?? {})) {
            let chunk: Record<string, string> = {}
            let n = 0
            const flush = async (): Promise<void> => {
              await breather()
              send({ paint: { at: [i, j], part, layer, codes: chunk } })
              chunk = {}
              n = 0
            }
            for (const t in codes) {
              chunk[t] = codes[t as unknown as number]!
              if (++n === PAINT_CHUNK) await flush()
            }
            if (n > 0) await flush()
          }
        }
      }
    }
    await breather()
    // The rest of the project, with a gap for each part and an empty record for each paint layer, which the worker
    // fills from the pieces it was sent.
    const rest = {
      ...input,
      plates: input.plates.map((p) => ({
        ...p,
        objects: p.objects.map((o) => ({
          ...o,
          parts: o.parts.map(() => null),
          ...(o.paint ? { paint: Object.fromEntries(Object.entries(o.paint).map(([part, layers]) => [part, Object.fromEntries(Object.keys(layers ?? {}).map((l) => [l, {}]))])) } : {}),
        })),
      })),
    }
    const copy = structuredClone(rest)
    send({ write: copy }, buffersIn(copy))
  } catch (e) {
    pending.delete(id)
    worker?.postMessage({ id, drop: true })
    if (pending.size === 0 && worker) idle = setTimeout(stop, IDLE_MS)
    throw e instanceof Error ? e : new Error(String(e))
  }
  return done
}

/** Inflates and scans a 3MF project in the worker. The caller keeps its bytes (the worker gets a copy). */
export function scanProjectInWorker(bytes: Uint8Array): Promise<ScannedProject> {
  const copy = bytes.slice().buffer
  return ask<ScannedProject>({ data: copy }, [copy])
}

/** Reads a binary STL in the worker (stl-scan.ts); null when it is not one. The caller keeps its bytes. */
export function scanStlInWorker(bytes: Uint8Array): Promise<ScannedStl | null> {
  const copy = bytes.slice().buffer
  return ask<ScannedStl | null>({ stl: copy }, [copy])
}
