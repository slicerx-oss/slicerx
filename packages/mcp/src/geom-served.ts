// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The geometry engine as one process for the whole server: sx-geom started once in serve mode (packages/geom/src/
// serve.rs), kept while the server runs, and sent one call at a time as frames (@slicerx/cad-history/served). Kernel
// bodies then stay in the engine between calls, held by number, so design replays keep them (keepsBodies) as the
// app's native provider does, with no solid text going back and forth. Each body number names the process that made
// it; a process that ends takes its bodies with it, the replay cache lets them go, and a number from it is never sent
// to the next one. An sx-geom with no serve mode (it does not say HELLO) is run once per call, as before.
import { spawn, type ChildProcess } from 'node:child_process'
import { clearReplayCache, type EngineCall } from '@slicerx/cad-history'
import { decodeFrame, encodeFrame, HELLO, ownBodies, plainArrays, readBuffers, tagBodies, takeFrame } from '@slicerx/cad-history/served'
import { ToolInputError } from './models'

/** The design engine of a server: calls, and whether bodies stay in the engine between them. */
export interface DesignEngine extends EngineCall {
  /** True when the engine runs served, so bodies are held by number; false when each call is a process of its own. */
  keepsBodies(): Promise<boolean>
}

export interface ServedOptions {
  /** How long one call may run before its process is ended (default 5 minutes, as a per-call run has). */
  timeoutMs?: number
  /** How long the first look at the binary, and each start, waits for HELLO (default 5 s). */
  helloMs?: number
  /** The call when the binary has no serve mode: today's process per call. */
  perCall: EngineCall
}

interface Job {
  op: string
  request: unknown
  resolve: (v: unknown) => void
  reject: (e: Error) => void
}

const HELLO_BYTES = new TextEncoder().encode(HELLO)

// every served child, so the server's exit ends them even while a call runs
const children = new Set<ChildProcess>()
let hooked = false
function track(child: ChildProcess): void {
  children.add(child)
  child.once('exit', () => children.delete(child))
  if (hooked) return
  hooked = true
  process.once('exit', () => {
    for (const c of children) c.kill('SIGKILL')
  })
}

/** Whether the process and its pipes keep the server running: only while a call waits on it. */
function hold(c: ChildProcess, on: boolean): void {
  for (const h of [c, c.stdin, c.stdout] as ({ ref(): void; unref(): void } | null)[]) {
    if (!h || typeof h.ref !== 'function') continue
    if (on) h.ref()
    else h.unref()
  }
}

const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}

/** The layers of a project's paint buffer, in the engine's order (packages/geom/src/format/json.rs, paint). */
const PAINT_LAYERS = ['color', 'seam', 'support', 'fuzzy'] as const

/**
 * The answer with each paint buffer it names (`{"rawBytes": N}`, a project's paint codes from format.read3mf) read as
 * `{color, seam, support, fuzzy}` lists of [triangle, code] pairs, as the per-call run prints them (sx-geom.rs, paint).
 * Without it a served read3mf handed its parts' paint on as a list of bytes, and every opened design lost its paint.
 */
export function paintCodes(v: unknown, buffers: readonly Uint8Array[]): unknown {
  if (Array.isArray(v)) return v.map((e) => paintCodes(e, buffers))
  if (v === null || typeof v !== 'object') return v
  const o = v as Record<string, unknown>
  const n = o['rawBytes']
  if (typeof n === 'number' && Object.keys(o).length === 1) {
    const b = buffers[n]
    if (!b) throw new Error(`The geometry engine named a buffer it did not send: ${n}`)
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength)
    let at = 0
    const u32 = (): number => {
      const x = at + 4 <= b.byteLength ? view.getUint32(at, true) : 0
      at += 4
      return x
    }
    const text = new TextDecoder()
    const out: Record<string, [number, string][]> = {}
    for (const layer of PAINT_LAYERS) {
      const list: [number, string][] = []
      for (let k = u32(); k > 0; k--) {
        const t = u32()
        const len = u32()
        list.push([t, text.decode(b.subarray(at, at + len))])
        at += len
      }
      out[layer] = list
    }
    return out
  }
  const out: Record<string, unknown> = {}
  for (const [k, e] of Object.entries(o)) out[k] = paintCodes(e, buffers)
  return out
}

