// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The engine for design tests. With a built engine (packages/geom/wasm/pkg/sx_geom_wasm.wasm, or SX_GEOM_WASM) calls
// run in the real wasm, the build the app loads; without one they replay replies recorded from it in
// fixtures/<name>.json.gz (gzipped: meshes compress about 4 to 1), keyed by test, so the tests run anywhere. SX_GEOM_RECORD=1 with a built engine records again.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import type { EngineCall } from '@slicerx/cad-history'
import { afterAll, beforeAll, beforeEach, expect } from 'vitest'

interface Recorded {
  op: string
  /** A hash of the request without its key salt; requests carry whole meshes, so the file keeps only this. */
  request: string
  reply?: unknown
  error?: string
}

interface GeomExports {
  memory: WebAssembly.Memory
  geom_input(len: number): number
  geom_call(): number
  geom_out_ptr(): number
  geom_out_len(): number
  geom_error_ptr(): number
  geom_error_len(): number
}

const wasmPath = process.env['SX_GEOM_WASM'] ?? join(__dirname, '..', '..', 'geom', 'wasm', 'pkg', 'sx_geom_wasm.wasm')
export const liveEngine = existsSync(wasmPath)

async function wasmEngine(record: (r: Recorded) => void): Promise<EngineCall> {
  const { instance } = (await WebAssembly.instantiate(readFileSync(wasmPath), {})) as unknown as { instance: WebAssembly.Instance }
  const x = instance.exports as unknown as GeomExports
  const text = (ptr: number, len: number): string => new TextDecoder().decode(new Uint8Array(x.memory.buffer, ptr, len))
  return async (op, request) => {
    const req = JSON.parse(JSON.stringify(request)) as unknown
    const bytes = new TextEncoder().encode(`${op}\0${JSON.stringify(req)}`)
    const at = x.geom_input(bytes.length)
    new Uint8Array(x.memory.buffer, at, bytes.length).set(bytes)
    if (x.geom_call() === 0) {
      const reply = JSON.parse(text(x.geom_out_ptr(), x.geom_out_len())) as unknown
      record({ op, request: digest(req), reply })
      return reply
    }
    let message = text(x.geom_error_ptr(), x.geom_error_len())
    try {
      message = (JSON.parse(message) as { error?: string }).error ?? message
    } catch {
      // A plain message stays as it is.
    }
    record({ op, request: digest(req), error: message })
    throw new Error(message)
  }
}

// A step's key salt comes from its id, which has the time in it; the face keys it makes come back in the recorded
// replies, so every later request still matches.
const saltless = (r: unknown): unknown => {
  if (r === null || typeof r !== 'object' || Array.isArray(r)) return r
  const { keySalt: _salt, ...rest } = r as Record<string, unknown>
  return rest
}

const digest = (r: unknown): string => createHash('sha256').update(JSON.stringify(saltless(JSON.parse(JSON.stringify(r))))).digest('hex').slice(0, 16)

const SETUP = '(setup)'
const testKey = (): string => expect.getState().currentTestName ?? SETUP

/**
 * The engine for this file's tests, live when built, else the recorded replies. Read `engine` inside a test or
 * a hook: it is set in beforeAll.
 */
export function useGeomEngine(name: string): { engine: EngineCall } {
  const fixture = join(__dirname, 'fixtures', `${name}.json.gz`)
  const record = liveEngine && process.env['SX_GEOM_RECORD'] === '1'
  const recorded: Record<string, Recorded[]> = {}
  const replies: Record<string, Recorded[]> = !liveEngine && existsSync(fixture) ? (JSON.parse(gunzipSync(readFileSync(fixture)).toString('utf8')) as Record<string, Recorded[]>) : {}
  let key = SETUP
  let next = 0
  const out: { engine: EngineCall } = { engine: () => Promise.reject(new Error('the engine is set in beforeAll')) }
  beforeAll(async () => {
    if (liveEngine) out.engine = await wasmEngine((r) => (recorded[testKey()] ??= []).push(r))
    else
      out.engine = async (op, request) => {
        const r = replies[key]?.[next++]
        if (!r) throw new Error(`no recorded reply for ${op} in "${key}": build the engine (packages/geom/wasm/scripts/build.sh) and record with SX_GEOM_RECORD=1`)
        expect(r.op).toBe(op)
        expect(digest(request), `${op}: the request differs from the recorded one`).toBe(r.request)
        if (r.error !== undefined) throw new Error(r.error)
        return r.reply
      }
  })
  beforeEach(() => {
    key = testKey()
    next = 0
  })
  afterAll(() => {
    if (!record) return
    mkdirSync(dirname(fixture), { recursive: true })
    writeFileSync(fixture, gzipSync(`${JSON.stringify(recorded)}\n`, { level: 9 }))
  })
  return out
}
