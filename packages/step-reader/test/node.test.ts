// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Reading in a Node worker thread, as a server does with files it did not make: the read comes back whole, and broken
// or hostile files end in a StepError with its code (or a plain read), never a crash or a hang of the caller. The
// deadline, the input cap and the memory cap each stop a read on their own.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { readStepFileInWorker, readStepInWorker, StepError, STEP_ERROR_CODES, type StepRead } from '../src/node.ts'

const file = (name: string) => new Uint8Array(readFileSync(join(import.meta.dirname, 'fixtures', name)))
const text = (s: string) => new TextEncoder().encode(s)
const work = mkdtempSync(join(tmpdir(), 'sx-step-node-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

/** The outcome of a read: its object names, or the error's code. */
async function outcome(bytes: Uint8Array, opts: Parameters<typeof readStepInWorker>[1] = {}): Promise<{ code: string; message: string } | { objects: string[] }> {
  try {
    const r: StepRead = await readStepInWorker(bytes, opts)
    return { objects: r.objects.map((o) => o.name) }
  } catch (e) {
    expect(e).toBeInstanceOf(StepError)
    expect(STEP_ERROR_CODES).toContain((e as StepError).code)
    return { code: (e as StepError).code, message: (e as Error).message }
  }
}

const HEADER = "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('x','',(''),(''),'','','');\nFILE_SCHEMA(('AUTOMOTIVE_DESIGN'));\nENDSEC;\nDATA;\n"
const FOOTER = 'ENDSEC;\nEND-ISO-10303-21;\n'

describe('reading in a worker thread', () => {
  it('reads a file the same as in process, typed arrays and all', async () => {
    const r = await readStepInWorker(file('assembly.step'), { name: 'assembly.step' })
    expect(r.objects.map((o) => [o.name, o.bodies.map((b) => b.name)])).toEqual([
      ['assembly', ['base', 'post']],
      ['cube', ['cube']],
    ])
    expect(r.objects[0]!.bodies[0]!.positions).toBeInstanceOf(Float64Array)
    expect(r.objects[0]!.bodies[0]!.indices).toBeInstanceOf(Uint32Array)
    expect(r.triangles).toBe(328)
  })

  it('reads a file from disk and refuses one over the input cap before reading it', async () => {
    const path = join(work, 'bracket.stp')
    writeFileSync(path, file('bracket-inch.stp'))
    expect((await readStepFileInWorker(path, { name: 'bracket.stp' })).unit).toBe('inch')
    await expect(readStepFileInWorker(path, { maxInputMb: 0.01 })).rejects.toMatchObject({ code: 'too_large' })
    await expect(readStepInWorker(new Uint8Array(101 * 1024 * 1024))).rejects.toMatchObject({ code: 'too_large', message: 'is 101 MB. STEP files up to 100 MB can be opened.' })
  })

  it('stops a read at its deadline', async () => {
    expect(await outcome(file('assembly.step'), { timeoutMs: 1 })).toMatchObject({ code: 'timeout' })
  })

  it('stops a read that needs more memory than the cap', async () => {
    expect(await outcome(file('assembly.step'), { maxMemoryMb: 17 })).toMatchObject({ code: 'out_of_memory' })
    // The same file under the default cap reads.
    expect(await outcome(file('assembly.step'), { name: 'assembly.step' })).toEqual({ objects: ['assembly', 'cube'] })
  })
})

describe('broken and hostile files', () => {
  it('garbage after a STEP header', async () => {
    let seed = 7
    const noise = Uint8Array.from({ length: 64 * 1024 }, () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) & 255)
    const bytes = new Uint8Array([...text(HEADER), ...noise, ...text(FOOTER)])
    expect(await outcome(bytes)).toMatchObject({ code: expect.stringMatching(/^(unreadable|no_solids)$/) })
  })

  it('a file cut off part way', async () => {
    const whole = file('assembly.step')
    for (const at of [0.1, 0.5, 0.9]) {
      expect(await outcome(whole.subarray(0, Math.floor(whole.length * at)))).toMatchObject({ code: expect.stringMatching(/^(unreadable|no_solids)$/) })
    }
  })

  it('a huge declared entity number', async () => {
    const bytes = text(`${HEADER}#2147483647=CARTESIAN_POINT('',(0.,0.,0.));\n#999999999999999999=MANIFOLD_SOLID_BREP('',#2147483647);\n${FOOTER}`)
    expect(await outcome(bytes)).toMatchObject({ code: expect.stringMatching(/^(unreadable|no_solids)$/) })
  })

  it('deep nesting', async () => {
    const depth = 200_000
    const bytes = text(`${HEADER}#1=CARTESIAN_POINT('',${'('.repeat(depth)}0.${')'.repeat(depth)});\n#2=MANIFOLD_SOLID_BREP('',#1);\n${FOOTER}`)
    expect(await outcome(bytes)).toMatchObject({ code: expect.stringMatching(/^(unreadable|no_solids)$/) })
  })

  it('a header and nothing else', async () => {
    expect(await outcome(text(HEADER))).toMatchObject({ code: expect.stringMatching(/^(unreadable|no_solids)$/) })
  })
})
