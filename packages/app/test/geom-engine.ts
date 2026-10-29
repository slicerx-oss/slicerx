// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The geometry engine for tests of the modeling tools. With a built engine (packages/geom/wasm/pkg/
// sx_geom_wasm.wasm, or SX_GEOM_WASM) calls run in the real wasm; without one they replay replies
// recorded from it in fixtures/<name>.json, keyed by test, so the tests in a file run in any order.
// SX_GEOM_RECORD=1 with a built engine records again. Call `useGeomEngine(name)` at the top of a test file.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { afterAll, afterEach, beforeAll, beforeEach, expect } from 'vitest'
import { setGeomProvider, type GeomProvider } from '../src/geom/client'

export interface Recorded { op: string; request: unknown; reply?: unknown; error?: string }

interface GeomExports {
  memory: WebAssembly.Memory
  geom_input(len: number): number
  geom_call(): number
  geom_out_ptr(): number
  geom_out_len(): number
  geom_error_ptr(): number
  geom_error_len(): number
}

/**
 * Whether the geometry engine module at `path` is built. A test that needs it skips without it, except on CI (CI=true):
 * the web job builds both modules before the tests, so there a missing one fails the file instead of skipping it.
 */
export function wasmBuilt(path: string | URL): boolean {
  if (existsSync(path)) return true
  if (process.env['CI'] === 'true') {
    throw new Error(`CI=true but there is no geometry engine at ${String(path)}: build it with packages/geom/wasm/scripts/build.sh`)
  }
  return false
}

export const wasmPath = process.env['SX_GEOM_WASM'] ?? join(__dirname, '..', '..', 'geom', 'wasm', 'pkg', 'sx_geom_wasm.wasm')
export const liveEngine = wasmBuilt(wasmPath)

/** A provider that calls the wasm module directly, handing each reply to `record`. */
export async function wasmGeom(record?: (r: Recorded) => void) {
  const { instance } = (await WebAssembly.instantiate(readFileSync(wasmPath), {})) as unknown as { instance: WebAssembly.Instance }
  const x = instance.exports as unknown as GeomExports
  const text = (ptr: number, len: number) => new TextDecoder().decode(new Uint8Array(x.memory.buffer, ptr, len))
  return {
    async call<T>(op: string, request: unknown): Promise<T> {
      const req = JSON.parse(JSON.stringify(request)) as unknown
      const bytes = new TextEncoder().encode(`${op}\0${JSON.stringify(req)}`)
      const at = x.geom_input(bytes.length)
      new Uint8Array(x.memory.buffer, at, bytes.length).set(bytes)
      if (x.geom_call() === 0) {
        const reply = JSON.parse(text(x.geom_out_ptr(), x.geom_out_len())) as T
        record?.({ op, request: req, reply })
        return reply
      }
      let message = text(x.geom_error_ptr(), x.geom_error_len())
      try {
        message = (JSON.parse(message) as { error?: string }).error ?? message
      } catch {
        // A plain message stays as it is.
      }
      record?.({ op, request: req, error: message })
      throw new Error(message)
    },
  }
}

const saltless = (r: unknown): unknown => {
  if (r === null || typeof r !== 'object' || Array.isArray(r)) return r
  const { keySalt: _salt, ...rest } = r as Record<string, unknown>
  return rest
}

/**
 * An id the app makes from the time and a counter (`d<time><n>`, `s<time><n>`, `obj_<time>c<n>`). Tests fix the
 * time, but the counter runs on across tests, so one test's ids depend on how many ran before it.
 */
const GENERATED_ID = /^[a-z][a-z_~-]*[0-9a-z]{6,}[a-z~][0-9a-z]+$|^[a-z][a-z_]*[0-9a-z]{7,}$/

/**
 * Walks a recorded request beside the live one and pairs up generated ids that differ only in their counter
 * (same length give or take a digit, same leading characters). Everything else must match exactly.
 */
function pairIds(rec: unknown, now: unknown, ids: Map<string, string>): void {
  if (typeof rec === 'string' && typeof now === 'string' && rec !== now && GENERATED_ID.test(rec) && GENERATED_ID.test(now) && rec.slice(0, 5) === now.slice(0, 5) && Math.abs(rec.length - now.length) <= 1) {
    ids.set(rec, now)
    return
  }
  if (Array.isArray(rec) && Array.isArray(now)) rec.forEach((r, i) => pairIds(r, now[i], ids))
  else if (rec && now && typeof rec === 'object' && typeof now === 'object') for (const k of Object.keys(rec)) pairIds((rec as Record<string, unknown>)[k], (now as Record<string, unknown>)[k], ids)
}

/** `v` with every recorded id swapped for the live one. */
function withIds<T>(v: T, ids: Map<string, string>): T {
  if (!ids.size) return v
  let text = JSON.stringify(v)
  for (const [from, to] of ids) text = text.split(JSON.stringify(from)).join(JSON.stringify(to))
  return JSON.parse(text) as T
}

