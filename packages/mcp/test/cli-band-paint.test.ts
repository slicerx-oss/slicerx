// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// `slicerx-mcp call` painting a height band on an exact design, run the way a client runs it: its own process, the
// design built by the calls before it, and the paint read back face by face. The engine is a stand-in sx-geom
// (band-engine-cli.ts) whose kernel splits faces along planes, so the band goes on whole faces; one that cannot
// refuses the band on an exact design.
import { execFile } from 'node:child_process'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import type { Row } from './band-engine'

const run = promisify(execFile)

interface Line {
  tool: string
  ok: boolean
  text: string
  output: { ok: boolean; summary: string; output: Record<string, unknown> }
}

/** A stand-in sx-geom: a script that runs band-engine-cli.ts, from the package so tsx resolves. */
function standIn(dir: string): string {
  const bin = join(dir, 'sx-geom')
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" --import tsx "${resolve(__dirname, 'band-engine-cli.ts')}" "$@"\n`)
  chmodSync(bin, 0o755)
  return bin
}

async function calls(list: readonly (readonly [string, Record<string, unknown>])[], env: Record<string, string> = {}): Promise<{ lines: Line[]; code: number }> {
  const dir = mkdtempSync(join(tmpdir(), 'slicerx-mcp-band-'))
  const args = ['--import', 'tsx', 'src/cli.ts', '--engine', 'stub', '--no-app', '--printers', 'off', '--sx-geom-bin', standIn(dir), '--out-dir', join(dir, 'out'), '--profiles-dir', join(dir, 'profiles'), 'call', ...list.flatMap(([t, a]) => [t, JSON.stringify(a)])]
  const opts = { cwd: resolve(__dirname, '..'), env: { ...process.env, HOME: dir, SX_BREP_DEV: '1', ...env } }
  const r = await run(process.execPath, args, opts).then((x) => ({ stdout: x.stdout, code: 0 }), (e: { stdout: string; code: number }) => ({ stdout: e.stdout, code: e.code }))
  return { lines: r.stdout.trim().split('\n').map((l) => JSON.parse(l) as Line), code: r.code }
}

const hull = [
  ['design_new', { name: 'Hull', exact: true }],
  ['geom_extrude', { design: 'd1', shape: { type: 'rectangle', widthMm: 30, heightMm: 10 }, placement: { center: [15, 5] }, distance_mm: 20 }],
  ['paint_preview', { design: 'd1', layer: 'color', state: 2, target: { kind: 'height', below: 4 } }],
] as const

describe.skipIf(process.platform === 'win32')('slicerx-mcp call paint on an exact design', () => {
  it('paints a band below 4 mm on whole faces, and reads it back face by face', async () => {
    const { lines, code } = await calls([...hull, ['paint_apply', { preview: 'p1' }], ['paint_regions', { design: 'd1', layer: 'color' }]])
    expect(lines.map((l) => [l.tool, l.ok])).toEqual([...hull.map(([t]) => t), 'paint_apply', 'paint_regions'].map((t) => [`slicerx_${t}`, true]))
    expect(code).toBe(0)
    // the preview names the faces it paints: the bottom (30 x 10) and the side's piece below 4 mm (30 x 4)
    const pv = lines[2]!.output.output as { parts: Row[] }
    expect(pv.parts[0]!.faces!.map((f) => [f.state, f.areaMm2])).toEqual([[2, 300], [2, 120]])
    // what the step painted is what the preview showed
    expect(lines[3]!.output.ok).toBe(true)
    const applied = (lines[3]!.output.output as { paint: Row[] }).paint[0]!.faces!
    expect(applied.map((f) => [f.state, f.areaMm2])).toEqual([[2, 300], [2, 120]])
    expect((lines[4]!.output.output as { parts: Row[] }).parts[0]!.faces).toEqual(applied)
  }, 120_000)

  it('is refused on an exact design by an engine that cannot split faces', async () => {
    const { lines, code } = await calls(hull, { SX_BAND_NO_IMPRINT: '1' })
    expect(lines.map((l) => l.ok)).toEqual([true, true, false])
    expect(lines[2]!.text).toContain('Exact replay does not support paint for this part')
    expect(code).toBe(1)
  }, 120_000)
})
