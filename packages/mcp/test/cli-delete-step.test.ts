// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The command-line client deletes a feature and reads the remaining solid back through the real geometry binary.
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const run = promisify(execFile)
const bin = process.env['SLICERX_SX_GEOM_BIN'] ?? resolve(__dirname, '../../../target/release', process.platform === 'win32' ? 'sx-geom.exe' : 'sx-geom')

function call(calls: readonly (readonly [string, Record<string, unknown>])[]) {
  const dir = mkdtempSync(join(tmpdir(), 'slicerx-delete-step-'))
  const args = ['--import', 'tsx', 'src/cli.ts', '--engine', 'stub', '--no-app', '--printers', 'off', '--sx-geom-bin', bin, '--out-dir', join(dir, 'out'), '--profiles-dir', join(dir, 'profiles'), 'call', ...calls.flatMap(([t, a]) => [t, JSON.stringify(a)])]
  return run(process.execPath, args, { cwd: resolve(__dirname, '..'), env: { ...process.env, HOME: dir } })
}

describe.skipIf(!existsSync(bin))('slicerx-mcp call design_delete_step', () => {
  it('deletes a hole and reads back the feature list and restored block', async () => {
    const calls = [
      ['design_new', { name: 'Block' }],
      ['geom_extrude', { design: 'd1', shape: { type: 'rectangle', widthMm: 30, heightMm: 20 }, distance_mm: 10 }],
      ['geom_extrude', { design: 'd1', frame: { origin: [0, 0, 10], normal: [0, 0, 1] }, shape: { type: 'rectangle', widthMm: 4, heightMm: 4 }, distance_mm: 10, operation: 'cut' }],
      ['design_delete_step', { design: 'd1', step: 2 }],
      ['design_steps', { design: 'd1' }],
      ['geom_info', { design: 'd1' }],
    ] as const
    const { stdout } = await call(calls)
    const lines = stdout.trim().split('\n').map((line) => JSON.parse(line) as { ok: boolean; tool: string; output: { output: Record<string, unknown> } })
    expect(lines.map((l) => [l.tool, l.ok])).toEqual(calls.map(([t]) => [`slicerx_${t}`, true]))
    const deleted = lines[3]!.output.output
    expect(deleted['removed']).toMatchObject({ index: 2 })
    expect(deleted['volumeMm3']).toBeCloseTo(6000, 2)
    expect(lines[4]!.output.output['steps']).toEqual(deleted['steps'])
    expect(lines[5]!.output.output['parts']).toMatchObject([{ watertight: true, volumeMm3: 6000 }])
  }, 60_000)

  it('exits unsuccessfully with the broken feature read-back and stops the command chain', async () => {
    const result = await call([
      ['design_new', { name: 'Plate' }],
      ['geom_extrude', { design: 'd1', shape: { type: 'rectangle', widthMm: 20, heightMm: 10 }, distance_mm: 3 }],
      ['geom_extrude', { design: 'd1', operation: 'cut', frame: { origin: [0, 0, 3], normal: [0, 0, 1] }, shape: { type: 'circle', diameterMm: 4 }, distance_mm: 3 }],
      ['geom_hole', { design: 'd1', center: [0, 0, 3], axis: [0, 0, 1], diameter_mm: 3 }],
      ['design_delete_step', { design: 'd1', step: 2 }],
      ['design_steps', { design: 'd1' }],
    ]).then(() => { throw new Error('The broken replay should fail the command') }, (e: unknown) => e as { code: number; stdout: string })
    expect(result.code).toBe(1)
    const lines = result.stdout.trim().split('\n').map((line) => JSON.parse(line) as unknown)
    expect(lines).toHaveLength(5)
    expect(lines.at(-1)).toMatchObject({ tool: 'slicerx_design_delete_step', ok: false, output: { ok: false, output: { volumeMm3: 600, steps: [{ state: 'done' }, { state: 'broken' }] } } })
  }, 60_000)
})
