// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ElicitRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { DEFAULT_POLICY } from '@slicerx/contracts'
import { createContext, createSlicerxServer, type ServerContext, type SlicerxMcpOptions } from '../src/index'

/** A closed axis-aligned box as a binary STL, 12 triangles, outward normals. */
export function boxStl(x: number, y: number, z: number): Buffer {
  const v = (i: number): [number, number, number] => [i & 1 ? x : 0, i & 2 ? y : 0, i & 4 ? z : 0]
  const faces: [number, number, number][] = [
    [0, 2, 1], [1, 2, 3], [4, 5, 6], [5, 7, 6],
    [0, 1, 4], [1, 5, 4], [2, 6, 3], [3, 6, 7],
    [0, 4, 2], [2, 4, 6], [1, 3, 5], [3, 7, 5],
  ]
  const buf = Buffer.alloc(84 + faces.length * 50)
  buf.writeUInt32LE(faces.length, 80)
  faces.forEach((f, t) => {
    const o = 84 + t * 50 + 12
    f.forEach((vi, k) => v(vi).forEach((c, j) => buf.writeFloatLE(c, o + k * 12 + j * 4)))
  })
  return buf
}

export interface Harness {
  client: Client
  ctx: ServerContext
  dir: string
  call(name: string, args?: Record<string, unknown>): Promise<CallToolResult>
}

export async function connect(opts: SlicerxMcpOptions = {}, clientOpts: { elicit?: (message: string) => boolean } = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'slicerx-mcp-test-'))
  writeFileSync(join(dir, 'cube.stl'), boxStl(20, 20, 20))
  const ctx = await createContext({ engine: 'stub', allowDirs: [dir], outDir: join(dir, 'out'), profilesDir: join(dir, 'profiles'), policy: DEFAULT_POLICY, ...opts })
  const server = createSlicerxServer(ctx)
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0.0.0' }, clientOpts.elicit ? { capabilities: { elicitation: {} } } : {})
  if (clientOpts.elicit) {
    const answer = clientOpts.elicit
    client.setRequestHandler(ElicitRequestSchema, (req) => {
      const message = 'message' in req.params ? String(req.params.message) : ''
      return { action: 'accept', content: { approve: answer(message) } }
    })
  }
  await Promise.all([server.connect(a), client.connect(b)])
  return {
    client,
    ctx,
    dir,
    call: async (name, args = {}) => (await client.callTool({ name, arguments: args })) as CallToolResult,
  }
}

export function text(r: CallToolResult): string {
  const first = r.content[0]
  return first && first.type === 'text' ? first.text : ''
}

export function data<T = Record<string, unknown>>(r: CallToolResult): T {
  return r.structuredContent as T
}

/**
 * The real core's CLI for the tests that slice with it: SLICERX_TEST_SX_BIN, or a release build
 * (cargo build -p sx-cli --release).
 */
export const sxBin = process.env['SLICERX_TEST_SX_BIN'] ?? resolve(__dirname, '../../../target/release', process.platform === 'win32' ? 'sx.exe' : 'sx')

/**
 * True when there is no sx to run, so the real-core tests skip. CI builds sx and sets SLICERX_TEST_REQUIRE_SX=1,
 * and there a missing binary fails the run instead of skipping it.
 */
/** A real slice takes seconds, more with the debug build CI runs or on a loaded machine, over vitest's 5 s default. */
export const sxTimeout = 60_000

export function noSx(): boolean {
  if (existsSync(sxBin)) return false
  if (process.env['SLICERX_TEST_REQUIRE_SX'] === '1') {
    throw new Error(`SLICERX_TEST_REQUIRE_SX=1 but there is no sx at ${sxBin}: build it (cargo build -p sx-cli) and name it in SLICERX_TEST_SX_BIN`)
  }
  return true
}
