// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A file of several separate bodies, added the way a client adds it: the server over stdio, slicerx_project_add_model
// with bodies auto, parts or objects, then the answer and slicerx_project_show read back the objects and their parts.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { splitBodies } from '../src/mesh'
import { data } from './helpers'

type Out<T> = { ok: boolean; summary: string; output: T }
type Added = { object_count: number; part_count: number; objects: { id: string; name: string; parts: number }[] }
type Shown = { objects: { id: string; name: string; parts: number }[] }

/** A binary STL of boxes, each `[x0, size]` along X from the origin; `inward` flips a box's faces (a cavity). */
function boxesStl(boxes: { x0: number; size: number; inward?: boolean; y0?: number; z0?: number }[]): Buffer {
  const faces: [number, number, number][] = [
    [0, 2, 1], [1, 2, 3], [4, 5, 6], [5, 7, 6],
    [0, 1, 4], [1, 5, 4], [2, 6, 3], [3, 6, 7],
    [0, 4, 2], [2, 4, 6], [1, 3, 5], [3, 7, 5],
  ]
  const tris: number[][] = []
  for (const b of boxes) {
    const v = (i: number) => [b.x0 + (i & 1 ? b.size : 0), (b.y0 ?? 0) + (i & 2 ? b.size : 0), (b.z0 ?? 0) + (i & 4 ? b.size : 0)]
    for (const [a, c, d] of faces) tris.push(b.inward ? [...v(a), ...v(d), ...v(c)] : [...v(a), ...v(c), ...v(d)])
  }
  const buf = Buffer.alloc(84 + tris.length * 50)
  buf.writeUInt32LE(tris.length, 80)
  tris.forEach((t, i) => t.forEach((n, k) => buf.writeFloatLE(n, 84 + i * 50 + 12 + k * 4)))
  return buf
}

const soup = (buf: Buffer) => {
  const n = buf.readUInt32LE(80)
  const out = new Float32Array(n * 9)
  for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) out[t * 9 + k] = buf.readFloatLE(84 + t * 50 + 12 + k * 4)
  return out
}

describe('splitBodies', () => {
  it('finds each separate body, and keeps a cavity with the body around it', () => {
    expect(splitBodies(soup(boxesStl([{ x0: 0, size: 20 }, { x0: 50, size: 20 }, { x0: 100, size: 10 }])))).toHaveLength(3)
    expect(splitBodies(soup(boxesStl([{ x0: 0, size: 20 }])))).toHaveLength(1)
    const hollow = splitBodies(soup(boxesStl([{ x0: 0, size: 20 }, { x0: 5, y0: 5, z0: 5, size: 10, inward: true }])))
    expect(hollow).toHaveLength(1)
    expect(hollow[0]!.length).toBe(24 * 9)
  })
})

describe('slicerx_project_add_model with several bodies, over stdio', () => {
  let client: Client
  let dir: string
  const call = async <T,>(name: string, args: Record<string, unknown> = {}) => data<Out<T>>((await client.callTool({ name, arguments: args })) as CallToolResult)
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'slicerx-mcp-bodies-'))
    writeFileSync(join(dir, 'three.stl'), boxesStl([{ x0: 0, size: 20 }, { x0: 50, size: 20 }, { x0: 100, size: 10 }]))
    writeFileSync(join(dir, 'one.stl'), boxesStl([{ x0: 0, size: 20 }]))
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', 'src/cli.ts', '--engine', 'stub', '--allow-dir', dir, '--out-dir', join(dir, 'out'), '--profiles-dir', join(dir, 'profiles'), '--printers', 'demo', '--no-urls'],
      cwd: resolve(__dirname, '..'),
      stderr: 'ignore',
    })
    client = new Client({ name: 'bodies-test', version: '0.0.0' })
    await client.connect(transport)
    expect((await call('slicerx_project_open', { printer: 'Bambu Lab A1', filament: 'Bambu PLA Basic' })).ok).toBe(true)
  }, 60_000)
  afterAll(async () => {
    await client?.close()
  })

  it('loads one object by default, as before', async () => {
    const r = await call<Added>('slicerx_project_add_model', { model: join(dir, 'three.stl') })
    expect(r.ok).toBe(true)
    expect(r.output).toMatchObject({ object_count: 1, part_count: 1 })
  }, 60_000)

  it('keeps the bodies as parts of one object, and an object per body, and reads both back', async () => {
    const parts = await call<Added>('slicerx_project_add_model', { model: join(dir, 'three.stl'), bodies: 'parts' })
    expect(parts.output).toMatchObject({ object_count: 1, part_count: 3 })
    const objects = await call<Added>('slicerx_project_add_model', { model: join(dir, 'three.stl'), bodies: 'objects' })
    expect(objects.output).toMatchObject({ object_count: 3, part_count: 3 })
    expect(objects.output.objects.map((o) => o.name)).toEqual(['three 1', 'three 2', 'three 3'])
    const shown = await call<Shown>('slicerx_project_show')
    expect(shown.output.objects.find((o) => o.id === parts.output.objects[0]!.id)?.parts).toBe(3)
    for (const o of objects.output.objects) expect(shown.output.objects.find((x) => x.id === o.id)?.parts).toBe(1)
  }, 60_000)

  it('loads a file of one body as one object whatever it asks for', async () => {
    const r = await call<Added>('slicerx_project_add_model', { model: join(dir, 'one.stl'), bodies: 'objects' })
    expect(r.output).toMatchObject({ object_count: 1, part_count: 1 })
  }, 60_000)
})
