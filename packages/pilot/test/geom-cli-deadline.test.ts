// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The sx-geom command host (createGeomCli, the one the MCP server uses) stops a call at its time limit, by default its
// operation's class limit (@slicerx/contracts geom-limits.ts), and refuses it with the step's name and what to try.
// The command here is a stand-in script run by this Node: `array` and `measure` never answer, any other operation
// answers at once, and each run writes its operation to ops.log beside it.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGeomCli } from '../src/node'

const STAND_IN = `
const fs = require('node:fs')
const path = require('node:path')
const op = process.argv[2]
fs.appendFileSync(path.join(__dirname, 'ops.log'), op + '\\n')
if (op === 'array' || op === 'measure') setInterval(() => {}, 1000)
else {
  let input = ''
  process.stdin.on('data', (d) => (input += d))
  process.stdin.on('end', () => process.stdout.write(JSON.stringify({ ok: true, op })))
}
`

function standIn(): { args: string[]; ops: () => string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'sx-geom-cli-stand-in-'))
  const script = join(dir, 'sx-geom.cjs')
  writeFileSync(script, STAND_IN)
  writeFileSync(join(dir, 'ops.log'), '')
  return { args: [script], ops: () => readFileSync(join(dir, 'ops.log'), 'utf8').split('\n').filter(Boolean) }
}

const settled = <T,>(p: Promise<T>) => {
  const s = { done: false }
  p.then(
    () => (s.done = true),
    () => (s.done = true),
  )
  return s
}

/** Waits for `ready` on real turns of the event loop, which fake timers leave alone. */
const until = async (ready: () => boolean) => {
  for (let i = 0; i < 200_000 && !ready(); i++) await new Promise((r) => setImmediate(r))
}

afterEach(() => {
  vi.useRealTimers()
})

describe('the sx-geom command host', () => {
  it('stops a stuck call at its limit, refuses it with its step and a smaller version, and runs the next call', async () => {
    const e = standIn()
    const geom = createGeomCli({ binary: process.execPath, args: e.args, timeoutMs: (op) => (op === 'array' ? 400 : 60_000) })
    const t = performance.now()
    await expect(geom.run('array', { merge: true })).rejects.toThrow(/^sx-geom array: The step "Array" ran past its 0\.4 s limit and was stopped; try a smaller version: fewer copies or a simpler part$/)
    expect(performance.now() - t).toBeLessThan(10_000)
    await expect(geom.run('info', {})).resolves.toEqual({ ok: true, op: 'info' })
    // the stopped call ran once
    expect(e.ops()).toEqual(['array', 'info'])
  })

  it('takes each operation class limit by default', async () => {
    const e = standIn()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const geom = createGeomCli({ binary: process.execPath, args: e.args })
    const measure = geom.run('measure', {})
    const m = settled(measure)
    await until(() => e.ops().length === 1)
    vi.advanceTimersByTime(29_999)
    await new Promise((r) => setImmediate(r))
    expect(m.done).toBe(false)
    vi.advanceTimersByTime(1)
    await expect(measure).rejects.toThrow('sx-geom measure: The step "Measure" took too long (over its 30 s limit) and was stopped; try it again')
    const array = geom.run('array', {})
    const a = settled(array)
    await until(() => e.ops().length === 2)
    vi.advanceTimersByTime(179_999)
    await new Promise((r) => setImmediate(r))
    expect(a.done).toBe(false)
    vi.advanceTimersByTime(1)
    await expect(array).rejects.toThrow('sx-geom array: The step "Array" ran past its 3 min limit and was stopped; try a smaller version: fewer copies or a simpler part')
  })
})
