// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The geometry engine for tests of the modeling tools. With a built engine (packages/geom/wasm/pkg/
// sx_geom_wasm.wasm, or SX_GEOM_WASM) calls run in the real wasm; without one they replay replies
// recorded from it in fixtures/<name>.json, keyed by test, so the tests in a file run in any order.
// SX_GEOM_RECORD=1 with a built engine records again. Call `useGeomEngine(name)` at the top of a test file.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync, gzipSync, inflateRawSync } from 'node:zlib'
import { afterAll, afterEach, beforeAll, beforeEach, expect } from 'vitest'
import { clearReplayCache } from '@slicerx/cad-history'
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
 * SX_GEOM_REPLAY=1 takes every module as missing: tests replay their recorded replies and the live ones skip, so the
 * recordings are checked against the code as it is (the replay job in .github/workflows/ci.yml).
 */
export function wasmBuilt(path: string | URL): boolean {
  if (replayOnly()) return false
  if (existsSync(path)) return true
  if (process.env['CI'] === 'true') {
    throw new Error(`CI=true but there is no geometry engine at ${String(path)}: build it with packages/geom/wasm/scripts/build.sh`)
  }
  return false
}

/** Whether this run replays recordings only (SX_GEOM_REPLAY=1), whatever is built. */
export const replayOnly = (): boolean => process.env['SX_GEOM_REPLAY'] === '1'

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
    /** What the module's memory holds, as the app's worker reports it with each answer. */
    memoryBytes: (): number => x.memory.buffer.byteLength,
  }
}

const saltless = (r: unknown): unknown => {
  if (r === null || typeof r !== 'object' || Array.isArray(r)) return r
  const { keySalt: _salt, ...rest } = r as Record<string, unknown>
  return rest
}

/**
 * `v` with every ZIP archive in it (a project file the app wrote, sent as bytes: JSON gives a Uint8Array as an object of
 * index keys) read back into its entries, by name: JSON entries parsed, so their ids pair like any others, the rest as
 * text. Deflate output differs between zlib builds (Node on macOS and on Linux x64 pack the same entries into different
 * bytes), so a recorded archive matches a live one when they hold the same files. Exported for its test.
 */
export function unzipped(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v
  // Number lists (meshes) hold no archive: left as they are, not copied.
  if (Array.isArray(v)) return v.some((x) => x !== null && typeof x === 'object') ? v.map(unzipped) : v
  const o = v as Record<string, unknown>
  if (typeof o['0'] === 'number') {
    // Bytes: an archive when they start with a ZIP local header, else left as they are.
    const entries = o['0'] === 0x50 && o['1'] === 0x4b && o['2'] === 0x03 && o['3'] === 0x04 ? zipEntries(o) : null
    return entries ? { zip: entries } : v
  }
  return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, unzipped(x)]))
}

/** The entries of the archive held in `o` (index keys to bytes), or null when it is not one this can read. */
function zipEntries(o: Record<string, unknown>): Record<string, unknown> | null {
  const n = Object.keys(o).length
  const b = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const x = o[i]
    if (typeof x !== 'number') return null
    b[i] = x
  }
  const view = new DataView(b.buffer)
  let end = n - 22
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--
  if (end < 0) return null
  const out: Record<string, unknown> = {}
  try {
    let at = view.getUint32(end + 16, true)
    for (let i = view.getUint16(end + 10, true); i > 0; i--) {
      if (view.getUint32(at, true) !== 0x02014b50) return null
      const method = view.getUint16(at + 10, true)
      const size = view.getUint32(at + 20, true)
      const nameLen = view.getUint16(at + 28, true)
      const local = view.getUint32(at + 42, true)
      const name = new TextDecoder().decode(b.subarray(at + 46, at + 46 + nameLen))
      const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true)
      const packed = b.subarray(start, start + size)
      if (method !== 0 && method !== 8) return null
      const text = new TextDecoder().decode(method === 8 ? inflateRawSync(packed) : packed)
      try {
        out[name] = JSON.parse(text) as unknown
      } catch {
        out[name] = text
      }
      at += 46 + nameLen + view.getUint16(at + 30, true) + view.getUint16(at + 32, true)
    }
  } catch {
    return null
  }
  return out
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

