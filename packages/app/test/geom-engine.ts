// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The geometry engine for tests of the modeling tools. With a built engine (packages/geom/wasm/pkg/
// sx_geom_wasm.wasm, or SX_GEOM_WASM) calls run in the real wasm; without one they replay replies
// recorded from it in fixtures/<name>.json. SX_GEOM_RECORD=1 with a built engine records again.
// Call `useGeomEngine(name)` at the top of a test file.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, expect } from 'vitest'
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

/** A provider that calls the wasm module directly, recording each reply. */
export async function wasmGeom(recorded?: Recorded[]) {
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
        recorded?.push({ op, request: req, reply })
        return reply
      }
      let message = text(x.geom_error_ptr(), x.geom_error_len())
      try {
        message = (JSON.parse(message) as { error?: string }).error ?? message
      } catch {
        // A plain message stays as it is.
      }
      recorded?.push({ op, request: req, error: message })
      throw new Error(message)
    },
  }
}

const saltless = (r: unknown): unknown => {
  if (r === null || typeof r !== 'object' || Array.isArray(r)) return r
  const { keySalt: _salt, ...rest } = r as Record<string, unknown>
  return rest
}

function replayGeom(file: string) {
  const replies = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Recorded[]) : []
  let next = 0
  return {
    async call<T>(op: string, request: unknown): Promise<T> {
      const r = replies[next++]
      if (!r) throw new Error(`no recorded reply for ${op}: build the engine and record with SX_GEOM_RECORD=1`)
      expect(r.op).toBe(op)
      // A step's key salt comes from its id, which has the time in it; the face keys it makes come back in the
      // recorded replies, so the rest of every later request still matches.
      expect(saltless(r.request)).toEqual(saltless(JSON.parse(JSON.stringify(request))))
      if (r.error !== undefined) throw new Error(r.error)
      return r.reply as T
    },
  }
}

/** Installs the engine for this file's tests: live wasm when built, else the recorded replies. Tests must run in order. */
export function useGeomEngine(name: string): void {
  const fixture = join(__dirname, 'fixtures', `${name}.json`)
  const record = liveEngine && process.env['SX_GEOM_RECORD'] === '1'
  const recorded: Recorded[] = []
  beforeAll(async () => {
    setGeomProvider(liveEngine ? await wasmGeom(recorded) : replayGeom(fixture))
  })
  afterAll(() => {
    setGeomProvider(null)
    if (record) writeFileSync(fixture, `${JSON.stringify(recorded)}\n`)
  })
}
