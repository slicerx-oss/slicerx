// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Node geometry host ends a call that runs too long or is canceled, even one stuck in a synchronous engine call,
// and the next call gets a fresh engine. The engine here is a stand-in module made below: any operation whose name
// starts with "b" (build) spins forever, every other one answers {"ok":true} at once.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CREATIVE_PROMPTS } from '../evals/creative/prompts'
import { runPrompt } from '../evals/creative/run'
import { createGeomWasm } from '../src/node/index'

const uleb = (n: number): number[] => {
  const out: number[] = []
  do {
    let b = n & 0x7f
    n >>>= 7
    if (n) b |= 0x80
    out.push(b)
  } while (n)
  return out
}
const section = (id: number, body: number[]): number[] => [id, ...uleb(body.length), ...body]
const name = (s: string): number[] => [...uleb(s.length), ...Buffer.from(s)]
const fn = (code: number[]): number[] => [...uleb(code.length + 1), 0x00, ...code]

/** A module with the sx-geom calling convention whose geom_call loops forever when the op starts with "b". */
function standInEngine(): string {
  const out = Buffer.from('{"ok":true}')
  const exports: [string, number, number][] = [['memory', 2, 0], ['geom_input', 0, 0], ['geom_call', 0, 1], ['geom_out_ptr', 0, 2], ['geom_out_len', 0, 3], ['geom_error_ptr', 0, 4], ['geom_error_len', 0, 5]]
  const bytes = [
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, [0x02, 0x60, 0x01, 0x7f, 0x01, 0x7f, 0x60, 0x00, 0x01, 0x7f]),
    ...section(3, [0x06, 0x00, 0x01, 0x01, 0x01, 0x01, 0x01]),
    ...section(5, [0x01, 0x00, 0x01]),
    ...section(7, [exports.length, ...exports.flatMap(([n, kind, i]) => [...name(n), kind, i])]),
    ...section(10, [
      0x06,
      // geom_input: the request goes at 64
      ...fn([0x41, 0xc0, 0x00, 0x0b]),
      // geom_call: if memory[64] == 'b' then loop forever; 0
      ...fn([0x41, 0xc0, 0x00, 0x2d, 0x00, 0x00, 0x41, 0xe2, 0x00, 0x46, 0x04, 0x40, 0x03, 0x40, 0x0c, 0x00, 0x0b, 0x0b, 0x41, 0x00, 0x0b]),
      ...fn([0x41, 0x10, 0x0b]),
      ...fn([0x41, out.length, 0x0b]),
      ...fn([0x41, 0x00, 0x0b]),
      ...fn([0x41, 0x00, 0x0b]),
    ]),
    ...section(11, [0x01, 0x00, 0x41, 0x10, 0x0b, out.length, ...out]),
  ]
  const file = join(mkdtempSync(join(tmpdir(), 'sx-geom-stand-in-')), 'engine.wasm')
  writeFileSync(file, Buffer.from(bytes))
  return file
}

const wasm = standInEngine()

describe('the Node geometry host', () => {
  it('answers a quick call', async () => {
    const geom = createGeomWasm({ wasm })
    await expect(geom.run('info', {})).resolves.toEqual({ ok: true })
  })

  it('ends a call stuck in the engine at its deadline, and the next call gets a fresh engine', async () => {
    const geom = createGeomWasm({ wasm, timeoutMs: 500 })
    const t = performance.now()
    await expect(geom.run('build', {})).rejects.toThrow(/^sx-geom build: .*0\.5 s/)
    expect(performance.now() - t).toBeLessThan(2500)
    await expect(geom.run('info', {})).resolves.toEqual({ ok: true })
  })

  it('ends a call stuck in the engine when it is canceled, and a call queued behind it still runs', async () => {
    const geom = createGeomWasm({ wasm })
    const ac = new AbortController()
    const t = performance.now()
    const stuck = geom.run('build', {}, ac.signal)
    const queued = geom.run('info', {})
    setTimeout(() => ac.abort(), 300)
    await expect(stuck).rejects.toThrow(/^sx-geom build: canceled/)
    expect(performance.now() - t).toBeLessThan(2500)
    await expect(queued).resolves.toEqual({ ok: true })
  })

  it('a creative prompt ends at its own deadline while the engine is stuck, naming the operation', async () => {
    const geom = createGeomWasm({ wasm })
    const p = CREATIVE_PROMPTS.find((x) => x.id === 'cable-organizer')!
    const t = performance.now()
    const run = await runPrompt(p, { geom, timeoutMs: 1000, steps: [{ calls: [{ name: 'make_model', args: { name: 'Cable organizer', parts: [{ kind: 'box', name: 'base', sizeMm: [100, 30, 20], color: 'blue' }] } }] }, { text: 'Done.' }] })
    expect(performance.now() - t).toBeLessThan(3000)
    expect(run.parsed.pass).toBe(false)
    expect(`${run.parsed.detail} ${run.error ?? ''}`).toMatch(/build/)
  })
})
