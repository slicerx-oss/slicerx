// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The STEP reader's wasm where the host keeps it. The desktop app ships one copy, beside its MCP server, and names it
// with registerStepWasm; the worker then loads that file and no other. Here the worker (step-worker.ts) runs in
// process and reads a fixture with the wasm copied under another name into a stand-in resource folder, refuses when the
// named file is missing (no quiet fallback to a bundled copy), and the import path passes the registered URL to the
// worker once the host answers.
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const reader = join(__dirname, '..', '..', 'step-reader')
const work = mkdtempSync(join(tmpdir(), 'sx-step-wasm-'))
const resources = join(work, 'Resources', 'mcp', 'step-reader')
mkdirSync(resources, { recursive: true })
// Another name than the package's, so a read that works came from this file.
copyFileSync(join(reader, 'src', 'occt-import-js.wasm'), join(resources, 'reader-copy.wasm'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

type Answer = { id: number; result?: { triangles: number; unit: string | null }; error?: string }

/** Loads step-worker.ts as a worker would, with `self` standing in for the worker's global. */
async function worker(): Promise<(msg: Record<string, unknown>) => Promise<Answer>> {
  const answers: Answer[] = []
  const self = { onmessage: null as ((e: { data: unknown }) => Promise<void>) | null, postMessage: (a: Answer) => void answers.push(a) }
  vi.stubGlobal('self', self)
  vi.resetModules()
  await import('../src/state/step-worker')
  return async (msg) => {
    await self.onmessage!({ data: msg })
    return answers.pop()!
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('the STEP worker with the wasm the host names', () => {
  it('reads a file with the wasm from the resource folder', async () => {
    const post = await worker()
    const data = readFileSync(join(reader, 'test', 'fixtures', 'bracket-inch.stp'))
    const a = await post({ id: 1, name: 'bracket-inch.stp', data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), quality: 'normal', wasm: pathToFileURL(join(resources, 'reader-copy.wasm')).href })
    expect(a.error).toBeUndefined()
    expect(a.result?.unit).toBe('inch')
    expect(a.result?.triangles).toBeGreaterThan(0)
  })

  it('refuses when the named wasm is not there, and does not fall back to another copy', async () => {
    const post = await worker()
    const data = readFileSync(join(reader, 'test', 'fixtures', 'bracket-inch.stp'))
    const a = await post({ id: 2, name: 'bracket-inch.stp', data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), quality: 'normal', wasm: pathToFileURL(join(resources, 'missing.wasm')).href })
    expect(a.result).toBeUndefined()
    // Refused for the missing file itself, not for some other failure on the way.
    expect(a.error).toMatch(/missing\.wasm/)
  })
})

class StubWorker {
  static made: StubWorker[] = []
  posted: Record<string, unknown>[] = []
  onmessage: ((e: { data: unknown }) => void) | null = null
  onerror: ((e: { message: string }) => void) | null = null
  constructor() {
    StubWorker.made.push(this)
  }
  postMessage(msg: Record<string, unknown>): void {
    this.posted.push(msg)
    void Promise.resolve().then(() => this.onmessage?.({ data: { id: msg['id'], result: { base64: '', notes: [], triangles: 1, toleranceMm: 0.01, unit: null } } }))
  }
  terminate(): void {}
}

describe('the import path and registerStepWasm', () => {
  beforeEach(() => {
    vi.resetModules()
    StubWorker.made = []
    vi.stubGlobal('Worker', StubWorker)
  })

  it('names no wasm when the host registers none (the web app)', async () => {
    const { convertStep } = await import('../src/state/import-step')
    await convertStep({ name: 'a.step', data: new ArrayBuffer(8) })
    expect(StubWorker.made[0]!.posted[0]).not.toHaveProperty('wasm')
  })

  it("passes the host's URL to the worker, asking the host once", async () => {
    const { convertStep, registerStepWasm } = await import('../src/state/import-step')
    const source = vi.fn(async () => 'asset://localhost/Resources/mcp/step-reader/occt-import-js.wasm')
    registerStepWasm(source)
    await convertStep({ name: 'a.step', data: new ArrayBuffer(8) })
    await convertStep({ name: 'b.step', data: new ArrayBuffer(8) })
    expect(StubWorker.made[0]!.posted.map((m) => m['wasm'])).toEqual(['asset://localhost/Resources/mcp/step-reader/occt-import-js.wasm', 'asset://localhost/Resources/mcp/step-reader/occt-import-js.wasm'])
    expect(source).toHaveBeenCalledTimes(1)
  })

  it('refuses plainly when the host cannot say where the wasm is', async () => {
    const { convertStep, registerStepWasm } = await import('../src/state/import-step')
    registerStepWasm(() => Promise.reject(new Error('no resource folder')))
    await expect(convertStep({ name: 'a.step', data: new ArrayBuffer(8) })).rejects.toThrow('could not be read: the STEP reader did not start.')
    expect(StubWorker.made).toHaveLength(0)
  })
})
