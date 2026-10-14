// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { readFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'
import init from '../../brep/lib/sx_brep.mjs'
import type { SxBrepModule } from '../../brep/lib/sx_brep.mjs'
import { brepModule } from '../src/geom/brep'

it.each([
  ['ASCII', () => 'x'.repeat(32 * 1024 * 1024)],
  ['UTF-8', () => '\u00e9'.repeat(17 * 1024 * 1024)],
] as const)('rejects an oversized %s request before allocating in WASM', (_name, text) => {
  const allocate = vi.fn(() => { throw new Error('unexpected allocation') })
  const api = brepModule({ stringToNewUTF8: allocate } as unknown as SxBrepModule)
  expect(() => api.call('count', { x: text() })).toThrow('request: exceeds 32 MiB')
  expect(allocate).not.toHaveBeenCalled()
})

let kernel: Promise<SxBrepModule> | undefined
async function raw(op: string, request: string): Promise<Record<string, unknown>> {
  const m = await (kernel ??= init({ wasmBinary: readFileSync(new URL('../../brep/lib/sx_brep.wasm', import.meta.url)) }))
  const o = m.stringToNewUTF8(op)
  const r = m.stringToNewUTF8(request)
  let p = 0
  try {
    p = m._sx_brep_call(o, r)
    return JSON.parse(m.UTF8ToString(p)) as Record<string, unknown>
  } finally {
    if (p) m._sx_brep_free(p)
    m._free(r)
    m._free(o)
  }
}

it('enforces the byte limit in the real WASM entry point even without the adapter', async () => {
  const allowed = '{}' + ' '.repeat(32 * 1024 * 1024 - 2)
  expect(await raw('count', allowed)).not.toHaveProperty('error')
  expect(await raw('count', allowed + ' ')).toMatchObject({ field: 'request', error: 'request: exceeds 32 MiB' })
})

it('accepts 64 containers but rejects the next before descending in WASM', async () => {
  const nested = (arrays: number) => '{"x":' + '['.repeat(arrays) + '0' + ']'.repeat(arrays) + '}'
  expect(await raw('count', nested(63))).not.toHaveProperty('error')
  expect(await raw('count', nested(64))).toMatchObject({ field: 'request', error: 'request: JSON nesting exceeds 64 containers' })
  expect(await raw('count', JSON.stringify({ x: '['.repeat(128) }))).not.toHaveProperty('error')
})

it('bounds many small JSON values independently of their byte size in WASM', async () => {
  const allowed = '{"x":[' + '0,'.repeat(999_997) + '0]}'
  expect(await raw('count', allowed)).not.toHaveProperty('error')
  expect(await raw('count', allowed.replace(']}', ',0]}'))).toMatchObject({ field: 'request', error: 'request: JSON exceeds 1000000 values' })
})

it('rejects oversized saved text before checksum parsing and still reopens valid solids', async () => {
  expect(await raw('load', JSON.stringify({ body: { smb: 'x'.repeat(8 * 1024 * 1024 + 1) } }))).toMatchObject({ field: 'body', error: 'body: saved body exceeds 8 MiB' })
  const created = await raw('box', JSON.stringify({ min: [0, 0, 0], max: [20, 20, 20], keySalt: 11 }))
  let loaded: unknown
  try {
    const saved = await raw('save', JSON.stringify({ body: created.body }))
    loaded = (await raw('load', JSON.stringify({ body: { smb: saved.smb } }))).body
    expect(typeof loaded).toBe('number')
    expect(await raw('info', JSON.stringify({ body: loaded }))).toMatchObject({ manifold: true, volumeMm3: 8000 })
    const before = await raw('tessellate', JSON.stringify({ body: created.body }))
    const after = await raw('tessellate', JSON.stringify({ body: loaded }))
    const keys = (result: Record<string, unknown>) => (result.faces as { key: number }[]).map((f) => f.key).sort((a, b) => a - b)
    expect(keys(after)).toEqual(keys(before))
  } finally {
    if (typeof loaded === 'number') await raw('free', JSON.stringify({ body: loaded }))
    await raw('free', JSON.stringify({ body: created.body }))
  }
})

it('bounds operation names before allocation and in the raw WASM entry point', async () => {
  const allocate = vi.fn(() => { throw new Error('unexpected allocation') })
  const api = brepModule({ stringToNewUTF8: allocate } as unknown as SxBrepModule)
  for (const name of ['x'.repeat(129), '\u00e9'.repeat(65)]) {
    expect(() => api.call(name, {})).toThrow('op: exceeds 128 bytes')
    expect(await raw(name, '{}')).toMatchObject({ field: 'op', error: 'op: exceeds 128 bytes' })
  }
  expect(allocate).not.toHaveBeenCalled()
})