/** `v` with every recorded id swapped for the live one. Exported for its test. */
export function withIds<T>(v: T, ids: Map<string, string>): T {
  if (!ids.size) return v
  // One pass over the text: ids from different tests run on one counter, so a live id can be another recorded id (recorded
  // ...85 and ...86, live ...86 and ...87), and swapping one id after another would swap the same text twice.
  const quoted = (k: string) => JSON.stringify(k).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const any = new RegExp([...ids.keys()].map(quoted).join('|'), 'g')
  return JSON.parse(JSON.stringify(v).replace(any, (m) => JSON.stringify(ids.get(JSON.parse(m) as string)))) as T
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
    /** The recorded calls of the running test that it has not made yet, as "call N (op)". */
    unused(): string[] {
      return (replies[key] ?? []).slice(next).map((r, i) => `call ${next + i + 1} (${r.op})`)
    },
    /** Starts the running test's replies at its first one. */
    start(k: string = testKey()): void {
      key = k
      next = 0
      ids = new Map()
    },
    async call<T>(op: string, request: unknown): Promise<T> {
      // A step's key salt comes from its id, which has the time in it; the face keys it makes come back in the
      // recorded replies, so the rest of every later request still matches.
      const live = saltless(unzipped(JSON.parse(JSON.stringify(request))))
      /** The ids `r` pairs with when its request is the live one, or null when it is another request. */
      const matches = (r: Recorded): Map<string, string> | null => {
        if (r.op !== op) return null
        const paired = new Map(ids)
        pairIds(saltless(withIds(unzipped(r.request), paired)), live, paired)
        try {
          expect(saltless(withIds(unzipped(r.request), paired))).toEqual(live)
        } catch {
          return null
        }
        return paired
      }
      const r = replies[key]?.[next]
      let paired = r ? matches(r) : null
      next++
      if (!r) return mismatch(`no recorded reply for call ${next} (${op})`)
      if (r.op !== op) return mismatch(`call ${next} is ${op}, recorded as ${r.op}`)
      if (!paired) {
        try {
          expect(saltless(withIds(unzipped(r.request), ids))).toEqual(live)
        } catch (e) {
          return mismatch(`the ${op} request of call ${next} differs from the recorded one: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`)
        }
        paired = ids
      }
      ids = paired
      if (r.error !== undefined) throw new Error(r.error)
      return withIds(r.reply, ids) as T
    },
  }
}

/**
 * Writes `recorded` to `file` (gzip when `compressed`). A run that recorded no call writes nothing, so a test file that
 * makes no engine calls, or shares a fixture with one that does, cannot wipe it. Returns whether it wrote.
 * A project archive in a request is written as its files (`unzipped`), the form a replay compares anyway: its deflated
 * bytes, as an object of index keys, are about twelve times the archive and barely pack, where its files' text packs small.
 */
export function writeRecording(file: string, recorded: Replies, compressed: boolean): boolean {
  if (Object.values(recorded).every((list) => list.length === 0)) return false
  const kept = Object.fromEntries(Object.entries(recorded).map(([k, list]) => [k, list.map((r) => ({ ...r, request: unzipped(r.request) }))]))
  const json = `${JSON.stringify(kept)}\n`
  writeFileSync(file, compressed ? gzipSync(json) : json)
  return true
}

/**
 * Installs live wasm or recorded replies; compressed stores large mesh fixtures as gzip; freshCache starts every test with an
 * empty replay cache. Tests may run in any order.
 * `ops()` lists the ops the running test has called so far, live or replayed, for a test that waits on a call.
 */
export function useGeomEngine(name: string, options: { compressed?: boolean; freshCache?: boolean } = {}): { ops(): readonly string[] } {
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
  // The replay cache (packages/cad-history) outlives a test, and a step it holds makes no engine call. Recorded replies
  // are counted per call, so a test that ran after another one that cached the same steps asked for fewer calls than
  // were recorded and failed, in some orders only. With `freshCache` each test makes every call it needs, live or
  // recorded, and replays only its own list, in order. A file whose recording was made that way needs no option; one
  // recorded with the cache warm and run in the file's order replays as it was recorded.
  beforeEach(() => {
    if (options.freshCache) clearReplayCache()
    setGeomProvider(provider)
    ops.length = 0
    replay?.start()
  })
  // A replayed call that did not match fails the test, even when the code under test caught the error and fell back.
  afterEach(() => {
    if (!replay) return
    if (replay.stale.length) throw new ReplayMismatch(replay.stale.splice(0).join('\n'))
    // With freshCache a test replays its whole list, so a recorded call it did not make means the test dropped a call or
    // the fixture holds one it no longer needs.
    const left = options.freshCache ? replay.unused() : []
    if (left.length) throw new ReplayMismatch(`${fixture} holds recorded calls that "${testKey()}" did not make: ${left.join(', ')}. Record it again with SX_GEOM_RECORD=1.`)
  })
  afterAll(() => {
    setGeomProvider(null)
    if (record) writeRecording(fixture, recorded, !!options.compressed)
  })
  return { ops: () => ops }
}
