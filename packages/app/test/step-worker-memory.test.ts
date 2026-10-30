// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The browser STEP worker (step-worker.ts) runs OpenCASCADE with the same wasm memory cap as the Node path. A file that
// needs more than the cap is refused with a plain reason, not left to grow the tab. The cap itself (2048 MB) is too big
// to reach in a test, so the loader is wrapped to shrink whatever cap the worker asks for; a worker that asks for none
// gets none, and reads the same file.
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, afterEach, expect, it, vi } from 'vitest'

const seen = vi.hoisted(() => ({ caps: [] as (number | undefined)[], wasms: [] as (string | URL | undefined)[] }))
const TEST_CAP_MB = 24

vi.mock('@slicerx/step-reader', async (importOriginal) => {
  const real = await importOriginal<typeof import('@slicerx/step-reader')>()
  return {
    ...real,
    loadOcct: (opts: { maxMemoryMb?: number; wasm?: string | URL } = {}) => {
      seen.caps.push(opts.maxMemoryMb)
      seen.wasms.push(opts.wasm)
      return real.loadOcct(opts.maxMemoryMb === undefined ? opts : { ...opts, maxMemoryMb: TEST_CAP_MB })
    },
  }
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  seen.caps = []
  seen.wasms = []
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

/** Runs the worker on `data`; `wasmUrl` names the wasm as a host does (registerStepWasm), else the build's own file is served. */
async function run(data: Uint8Array, wasmUrl?: string) {
  if (wasmUrl === undefined) {
    // A browser fetches the bundled wasm when it is capped; here the package's file is served for it.
    const wasm = readFileSync(join(__dirname, '..', '..', 'step-reader', 'src', 'occt-import-js.wasm'))
    vi.stubGlobal('fetch', async () => new Response(wasm, { headers: { 'content-type': 'application/wasm' } }))
  }
  const postMessage = vi.fn()
  const worker = { postMessage, onmessage: null as null | ((e: unknown) => Promise<void>) }
  vi.stubGlobal('self', worker)
  await import('../src/state/step-worker')
  const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
  await worker.onmessage!({ data: { id: 1, name: 'big.step', data: buf, quality: 'normal', ...(wasmUrl === undefined ? {} : { wasm: wasmUrl }) } })
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

// The desktop app names its one copy of the wasm, beside its MCP server (registerStepWasm). The cap applies to that
// file too: the worker asks for it with the host's URL, and a file past the cap is refused, read from a stand-in
// resource folder with no fetch stand-in.
const resources = mkdtempSync(join(tmpdir(), 'sx-step-cap-'))
afterAll(() => rmSync(resources, { recursive: true, force: true }))
const folder = join(resources, 'mcp', 'step-reader')
mkdirSync(folder, { recursive: true })
// Another name than the package's, so a read that works came from this file.
copyFileSync(join(__dirname, '..', '..', 'step-reader', 'src', 'occt-import-js.wasm'), join(folder, 'reader-copy.wasm'))
const hostUrl = pathToFileURL(join(folder, 'reader-copy.wasm')).href

it('applies the cap to the wasm the host names', async () => {
  const url = hostUrl
  const { STEP_MAX_MEMORY_MB } = await import('@slicerx/step-reader')
  const reply = await run(padded('assembly.step', 400_000), url)
  expect(seen.wasms).toEqual([url])
  expect(seen.caps).toEqual([STEP_MAX_MEMORY_MB])
  expect(reply.result).toBeUndefined()
  expect(reply.error).toBe('could not be read: it needs more memory than the reader may use.')
})

it('reads a file within the cap with the wasm the host names', async () => {
  const url = hostUrl
  const reply = await run(new Uint8Array(readFileSync(join(fixtures, 'assembly.step'))), url)
  expect(reply.error).toBeUndefined()
  expect(reply.result?.triangles).toBeGreaterThan(0)
  expect(seen.wasms).toEqual([url])
})