/** Calls made outside a test (in a beforeAll) are kept under this key. */
const SETUP = '(setup)'
/** The running test's full name ("describe > test"), or SETUP outside a test. */
const testKey = (): string => expect.getState().currentTestName ?? SETUP

/** Recorded replies, by test. Each test replays its own from the start, whatever ran before it. */
export type Replies = Record<string, Recorded[]>

/**
 * A replayed call that the recording does not hold: the request differs, the op differs or the reply is missing. The
 * fixture is out of date. Thrown to the caller like any engine error, and also kept, so the test fails after it even
 * when the code under test catches engine errors and falls back (arrange falls back to its box packer).
 */
export class ReplayMismatch extends Error {
  override name = 'ReplayMismatch'
}

/** The replaying provider over the replies in `file` (or `recorded`); `stale` lists every call that did not match. */
export function replayGeom(file: string, recorded?: Replies) {
  const replies = recorded ?? (existsSync(file) ? (JSON.parse((file.endsWith('.gz') ? gunzipSync(readFileSync(file)) : readFileSync(file)).toString('utf8')) as Replies) : {})
  if (Array.isArray(replies)) throw new Error(`${file} is in the old one list form: record it again with SX_GEOM_RECORD=1`)
  const stale: string[] = []
  let key = SETUP
  let next = 0
  // Recorded ids paired with the ones this run made, for the running test.
  let ids = new Map<string, string>()
  const mismatch = (why: string): never => {
    const message = `${file} is out of date for "${key}": ${why}. Build the engine (packages/geom/wasm/scripts/build.sh) and record it again with SX_GEOM_RECORD=1.`
    stale.push(message)
    throw new ReplayMismatch(message)
  }
  return {
    stale,
    /** Starts the running test's replies at its first one. */
    start(k: string = testKey()): void {
      key = k
      next = 0
      ids = new Map()
    },
    async call<T>(op: string, request: unknown): Promise<T> {
      const r = replies[key]?.[next++]
      if (!r) return mismatch(`no recorded reply for call ${next} (${op})`)
      if (r.op !== op) return mismatch(`call ${next} is ${op}, recorded as ${r.op}`)
      // A step's key salt comes from its id, which has the time in it; the face keys it makes come back in the
      // recorded replies, so the rest of every later request still matches.
      const live = saltless(JSON.parse(JSON.stringify(request)))
      pairIds(saltless(withIds(r.request, ids)), live, ids)
      try {
        expect(saltless(withIds(r.request, ids))).toEqual(live)
      } catch (e) {
        return mismatch(`the ${op} request of call ${next} differs from the recorded one: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`)
      }
      if (r.error !== undefined) throw new Error(r.error)
      return withIds(r.reply, ids) as T
    },
  }
}

/**
 * Installs live wasm or recorded replies; compressed stores large mesh fixtures as gzip. Tests may run in any order.
 * `ops()` lists the ops the running test has called so far, live or replayed, for a test that waits on a call.
 */
export function useGeomEngine(name: string, options: { compressed?: boolean } = {}): { ops(): readonly string[] } {
  const fixture = join(__dirname, 'fixtures', `${name}.json${options.compressed ? '.gz' : ''}`)
  const record = liveEngine && process.env['SX_GEOM_RECORD'] === '1'
  const recorded: Replies = {}
  let replay: ReturnType<typeof replayGeom> | null = null
  let engine: GeomProvider | null = null
  const ops: string[] = []
  // Every call goes through here first, so `ops()` sees it whichever engine answers.
  const provider: GeomProvider = {
    call<T>(op: string, request: unknown, signal?: AbortSignal): Promise<T> {
      ops.push(op)
      return engine!.call<T>(op, request, signal)
    },
  }
  beforeAll(async () => {
    if (liveEngine) {
      engine = await wasmGeom((r) => (recorded[testKey()] ??= []).push(r))
    } else {
      engine = replay = replayGeom(fixture)
    }
    setGeomProvider(provider)
  })
  // Installed again before every test: a test that puts in a stand-in engine of its own and clears it after
  // must not leave the tests that run after it with none.
  beforeEach(() => {
    setGeomProvider(provider)
    ops.length = 0
    replay?.start()
  })
  // A replayed call that did not match fails the test, even when the code under test caught the error and fell back.
  afterEach(() => {
    if (!replay?.stale.length) return
    throw new ReplayMismatch(replay.stale.splice(0).join('\n'))
  })
  afterAll(() => {
    setGeomProvider(null)
    if (record) {
      const json = `${JSON.stringify(recorded)}\n`
      writeFileSync(fixture, options.compressed ? gzipSync(json) : json)
    }
  })
  return { ops: () => ops }
}
