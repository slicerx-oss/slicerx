// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// `slicerx-mcp call geom_hole`, run the way a client runs it: its own process, a design built by the calls before it,
// the hole read back by the tool and then by the design's steps and a measure.
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const run = promisify(execFile)
const bin = process.env['SLICERX_SX_GEOM_BIN'] ?? resolve(__dirname, '../../../target/release', process.platform === 'win32' ? 'sx-geom.exe' : 'sx-geom')

interface Line {
  tool: string
  ok: boolean
  text: string
  output: { ok: boolean; summary: string; output: Record<string, unknown> }
}

describe.skipIf(!existsSync(bin))('slicerx-mcp call geom_hole', () => {
  it('makes a plate hole an M3 counterbore as a design step, and reads it back', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slicerx-mcp-hole-'))
    const calls = [
      ['design_new', { name: 'Plate' }],
      ['geom_extrude', { design: 'd1', shape: { type: 'rectangle', widthMm: 30, heightMm: 20 }, placement: { center: [15, 10] }, distance_mm: 5 }],
      ['geom_extrude', { design: 'd1', shape: { type: 'circle', diameterMm: 6 }, frame: { origin: [15, 10, 5], normal: [0, 0, 1] }, distance_mm: 5, operation: 'cut' }],
      ['geom_hole', { design: 'd1', center: [15, 10, 5], axis: [0, 0, 1], diameter_mm: 3.4, counterbore: { diameter_mm: 6.5, depth_mm: 3 }, label: 'M3 counterbore' }],
      ['design_steps', { design: 'd1' }],
      ['geom_measure', { design: 'd1', a: { at: [16.7, 10, 1], normal: [-1, 0, 0] } }],
    ] as const
    const args = ['--import', 'tsx', 'src/cli.ts', '--engine', 'stub', '--no-app', '--printers', 'off', '--sx-geom-bin', bin, '--out-dir', join(dir, 'out'), '--profiles-dir', join(dir, 'profiles'), 'call', ...calls.flatMap(([t, a]) => [t, JSON.stringify(a)])]
    const { stdout } = await run(process.execPath, args, { cwd: resolve(__dirname, '..'), env: { ...process.env, HOME: dir } })
    const lines = stdout.trim().split('\n').map((l) => JSON.parse(l) as Line)
    expect(lines.map((l) => [l.tool, l.ok])).toEqual(calls.map(([t]) => [`slicerx_${t}`, true]))

    const hole = lines[3]!.output
    expect(hole.summary).toBe('Made the 6 mm hole 3.4 mm with a counterbore: step 3, M3 counterbore')
    expect(hole.output['before']).toEqual({ center: [15, 10, 5], axis: [0, 0, 1], diameterMm: 6, depthMm: 5, kind: 'through' })
    expect(hole.output['after']).toEqual({ center: [15, 10, 5], axis: [0, 0, 1], diameterMm: 3.4, depthMm: 5, kind: 'through', head: 'counterbore', counterbore: { diameterMm: 6.5, depthMm: 3 } })

    // the step is the hole tool's own: a hole step with its diameter as the number to edit
    const steps = lines[4]!.output.output['steps'] as { name: string; op: string; state: string; value?: { value: number } }[]
    expect(steps.at(-1)).toMatchObject({ name: 'M3 counterbore', op: 'hole.apply', state: 'done', value: { value: 3.4 } })
    const shaft = lines[5]!.output.output['measurement'] as { diameterMm?: number }
    expect(shaft.diameterMm).toBeCloseTo(3.4, 2)
  }, 60_000)
})
