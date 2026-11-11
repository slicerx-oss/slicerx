// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Node geometry host ends a call that runs too long or is canceled, even one stuck in a synchronous engine call,
// and the next call gets a fresh engine. The engine here is a stand-in module made below: an operation whose name
// starts with "b" (build) spins forever, one starting with "t" (trap) traps, one starting with "j" (junk) answers half
// a reply, and every other one answers {"ok":true} at once. A call that traps says why and ends its engine.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CREATIVE_PROMPTS } from '../evals/creative/prompts'
import { runPrompt } from '../evals/creative/run'
import { createGeomWasm, retriesAfterTrap, trapMessage } from '@slicerx/pilot/node'

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
// geom_call traps for "t", for "p" with a panic kept, and for "u" on any call but the module's first (memory[0] counts
// the calls); geom_out_len cuts the reply short for "j".
const PANIC = 'panicked at src/stand_in.rs:7:1:\nno knuckle'
function standInEngine(): string {
  const out = Buffer.from('{"ok":true}')
  const panic = Buffer.from(PANIC)
  const exports: [string, number, number][] = [['memory', 2, 0], ['geom_input', 0, 0], ['geom_call', 0, 1], ['geom_out_ptr', 0, 2], ['geom_out_len', 0, 3], ['geom_error_ptr', 0, 4], ['geom_error_len', 0, 5], ['geom_panic_ptr', 0, 6], ['geom_panic_len', 0, 7]]
  const bytes = [
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, [0x02, 0x60, 0x01, 0x7f, 0x01, 0x7f, 0x60, 0x00, 0x01, 0x7f]),
    ...section(3, [0x08, 0x00, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01]),
    ...section(5, [0x01, 0x00, 0x01]),
    ...section(7, [exports.length, ...exports.flatMap(([n, kind, i]) => [...name(n), kind, i])]),
    ...section(10, [
      0x08,
      // geom_input: memory[0] += 1; the request goes at 64
      ...fn([0x41, 0x00, 0x41, 0x00, 0x2d, 0x00, 0x00, 0x41, 0x01, 0x6a, 0x3a, 0x00, 0x00, 0x41, 0xc0, 0x00, 0x0b]),
      // geom_call: if memory[64] == 'b' then loop forever; if memory[64] == 't' or 'p' then trap; if memory[64] == 'u'
      // and memory[0] > 1 then trap; 0
      ...fn([
        0x41, 0xc0, 0x00, 0x2d, 0x00, 0x00, 0x41, 0xe2, 0x00, 0x46, 0x04, 0x40, 0x03, 0x40, 0x0c, 0x00, 0x0b, 0x0b,
        0x41, 0xc0, 0x00, 0x2d, 0x00, 0x00, 0x41, 0xf4, 0x00, 0x46, 0x04, 0x40, 0x00, 0x0b,
        0x41, 0xc0, 0x00, 0x2d, 0x00, 0x00, 0x41, 0xf0, 0x00, 0x46, 0x04, 0x40, 0x00, 0x0b,
        0x41, 0xc0, 0x00, 0x2d, 0x00, 0x00, 0x41, 0xf5, 0x00, 0x46, 0x41, 0x00, 0x2d, 0x00, 0x00, 0x41, 0x01, 0x4b, 0x71, 0x04, 0x40, 0x00, 0x0b,
        0x41, 0x00, 0x0b,
      ]),
      ...fn([0x41, 0x10, 0x0b]),
      // geom_out_len: 5 when memory[64] == 'j', else the whole reply
      ...fn([0x41, 0xc0, 0x00, 0x2d, 0x00, 0x00, 0x41, 0xea, 0x00, 0x46, 0x04, 0x7f, 0x41, 0x05, 0x05, 0x41, out.length, 0x0b, 0x0b]),
      ...fn([0x41, 0x00, 0x0b]),
      ...fn([0x41, 0x00, 0x0b]),
      // geom_panic_ptr: the kept panic is at 256
      ...fn([0x41, 0x80, 0x02, 0x0b]),
      // geom_panic_len: the panic's length when memory[64] == 'p', else 0
      ...fn([0x41, 0xc0, 0x00, 0x2d, 0x00, 0x00, 0x41, 0xf0, 0x00, 0x46, 0x04, 0x7f, 0x41, panic.length, 0x05, 0x41, 0x00, 0x0b, 0x0b]),
    ]),
    ...section(11, [0x02, 0x00, 0x41, 0x10, 0x0b, out.length, ...out, 0x00, 0x41, 0x80, 0x02, 0x0b, panic.length, ...panic]),
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
    // a loose bound: the worker's start and stop are in it too
    expect(performance.now() - t).toBeLessThan(10_000)
    await expect(geom.run('info', {})).resolves.toEqual({ ok: true })
  })

  it('gives each operation its own limit, and refuses a stuck call with its step and a smaller version to try', async () => {
    const geom = createGeomWasm({ wasm, timeoutMs: (op) => (op === 'build' ? 400 : 60_000) })
    const t = performance.now()
    const stuck = geom.run('build', {})
    const queued = geom.run('info', {})
    await expect(stuck).rejects.toThrow(/^sx-geom build: The step "Build" ran past its 0\.4 s limit and was stopped; try a smaller version: fewer copies or a simpler part$/)
    expect(performance.now() - t).toBeLessThan(10_000)
    await expect(queued).resolves.toEqual({ ok: true })
  })

  it('ends a call stuck in the engine when it is canceled, and a call queued behind it still runs', async () => {
    const geom = createGeomWasm({ wasm })
    const ac = new AbortController()
    const t = performance.now()
    const stuck = geom.run('build', {}, ac.signal)
    const queued = geom.run('info', {})
    setTimeout(() => ac.abort(), 300)
    await expect(stuck).rejects.toThrow(/^sx-geom build: canceled/)
    expect(performance.now() - t).toBeLessThan(10_000)
    await expect(queued).resolves.toEqual({ ok: true })
  })

  it('rejects a queued call canceled before its turn, and the call after it still runs', async () => {
    const geom = createGeomWasm({ wasm })
    const stop = new AbortController()
    const drop = new AbortController()
    const stuck = geom.run('build', {}, stop.signal)
    const queued = geom.run('info', {}, drop.signal)
    const after = geom.run('info', {})
    drop.abort()
    setTimeout(() => stop.abort(), 300)
    await expect(stuck).rejects.toThrow(/^sx-geom build: canceled/)
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' })
    await expect(after).resolves.toEqual({ ok: true })
  })

  it('tries a call that ran out of memory once more on a fresh engine, and says so in its log', async () => {
    const log: string[] = []
    const geom = createGeomWasm({ wasm, log: (line) => log.push(line) })
    await expect(geom.run('info', {})).resolves.toEqual({ ok: true })
    // the stand-in keeps no panic, as when its memory could not grow; its memory is two pages
    await expect(geom.run('unlucky', {})).resolves.toEqual({ ok: true })
    expect(log).toEqual(['sx-geom unlucky: the engine ran out of memory at 0.1 MB; try the step again; trying it once more on a fresh engine'])
  })

  it('says why when the retry runs out of memory too, and the next call gets a fresh engine', async () => {
    const log: string[] = []
    const geom = createGeomWasm({ wasm, log: (line) => log.push(line) })
    await expect(geom.run('trap', {})).rejects.toThrow(/^sx-geom trap: the engine ran out of memory at 0\.1 MB; try the step again$/)
    expect(log).toHaveLength(1)
    await expect(geom.run('info', {})).resolves.toEqual({ ok: true })
  })

  it('names the panic a call stopped on and does not try it again', async () => {
    const log: string[] = []
    const geom = createGeomWasm({ wasm, log: (line) => log.push(line) })
    await expect(geom.run('panic', {})).rejects.toThrow('sx-geom panic: the engine stopped on an internal error: panicked at src/stand_in.rs:7:1: no knuckle')
    expect(log).toEqual([])
    await expect(geom.run('info', {})).resolves.toEqual({ ok: true })
  })

  it('does not try a nest session step again, since its session was in the engine that stopped', () => {
    expect(retriesAfterTrap('nest.step')).toBe(false)
    expect(retriesAfterTrap('nest.end')).toBe(false)
    expect(retriesAfterTrap('nest.start')).toBe(true)
    expect(retriesAfterTrap('shape.extrude')).toBe(true)
  })

  it('names the panic a trap came from when the engine kept one', () => {
    expect(trapMessage('panicked at packages/geom/src/boolean.rs:12:5:\nbad loop', 3_473_408)).toBe('the engine stopped on an internal error: panicked at packages/geom/src/boolean.rs:12:5: bad loop')
    expect(trapMessage('', 3_473_408)).toBe('the engine ran out of memory at 3.3 MB; try the step again')
  })

  it('fails a call whose reply does not read, and the next call still runs', async () => {
    const geom = createGeomWasm({ wasm })
    await expect(geom.run('junk', {})).rejects.toThrow(/^sx-geom junk: unreadable reply$/)
    await expect(geom.run('info', {})).resolves.toEqual({ ok: true })
  })

  it('a creative prompt ends at its own deadline while the engine is stuck, naming the operation', async () => {
    const geom = createGeomWasm({ wasm })
    const p = CREATIVE_PROMPTS.find((x) => x.id === 'cable-organizer')!
    const t = performance.now()
    const run = await runPrompt(p, { geom, timeoutMs: 1000, tabTools: true, answerRecorded: true, steps: [{ calls: [{ name: 'pilot.sheet', args: { title: 'Size', dims: [{ key: 'length', label: 'Length', value: 100, unit: 'mm', source: 'guess' }] } }] }, { calls: [{ name: 'design.new', args: { name: 'Cable organizer' } }] }, { calls: [{ name: 'geom.build', args: { design: 'd1', name: 'base', solids: [{ type: 'box', min: [0, 0, 0], max: [100, 30, 20] }] } }] }, { text: 'Done.' }] })
    expect(performance.now() - t).toBeLessThan(10_000)
    expect(run.parsed.pass).toBe(false)
    expect(`${run.parsed.detail} ${run.error ?? ''}`).toMatch(/build/)
  })

  it('a creative prompt reports a stuck step at its own limit and goes on, without sending it again', async () => {
    const engine = createGeomWasm({ wasm, timeoutMs: (op) => (op === 'build' ? 400 : 60_000) })
    const sent: string[] = []
    const geom = { run: (op: string, input: unknown, signal?: AbortSignal) => (sent.push(op), engine.run(op, input, signal)) }
    const p = CREATIVE_PROMPTS.find((x) => x.id === 'cable-organizer')!
    const t = performance.now()
    const run = await runPrompt(p, { geom, timeoutMs: 60_000, tabTools: true, answerRecorded: true, steps: [{ calls: [{ name: 'pilot.sheet', args: { title: 'Size', dims: [{ key: 'length', label: 'Length', value: 100, unit: 'mm', source: 'guess' }] } }] }, { calls: [{ name: 'design.new', args: { name: 'Cable organizer' } }] }, { calls: [{ name: 'geom.build', args: { design: 'd1', name: 'base', solids: [{ type: 'box', min: [0, 0, 0], max: [100, 30, 20] }] } }] }, { text: 'Done.' }] })
    expect(performance.now() - t).toBeLessThan(10_000)
    // the run itself did not time out: the step was refused, and the reply after it came
    expect(run.error).toBeUndefined()
    expect(run.reply).toContain('Done.')
    expect(sent.filter((op) => op === 'build')).toHaveLength(1)
    expect(`${run.parsed.detail}`).toMatch(/The step "Build" ran past its 0\.4 s limit/)
  })
})
