// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A part renamed through the CLI with the real geometry engine: a hull cut twice keeping both pieces has a piece called
// "Hull top top", one call renames it, the steps read back, an empty name is refused in words, and undo and redo take the
// name off and put it back.
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { built, GEOM_BUILD } from './helpers'

type Line = { tool: string; ok: boolean; text: string; output: { output: { parts: { name: string }[]; steps: number | { name: string; state: string }[] } } }

const bin = process.env['SLICERX_SX_GEOM_BIN'] ?? resolve(__dirname, '../../../target/release', process.platform === 'win32' ? 'sx-geom.exe' : 'sx-geom')
describe.skipIf(!built(bin, GEOM_BUILD))('a part renamed through the CLI with the real geometry engine', () => {
  const cli = async (calls: [string, Record<string, unknown>][], dir: string): Promise<{ lines: Line[]; code: number }> => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('SLICERX_')))
    const args = ['--import', 'tsx', 'src/cli.ts', '--engine', 'sx', '--no-app', '--printers', 'off', '--sx-geom-bin', bin, '--out-dir', dir, '--profiles-dir', join(dir, 'profiles'), 'call', ...calls.flatMap(([name, a]) => [name, JSON.stringify(a)])]
    const run = await promisify(execFile)(process.execPath, args, { cwd: resolve(__dirname, '..'), env: { ...env, HOME: dir, USERPROFILE: dir, SLICERX_MCP_SX_BIN: process.env['SLICERX_TEST_SX_BIN'] }, timeout: 90_000, maxBuffer: 2_000_000 })
      .then((r) => ({ stdout: r.stdout, code: 0 }), (e: { stdout: string; code: number }) => ({ stdout: e.stdout, code: e.code }))
    return { lines: run.stdout.trim().split('\n').map((line) => JSON.parse(line) as Line), code: run.code }
  }
  const cut = (part: number, z: number): [string, Record<string, unknown>] => ['geom_cut', { design: 'd1', part, keep: 'both', plane: { point: [0, 0, z], normal: [0, 0, 1] } }]

  it('renames the piece two cuts made, reads it back, refuses an empty name, and undoes and redoes it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sx-rename-cli-'))
    const calls: [string, Record<string, unknown>][] = [
      ['design_new', { name: 'Ship' }],
      ['geom_build', { design: 'd1', solids: [{ type: 'box', min: [-20, -10, 0], max: [20, 10, 12] }], name: 'Hull' }],
      cut(0, 4),
      cut(1, 8),
      ['design_rename_part', { design: 'd1', part: 2, name: 'Lid' }],
      ['design_steps', { design: 'd1' }],
      ['design_undo', { design: 'd1' }],
      ['design_redo', { design: 'd1' }],
    ]
    try {
      const { lines, code } = await cli(calls, dir)
      expect(code).toBe(0)
      expect(lines.map((line) => [line.tool, line.ok])).toEqual(calls.map(([name]) => ['slicerx_' + name, true]))
      expect(lines[3]!.output.output.parts.map((p) => p.name)).toEqual(['Hull', 'Hull top', 'Hull top top'])
      expect(lines[4]!.text).toContain('Renamed Hull top top to Lid: step 4')
      expect(lines[4]!.output.output.parts.map((p) => p.name)).toEqual(['Hull', 'Hull top', 'Lid'])
      expect((lines[5]!.output.output.steps as { name: string; state: string }[]).at(-1)).toEqual(expect.objectContaining({ name: 'Rename Hull top top to Lid', state: 'done' }))
      expect(lines[6]!.output.output.parts.map((p) => p.name)).toEqual(['Hull', 'Hull top', 'Hull top top'])
      expect(lines[7]!.output.output.parts.map((p) => p.name)).toEqual(['Hull', 'Hull top', 'Lid'])

      // an empty name stops the run at that call, with the words and exit code 1
      const refused = await cli([...calls.slice(0, 4), ['design_rename_part', { design: 'd1', part: 2, name: '   ' }]], dir)
      expect(refused.code).toBe(1)
      expect(refused.lines.at(-1)).toMatchObject({ tool: 'slicerx_design_rename_part', ok: false })
      expect(refused.lines.at(-1)!.text).toContain('name: give the part a name')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 100_000)
})
