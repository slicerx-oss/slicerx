// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { expect, it, vi } from 'vitest'
import { callEngine, type GeomExports } from '../src/geom/engine-call'
import { exactBuilt, exactKernel, type ExactKernel } from './exact-module'

/** Exports whose every write into the engine fails the test: a refused request never reaches the engine. */
function untouched(): { x: GeomExports; input: ReturnType<typeof vi.fn> } {
  const input = vi.fn(() => { throw new Error('unexpected write into the engine') })
  return { x: { geom_input: input } as unknown as GeomExports, input }
}

it.each([
  ['ASCII', () => 'x'.repeat(32 * 1024 * 1024)],
  ['UTF-8', () => '\u00e9'.repeat(17 * 1024 * 1024)],
] as const)('rejects an oversized %s request before allocating in WASM', (_name, text) => {
  const { x, input } = untouched()
  expect(() => callEngine(x, 'brep.count', { x: text() })).toThrow('request: exceeds 32 MiB')
  expect(input).not.toHaveBeenCalled()
})

let kernel: Promise<ExactKernel> | undefined
/** The request text as it is, straight into the engine's entry point (lib.rs): the reply, or the error's fields. */
async function raw(op: string, request: string): Promise<Record<string, unknown>> {
  const { exports: x } = await (kernel ??= exactKernel())
  const bytes = new TextEncoder().encode(`brep.${op}\0${request}`)
  // the input buffer first: making it may grow the memory
  const at = x.geom_input(bytes.length)
  new Uint8Array(x.memory.buffer).set(bytes, at)
  const ok = x.geom_call() === 0
  const [p, n] = ok ? [x.geom_out_ptr(), x.geom_out_len()] : [x.geom_error_ptr(), x.geom_error_len()]
  return JSON.parse(new TextDecoder().decode(new Uint8Array(x.memory.buffer, p, n))) as Record<string, unknown>
}

it.skipIf(!exactBuilt)('enforces the byte limit in the real WASM entry point even without the adapter', async () => {
  const allowed = '{}' + ' '.repeat(32 * 1024 * 1024 - 2)
  expect(await raw('count', allowed)).not.toHaveProperty('error')
  expect(await raw('count', allowed + ' ')).toMatchObject({ field: 'request', error: 'request: exceeds 32 MiB' })
})

it.skipIf(!exactBuilt)('accepts 64 containers but rejects the next before descending in WASM', async () => {
  const nested = (arrays: number) => '{"x":' + '['.repeat(arrays) + '0' + ']'.repeat(arrays) + '}'
  expect(await raw('count', nested(63))).not.toHaveProperty('error')
  expect(await raw('count', nested(64))).toMatchObject({ field: 'request', error: 'request: JSON nesting exceeds 64 containers' })
  expect(await raw('count', JSON.stringify({ x: '['.repeat(128) }))).not.toHaveProperty('error')
})

it.skipIf(!exactBuilt)('bounds many small JSON values independently of their byte size in WASM', async () => {
  const allowed = '{"x":[' + '0,'.repeat(999_997) + '0]}'
  expect(await raw('count', allowed)).not.toHaveProperty('error')
  expect(await raw('count', allowed.replace(']}', ',0]}'))).toMatchObject({ field: 'request', error: 'request: JSON exceeds 1000000 values' })
})

it.skipIf(!exactBuilt)('rejects oversized saved text before checksum parsing and still reopens valid solids', async () => {
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

it.skipIf(!exactBuilt)('bounds operation names before writing into the engine and in the raw WASM entry point', async () => {
  const { x, input } = untouched()
  for (const name of ['x'.repeat(129), '\u00e9'.repeat(65)]) {
    expect(() => callEngine(x, `brep.${name}`, {})).toThrow('op: exceeds 128 bytes')
    expect(await raw(name, '{}')).toMatchObject({ field: 'op', error: 'op: exceeds 128 bytes' })
  }
  expect(input).not.toHaveBeenCalled()
})
