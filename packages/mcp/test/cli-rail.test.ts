// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A rail through the CLI with the real geometry engine: one call adds the posts and the bar, the steps read back, and
// one undo each takes them off again.
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { built, GEOM_BUILD } from './helpers'

const bin = process.env['SLICERX_SX_GEOM_BIN'] ?? resolve(__dirname, '../../../target/release', process.platform === 'win32' ? 'sx-geom.exe' : 'sx-geom')
describe.skipIf(!built(bin, GEOM_BUILD))('a rail through the CLI with the real geometry engine', () => {
  it('adds the posts and the bar in one call and reads them back', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sx-rail-cli-'))
    const calls: [string, Record<string, unknown>][] = [
      ['design_new', { name: 'CLI shelf' }],
      ['geom_build', { design: 'd1', solids: [{ type: 'box', min: [-20, -10, 0], max: [20, 10, 4] }] }],
      ['geom_rail', { design: 'd1', path: { frame: { origin: [0, 0, 4], normal: [0, 0, 1] }, points: [[-18, -8], [18, -8]] }, height_mm: 2, part: 0, join: true }],
      ['design_steps', { design: 'd1' }],
      ['design_undo', { design: 'd1' }],
      ['design_undo', { design: 'd1' }],
    ]
    try {
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('SLICERX_')))
      const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/cli.ts', '--engine', 'sx', '--no-app', '--printers', 'off', '--sx-geom-bin', bin, '--out-dir', dir, '--profiles-dir', join(dir, 'profiles'), 'call', ...calls.flatMap(([name, args]) => [name, JSON.stringify(args)])], { cwd: resolve(__dirname, '..'), env: { ...env, HOME: dir, USERPROFILE: dir, SLICERX_MCP_SX_BIN: process.env['SLICERX_TEST_SX_BIN'] }, timeout: 90_000, maxBuffer: 2_000_000 })
      const lines = stdout.trim().split('\n').map((line) => JSON.parse(line) as { tool: string; ok: boolean; output: { output: { steps: number | { name: string; state: string }[]; volumeMm3: number; sizeMm: number[]; rail?: { posts: number; spacingMm: number; lengthMm: number } } } })
      expect(lines.map((line) => [line.tool, line.ok])).toEqual(calls.map(([name]) => ['slicerx_' + name, true]))
      const railed = lines[2]!.output.output
      expect(railed.rail).toMatchObject({ posts: 13, spacingMm: 3, lengthMm: 36 })
      expect(railed).toMatchObject({ steps: 3 })
      expect(railed.sizeMm[2]).toBeCloseTo(6, 3)
      expect((lines[3]!.output.output.steps as { name: string; state: string }[]).map((s) => [s.name, s.state]).slice(1)).toEqual([['Rail posts, 13', 'done'], ['Rail bar', 'done']])
      expect(lines[5]!.output.output).toMatchObject({ steps: 1, volumeMm3: 3200, sizeMm: [40, 20, 4] })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 100_000)
})