/** sx-geom `bin` served for the server, or per call when it has no serve mode. */
export function servedGeomEngine(bin: string, o: ServedOptions): DesignEngine {
  const timeoutMs = o.timeoutMs ?? 5 * 60_000
  const helloMs = o.helloMs ?? 5_000
  // unknown until the first start; a binary that never says HELLO is per call for the server's life
  let mode: 'unknown' | 'served' | 'perCall' = 'unknown'
  let child: ChildProcess | null = null
  let starting: Promise<boolean> | null = null
  // the process that runs now; 0 when none does
  let generation = 0
  let made = 0
  let pending: Uint8Array = new Uint8Array(0)
  let running: (Job & { done: (frame: Uint8Array) => void; fail: (e: Error) => void }) | null = null
  const queue: Job[] = []
  let seq = 0

  // The process went: the bodies the replay cache names are gone with it.
  const ended = (c: ChildProcess) => {
    if (child !== c) return
    child = null
    if (generation) clearReplayCache()
    generation = 0
    const job = running
    running = null
    job?.fail(new Error(`sx-geom ${job.op} ended before it answered (the engine process stopped). Retry the operation.`))
  }

  /** Starts a served process; false when the binary does not serve (no HELLO, or it ends first). */
  const start = (): Promise<boolean> =>
    new Promise((resolve) => {
      const c = spawn(bin, ['serve'], { stdio: ['pipe', 'pipe', 'ignore'] })
      track(c)
      let greeted = false
      pending = new Uint8Array(0)
      const refuse = () => {
        if (greeted) return
        clearTimeout(timer)
        c.kill('SIGKILL')
        resolve(false)
      }
      const timer = setTimeout(refuse, helloMs)
      c.on('error', refuse)
      c.stdin!.on('error', () => {})
      c.on('exit', () => {
        if (!greeted) refuse()
        else ended(c)
      })
      c.stdout!.on('data', (d: Buffer) => {
        pending = concat(pending, new Uint8Array(d))
        if (!greeted) {
          if (pending.length < HELLO_BYTES.length) return
          if (!HELLO_BYTES.every((b, i) => pending[i] === b)) return refuse()
          greeted = true
          clearTimeout(timer)
          pending = pending.subarray(HELLO_BYTES.length)
          child = c
          generation = ++made
          resolve(true)
        }
        for (let f = takeFrame(pending); f; f = takeFrame(pending)) {
          pending = f.rest
          const job = running
          running = null
          job?.done(f.frame.slice())
        }
      })
      // a served process waiting for its next call does not hold the server open
      hold(c, false)
    })

  // Whether the binary serves: `serve` with its input closed at once says HELLO and ends, where an sx-geom with no
  // serve mode reads `serve` as an operation and refuses it. Asked once, before the first start.
  const serves = (): Promise<boolean> =>
    new Promise((resolve) => {
      const c = spawn(bin, ['serve'], { stdio: ['pipe', 'pipe', 'ignore'] })
      track(c)
      let out: Uint8Array = new Uint8Array(0)
      const timer = setTimeout(() => c.kill('SIGKILL'), helloMs)
      c.on('error', () => resolve(false))
      c.stdin!.on('error', () => {})
      c.stdout!.on('data', (d: Buffer) => (out = concat(out, new Uint8Array(d))))
      c.on('close', () => {
        clearTimeout(timer)
        resolve(out.length >= HELLO_BYTES.length && HELLO_BYTES.every((b, i) => out[i] === b))
      })
      c.stdin!.end()
    })

  const ensure = async (): Promise<boolean> => {
    if (child) return true
    if (mode === 'perCall') return false
    if (mode === 'unknown') {
      starting ??= serves().finally(() => (starting = null))
      const ok = await starting
      if (mode === 'unknown') mode = ok ? 'served' : 'perCall'
      if (!ok) return false
    }
    starting ??= start().finally(() => (starting = null))
    return starting
  }

  const answer = (job: Job, frame: Uint8Array, from: number): unknown => {
    const { answer: a, buffers } = decodeFrame(frame)
    if (typeof a['panic'] === 'string') throw new Error(`sx-geom ${job.op} failed: ${a['panic']}`)
    if (typeof a['error'] === 'string') throw new ToolInputError(a['error'])
    // meshes an answer sends as buffers become numbers, as the per-call run prints them
    const result = buffers.length ? plainArrays(readBuffers(paintCodes(a['result'], buffers), buffers)) : a['result']
    if (job.op.startsWith('brep.') && result !== null && typeof result === 'object') tagBodies(result as Record<string, unknown>, from)
    return result
  }

  // one call at a time: set from taking a call off the queue until its answer, so none starts while another waits
  let busy = false
  const next = () => {
    busy = false
    void pump()
  }
  const pump = async (): Promise<void> => {
    if (busy) return
    const job = queue.shift()
    if (!job) return
    busy = true
    if (!(await ensure())) {
      // no serve mode: today's call, a process of its own
      o.perCall(job.op, job.request).then(job.resolve, job.reject)
      return next()
    }
    // a body of a process that ended is gone: the call never goes
    let request = job.request
    if (job.op.startsWith('brep.') && request !== null && typeof request === 'object') {
      const fields = { ...(request as Record<string, unknown>) }
      if (!ownBodies(fields, generation)) {
        if (job.op === 'brep.free') job.resolve({ freed: false })
        else job.reject(new Error(`sx-geom ${job.op} named a body of an engine process that stopped. Retry the operation.`))
        return next()
      }
      request = fields
    }
    const c = child!
    const from = generation
    hold(c, true)
    const timer = setTimeout(() => {
      c.kill('SIGKILL')
    }, timeoutMs)
    const finish = () => {
      clearTimeout(timer)
      hold(c, false)
      next()
    }
    running = {
      ...job,
      done: (frame) => {
        finish()
        try {
          job.resolve(answer(job, frame, from))
        } catch (e) {
          job.reject(e instanceof Error ? e : new Error(String(e)))
        }
      },
      fail: (e) => {
        finish()
        job.reject(c.signalCode === 'SIGKILL' ? Object.assign(new Error(`sx-geom ${job.op} exceeded its execution deadline (${timeoutMs} ms). Retry the operation.`), { name: 'AbortError' }) : e)
      },
    }
    c.stdin!.write(encodeFrame(JSON.stringify({ id: ++seq, op: job.op, request: request ?? null }), []))
  }

  const call = ((op: string, request: unknown) =>
    new Promise((resolve, reject) => {
      queue.push({ op, request, resolve, reject })
      void pump()
    })) as DesignEngine
  call.keepsBodies = async () => mode === 'served' || (mode === 'unknown' && (await ensure()))
  return call
}
