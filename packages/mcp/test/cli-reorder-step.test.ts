// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { noSx, sxBin } from './helpers'

const run = promisify(execFile)
const geom = process.env['SLICERX_SX_GEOM_BIN'] ?? resolve(__dirname, '../../../target/release', process.platform === 'win32' ? 'sx-geom.exe' : 'sx-geom')
const box = { type: 'rectangle', widthMm: 20, heightMm: 10 }
const prefix = [
  ['design_new', { name: 'Block' }],
  ['geom_extrude', { design: 'd1', shape: box, distance_mm: 3 }],
  ['geom_extrude', { design: 'd1', shape: { type: 'rectangle', widthMm: 6, heightMm: 6 }, frame: { origin: [0, 0, 3], normal: [0, 0, 1] }, distance_mm: 4, operation: 'join' }],
  ['geom_push_pull', { design: 'd1', face: { at: [0, 0, 7], normal: [0, 0, 1] }, distance_mm: 2 }],
] as const

it.skipIf(noSx() || !existsSync(geom))('the CLI reorders and reads back, then stops a chain on a broken replay', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sx-reorder-'))
  const call = (calls: readonly (readonly [string, Record<string, unknown>])[]) => run(process.execPath, ['--import', 'tsx', 'src/cli.ts', '--engine', 'sx', '--sx-bin', sxBin, '--sx-geom-bin', geom, '--no-app', '--printers', 'off', '--out-dir', join(dir, 'out'), '--profiles-dir', join(dir, 'profiles'), 'call', ...calls.flatMap(([name, args]) => [name, JSON.stringify(args)])], { cwd: resolve(__dirname, '..'), env: { ...process.env, HOME: dir, USERPROFILE: dir } })
  type Line = { tool: string; ok: boolean; output: { output: { steps: { id: string; state: string }[]; moved: { from: number; to: number }; sizeMm: number[] } } }
  const lines = (stdout: string) => stdout.trim().split('\n').map((l) => JSON.parse(l) as Line)
  try {
    const good = lines((await call([
      ...prefix,
      ['geom_extrude', { design: 'd1', shape: box, frame: { origin: [30, 0, 0], normal: [0, 0, 1] }, distance_mm: 2, operation: 'new' }],
      ['design_steps', { design: 'd1' }],
      ['design_reorder_step', { design: 'd1', step: 4, to: 1 }],
      ['design_steps', { design: 'd1' }],
    ])).stdout)
    expect(good.every((l) => l.ok)).toBe(true)
    expect(good[6]!.output.output.moved).toEqual(expect.objectContaining({ from: 4, to: 1 }))
    expect(good[7]!.output.output.steps).toEqual(good[6]!.output.output.steps)
    const ids = good[5]!.output.output.steps.map((s) => s.id)
    expect(good[7]!.output.output.steps.map((s) => s.id)).toEqual([ids[3], ids[0], ids[1], ids[2]])
    expect(good[7]!.output.output.sizeMm).toEqual(good[5]!.output.output.sizeMm)
    const failed = await call([
      ...prefix,
      ['design_reorder_step', { design: 'd1', step: 3, to: 2 }],
      ['design_steps', { design: 'd1' }],
    ]).then(() => { throw new Error('Expected a failed replay') }, (e: unknown) => e as { code: number; stdout: string })
    expect(failed.code).toBe(1)
    const stopped = lines(failed.stdout)
    expect(stopped).toHaveLength(5)
    expect(stopped[4]!.ok).toBe(false)
    expect(stopped[4]!.output.output.steps.map((s) => s.state)).toEqual(['done', 'broken', 'skipped'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
