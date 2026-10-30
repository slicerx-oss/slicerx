// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The browser STEP worker (step-worker.ts) runs OpenCASCADE with the same wasm memory cap as the Node path. A file that
// needs more than the cap is refused with a plain reason, not left to grow the tab. The cap itself (2048 MB) is too big
// to reach in a test, so the loader is wrapped to shrink whatever cap the worker asks for; a worker that asks for none
// gets none, and reads the same file.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

const seen = vi.hoisted(() => ({ caps: [] as (number | undefined)[] }))
const TEST_CAP_MB = 24

vi.mock('@slicerx/step-reader', async (importOriginal) => {
  const real = await importOriginal<typeof import('@slicerx/step-reader')>()
  return {
    ...real,
    loadOcct: (opts: { maxMemoryMb?: number } = {}) => {
      seen.caps.push(opts.maxMemoryMb)
      return real.loadOcct(opts.maxMemoryMb === undefined ? opts : { ...opts, maxMemoryMb: TEST_CAP_MB })
    },
  }
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  seen.caps = []
})

const fixtures = join(__dirname, '..', '..', 'step-reader', 'test', 'fixtures')

/** A valid file with `count` unused points added to its data section, so reading it takes far more memory than the file. */
function padded(name: string, count: number): Uint8Array {
  const src = readFileSync(join(fixtures, name), 'latin1')
  const at = src.indexOf('ENDSEC;', src.indexOf('DATA;'))
  let extra = ''
  for (let i = 0; i < count; i++) extra += `#${900000 + i} = CARTESIAN_POINT('',(${i}.,0.,0.));\n`
  return new Uint8Array(Buffer.from(`${src.slice(0, at)}${extra}${src.slice(at)}`, 'latin1'))
}

async function run(data: Uint8Array) {
  // A browser fetches the wasm when it is capped; Node's fetch does not read file: URLs, so serve the file.
  const wasm = readFileSync(join(__dirname, '..', '..', 'step-reader', 'src', 'occt-import-js.wasm'))
  vi.stubGlobal('fetch', async () => new Response(wasm, { headers: { 'content-type': 'application/wasm' } }))
  const postMessage = vi.fn()
  const worker = { postMessage, onmessage: null as null | ((e: unknown) => Promise<void>) }
  vi.stubGlobal('self', worker)
  await import('../src/state/step-worker')
  const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
  await worker.onmessage!({ data: { id: 1, name: 'big.step', data: buf, quality: 'normal' } })
  return postMessage.mock.lastCall![0] as { id: number; error?: string; plain?: boolean; result?: { triangles: number } }
}

it('asks for the same memory cap as the Node path', async () => {
  const { STEP_MAX_MEMORY_MB } = await import('@slicerx/step-reader/node')
  const small = await run(new Uint8Array(readFileSync(join(fixtures, 'assembly.step'))))
  expect(small.result?.triangles).toBeGreaterThan(0)
  expect(STEP_MAX_MEMORY_MB).toBe(2048)
  expect(seen.caps).toEqual([STEP_MAX_MEMORY_MB])
})

it('refuses a file that grows the wasm memory past the cap, with a plain reason', async () => {
  const reply = await run(padded('assembly.step', 400_000))
  expect(reply.result).toBeUndefined()
  expect(reply.plain).toBe(true)
  expect(reply.error).toBe('could not be read: it needs more memory than the reader may use.')
})
