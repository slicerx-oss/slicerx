// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The geometry engine for tests of the modeling tools. With a built engine (packages/geom/wasm/pkg/
// sx_geom_wasm.wasm, or SX_GEOM_WASM) calls run in the real wasm; without one they replay replies
// recorded from it in fixtures/<name>.json, keyed by test, so the tests in a file run in any order.
// SX_GEOM_RECORD=1 with a built engine records again. Call `useGeomEngine(name)` at the top of a test file.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, expect } from 'vitest'
import { setGeomProvider } from '../src/geom/client'

interface Recorded { op: string; request: unknown; reply?: unknown; error?: string }

interface GeomExports {
  memory: WebAssembly.Memory
  geom_input(len: number): number
  geom_call(): number
  geom_out_ptr(): number
  geom_out_len(): number
  geom_error_ptr(): number
  geom_error_len(): number
}

export const wasmPath = process.env['SX_GEOM_WASM'] ?? join(__dirname, '..', '..', 'geom', 'wasm', 'pkg', 'sx_geom_wasm.wasm')
export const liveEngine = existsSync(wasmPath)

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
type Replies = Record<string, Recorded[]>

function replayGeom(file: string) {
  const replies = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Replies) : {}
  if (Array.isArray(replies)) throw new Error(`${file} is in the old one list form: record it again with SX_GEOM_RECORD=1`)
  let key = SETUP
  let next = 0
  // Recorded ids paired with the ones this run made, for the running test.
  let ids = new Map<string, string>()
  return {
    /** Starts the running test's replies at its first one. */
    start(): void {
      key = testKey()
      next = 0
      ids = new Map()
    },
    async call<T>(op: string, request: unknown): Promise<T> {
      const r = replies[key]?.[next++]
      if (!r) throw new Error(`no recorded reply for ${op} in "${key}": build the engine and record with SX_GEOM_RECORD=1`)
      expect(r.op).toBe(op)
      // A step's key salt comes from its id, which has the time in it; the face keys it makes come back in the
      // recorded replies, so the rest of every later request still matches.
      const live = saltless(JSON.parse(JSON.stringify(request)))
      pairIds(saltless(withIds(r.request, ids)), live, ids)
      expect(saltless(withIds(r.request, ids))).toEqual(live)
      if (r.error !== undefined) throw new Error(r.error)
      return withIds(r.reply, ids) as T
    },
  }
}

/** Installs the engine for this file's tests: live wasm when built, else the recorded replies. Tests may run in any order. */
export function useGeomEngine(name: string): void {
  const fixture = join(__dirname, 'fixtures', `${name}.json`)
  const record = liveEngine && process.env['SX_GEOM_RECORD'] === '1'
  const recorded: Replies = {}
  let replay: ReturnType<typeof replayGeom> | null = null
  let provider: Parameters<typeof setGeomProvider>[0] = null
  beforeAll(async () => {
    if (liveEngine) {
      provider = await wasmGeom((r) => (recorded[testKey()] ??= []).push(r))
    } else {
      provider = replay = replayGeom(fixture)
    }
    setGeomProvider(provider)
  })
  // Installed again before every test: a test that puts in a stand-in engine of its own and clears it after
  // must not leave the tests that run after it with none.
  beforeEach(() => {
    setGeomProvider(provider)
    replay?.start()
  })
  afterAll(() => {
    setGeomProvider(null)
    if (record) writeFileSync(fixture, `${JSON.stringify(recorded)}\n`)
  })
}
