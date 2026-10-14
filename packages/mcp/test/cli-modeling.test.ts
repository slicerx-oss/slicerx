// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const bin = process.env['SLICERX_SX_GEOM_BIN'] ?? resolve(__dirname, '../../../target/release', process.platform === 'win32' ? 'sx-geom.exe' : 'sx-geom')
describe.skipIf(!existsSync(bin))('modeling through the CLI with the real geometry engine', () => {
  it('runs every shared command and reads its undoable result in one process', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sx-modeling-cli-'))
    const calls: [string, Record<string, unknown>][] = [
      ['design_new', { name: 'CLI block' }],
      ['geom_build', { design: 'd1', solids: [{ type: 'box', min: [-10, -5, 0], max: [10, 5, 8] }] }],
    ]
    for (const [name, args] of [
      ['cut', { plane: { axis: 'z', at: 4 }, keep: 'both' }],
      ['split', { build_volume_mm: [12, 12, 12], margin_mm: 0 }],
      ['mirror', { plane: { axis: 'x', at: 20 }, copy: false }],
      ['array', { spec: { kind: 'linear', count: 3, step: [25, 0, 0] }, merge: false }],
      ['repair', {}],
      ['hollow', { wall_mm: 1 }],
      ['emboss', { text: 'X', point: [0, 0, 8], normal: [0, 0, 1], size_mm: 3, depth_mm: 1 }],
      ['subtract', { solids: [{ type: 'box', min: [-2, -2, 4], max: [2, 2, 10] }] }],
    ] as [string, Record<string, unknown>][]) {
      calls.push(['geom_' + name, { ...args, design: 'd1' }], ['design_steps', { design: 'd1' }], ['design_undo', { design: 'd1' }])
    }
    try {
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('SLICERX_')))
      const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/cli.ts', '--engine', 'sx', '--no-app', '--printers', 'off', '--sx-geom-bin', bin, '--out-dir', dir, '--profiles-dir', join(dir, 'profiles'), 'call', ...calls.flatMap(([name, args]) => [name, JSON.stringify(args)])], { cwd: resolve(__dirname, '..'), env: { ...env, HOME: dir, USERPROFILE: dir, SLICERX_MCP_SX_BIN: process.env['SLICERX_SX_BIN'] }, timeout: 90_000, maxBuffer: 2_000_000 })
      const lines = stdout.trim().split('\n').map((line) => JSON.parse(line) as { tool: string; ok: boolean; output: { output: { steps: number | { state: string }[]; volumeMm3: number; sizeMm: number[] } } })
      expect(lines.map((line) => [line.tool, line.ok])).toEqual(calls.map(([name]) => ['slicerx_' + name, true]))
      expect(lines[1]!.output.output).toMatchObject({ steps: 1, volumeMm3: 1600, sizeMm: [20, 10, 8] })
      for (let index = 2; index < lines.length; index += 3) {
        expect(lines[index]!.output.output.steps).toBe(2)
        const steps = lines[index + 1]!.output.output.steps as { state: string }[]
        expect(steps).toHaveLength(2)
        expect(steps.every((step) => step.state === 'done')).toBe(true)
        expect(lines[index + 2]!.output.output).toMatchObject({ steps: 1, volumeMm3: 1600, sizeMm: [20, 10, 8] })
      }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 100_000)
})
