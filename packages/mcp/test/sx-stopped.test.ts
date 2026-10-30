// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A slice whose sx process ends without an exit code: the time limit stopped it, or another signal did.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SliceJob } from '../src/slicer'
import { createSxSlicer, formatLimit, runSx, sxStopped } from '../src/sx'

let dir: string
let pidFile: string
const savedOptions = process.env['NODE_OPTIONS']

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sx-stopped-'))
  pidFile = join(dir, 'pid')
})

afterEach(() => {
  if (savedOptions === undefined) delete process.env['NODE_OPTIONS']
  else process.env['NODE_OPTIONS'] = savedOptions
  // Never leave a fake engine behind: stop the one this test started, by its recorded pid.
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, 'utf8'))
    if (alive(pid)) process.kill(pid, 'SIGKILL')
  }
  rmSync(dir, { recursive: true, force: true })
})

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * A fake engine: Node.js running `body` first, which records its pid and then says so with one line on stdout, so a
 * test can wait for the pid before it stops the fake. It sleeps without spinning the CPU.
 */
function fake(body: string): string {
  const file = join(dir, 'fake-sx.cjs')
  writeFileSync(file, `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nrequire('node:fs').writeSync(1, 'started\\n');\nconst sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);\n${body}\n`)
  return file
}

/**
 * Slices with Node.js as sx. The fake loads first through NODE_OPTIONS, so sx's own arguments (`slice --request ...`)
 * reach a process that never gets as far as reading them.
 */
function sliceWith(file: string, timeoutMs: number): Promise<unknown> {
  // NODE_OPTIONS reads a backslash in quotes as an escape, so a Windows path goes in with forward slashes.
  process.env['NODE_OPTIONS'] = `--require "${file.replaceAll('\\', '/')}"`
  const job: SliceJob = {
    modelPath: join(dir, 'cube.stl'),
    config: {},
    explicitConfig: {},
    profileNames: [],
    overrides: {},
    outDir: join(dir, 'out'),
    emitGcode: false,
  }
  return createSxSlicer(process.execPath, timeoutMs).slice(job)
}

async function waitDead(pid: number): Promise<boolean> {
  for (let i = 0; i < 50 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100))
  return !alive(pid)
}

describe('an sx run that ends without an exit code', () => {
  it('says the time limit stopped it, with slice_timeout and the limit', async () => {
    const failure = await sliceWith(fake('sleep(60_000)'), 1_500).catch((e: unknown) => e)
    expect(failure).toMatchObject({
      code: 'slice_timeout',
      message: 'sx stopped after the 1.5 s time limit without finishing',
      details: { limitMs: 1_500 },
    })
    expect(await waitDead(Number(readFileSync(pidFile, 'utf8')))).toBe(true)
  })

  it('names the signal when something else stops it', async () => {
    const sleeper = fake('sleep(60_000)')
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      // Stop it once it has recorded its pid: a timer from spawn can fire before a slow Node.js start gets that far.
      const ran = await runSx(process.execPath, [sleeper], 30_000, undefined, (child) => child.stdout?.once('data', () => child.kill(signal)))
      expect(ran).toMatchObject({ code: null, signal, timedOut: false })
      const e = sxStopped(ran, 30_000)
      expect(e).toMatchObject({ code: 'slice_failed', message: `sx was stopped (${signal}) before it finished`, details: { signal } })
      expect(await waitDead(Number(readFileSync(pidFile, 'utf8')))).toBe(true)
    }
  })

  // Only POSIX delivers a signal from outside: a process ended from outside on Windows exits with a code.
  it.skipIf(process.platform === 'win32')('names a signal sent from outside the server', async () => {
    const failure = await sliceWith(fake("process.kill(process.pid, 'SIGTERM'); sleep(60_000)"), 30_000).catch((e: unknown) => e)
    expect(failure).toMatchObject({ code: 'slice_failed', message: 'sx was stopped (SIGTERM) before it finished', details: { signal: 'SIGTERM' } })
  })

  it('keeps the exit code and stderr when sx exits on its own', async () => {
    const failure = await sliceWith(fake("require('node:fs').writeSync(2, 'sx slice: out of memory\\n'); process.exit(1)"), 30_000).catch((e: unknown) => e)
    expect(failure).toMatchObject({ code: 'slice_failed', message: 'sx exited with code 1: sx slice: out of memory' })
  })

  it('treats a run that finished as the limit fired as finished', () => {
    expect(sxStopped({ code: 0, signal: null, timedOut: true }, 1_000)).toBeUndefined()
    expect(sxStopped({ code: 1, signal: null, timedOut: false }, 1_000)).toBeUndefined()
    expect(sxStopped({ code: null, signal: null, timedOut: false }, 1_000)?.message).toBe('sx was stopped (by a signal) before it finished')
  })

  it('writes the limit in plain units', () => {
    expect(formatLimit(10 * 60_000)).toBe('10 min')
    expect(formatLimit(90_000)).toBe('1.5 min')
    expect(formatLimit(30_000)).toBe('30 s')
    expect(formatLimit(500)).toBe('500 ms')
  })
})
