// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { IDENTITY, replayHistory, type History } from '@slicerx/cad-history'
import { geomEngine } from '../src/geom'

it('kills a busy process at its deadline and permits a fresh call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sx-geom-deadline-'))
  const pidFile = join(dir, 'pid')
  const busy = join(dir, 'busy.cjs')
  const healthy = join(dir, 'healthy.cjs')
  writeFileSync(busy, `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.stdout.write('{"ok":true}'); while (true) { Math.sqrt(Date.now()); }`)
  writeFileSync(healthy, 'process.stdin.resume(); process.stdin.on("end", () => process.stdout.write(\'{"ok":true}\'));')
  const call = geomEngine(process.execPath, 2000)
  try {
    const failure = await call(busy, {}).catch((error: unknown) => error)
    expect(failure).toMatchObject({ name: 'AbortError', message: expect.stringContaining('execution deadline') })
    const pid = Number(readFileSync(pidFile, 'utf8'))
    expect(() => process.kill(pid, 0)).toThrow()
    const history: History = { version: 1, base: [], steps: [{ id: 'box', part: 0, transform: [...IDENTITY], params: {
      op: 'shape.extrude', frame: { origin: [0, 0, 0], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
      shape: { type: 'rectangle', widthMm: 20, heightMm: 10 }, spec: { distanceMm: 5, operation: 'new' },
    } }] }
    const operations: string[] = []
    await expect(replayHistory(async (op) => { operations.push(op); throw failure }, { history, exact: true })).rejects.toBe(failure)
    expect(operations).toEqual(['brep.extrude'])
    await expect(call(healthy, {})).resolves.toEqual({ ok: true })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

it.each([
  [1, { error: 'request: exceeds input limit' }, 'request: exceeds input limit'],
  [0, { ok: true }, 'input stream'],
] as const)('refuses an incomplete request with exit code %s without an unhandled pipe error', async (code, reply, reason) => {
  const dir = mkdtempSync(join(tmpdir(), 'sx-geom-input-refusal-'))
  const refusing = join(dir, 'refusing.cjs')
  writeFileSync(refusing, `require("node:fs").closeSync(0); process.stdout.write(${JSON.stringify(JSON.stringify(reply))}); setTimeout(() => process.exit(${code}), 20);`)
  try {
    await expect(geomEngine(process.execPath, 2000)(refusing, { data: 'x'.repeat(1024 * 1024) })).rejects.toThrow(reason)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
