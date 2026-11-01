// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A filament's own travel slope (`filament_travel_slope`) and the ramp lift (`z_hop_types` Ramp Lift) for clients:
// explained, set on a project and read back, and a PrusaSlicer project whose filament ramps its lift slices through the
// MCP server to the same moves as `sx slice <project.3mf>`, with travels that climb by their length. Nothing here sends
// anything to a printer.
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readProjectFile } from '../src/projectfile'
import { connect, data, noSx, sxBin, sxTimeout, text } from './helpers'

const project = join(__dirname, '../../core/cli/tests/fixtures/prusa-lift/mk4--isl--stock.3mf')

describe('the ramp lift settings', () => {
  it('are explained with their unit, range and values', async () => {
    const h = await connect()
    try {
      const slope = await h.call('slicerx_explain_setting', { key: 'filament_travel_slope' })
      expect(slope.isError, text(slope)).toBeFalsy()
      expect(data(slope)).toMatchObject({ key: 'filament_travel_slope', label: 'Filament travel slope', section: 'filament', unit: 'deg', min: 0, max: 90 })
      const kind = await h.call('slicerx_explain_setting', { key: 'filament_z_hop_types' })
      expect(kind.isError, text(kind)).toBeFalsy()
      expect(JSON.stringify(data(kind))).toContain('Ramp Lift')
    } finally { await h.client.close() }
  })

  it('are set on a project and read back', async () => {
    const h = await connect()
    try {
      await h.call('slicerx_project_open', { filament: 'pla' })
      const set = await h.call('slicerx_project_set_overrides', { changes: { filament_travel_slope: [5], filament_z_hop: [0.6], filament_z_hop_types: ['Ramp Lift'] } })
      expect(set.isError, text(set)).toBeFalsy()
      const read = data<{ output: { overrides: Record<string, unknown> } }>(await h.call('slicerx_project_show')).output.overrides
      expect(read).toMatchObject({ filament_travel_slope: [5], filament_z_hop_types: ['Ramp Lift'] })
      const bad = await h.call('slicerx_project_set_overrides', { changes: { filament_travel_slope: [95] } })
      expect(bad.isError).toBe(true)
    } finally { await h.client.close() }
  })

  it("reads a PrusaSlicer filament's ramp and its angle from a project", () => {
    const { config } = readProjectFile(project)
    expect(config['filament_z_hop_types']).toEqual(['Ramp Lift'])
    expect(config['filament_travel_slope']).toEqual([1])
    expect(config['filament_z_hop']).toEqual([0.6])
  })
})

/** The lines of a G-code file that print, without its comments. */
const moves = (gcode: string): string[] => gcode.split('\n').filter((l) => !l.startsWith(';') && l.trim() !== '')

/** How far above its layer each same-layer travel goes, from the first layer on (absolute XYZ, relative E). */
function lifts(gcode: string): number[] {
  const out: number[] = []
  let [x, y, z] = [0, 0, 0]
  let peak = 0
  let printing = false
  let changed = false
  for (const raw of gcode.split('\n')) {
    if (raw.startsWith(';LAYER_CHANGE')) { printing = true; changed = true }
    const t = raw.split(';')[0]!.trim()
    const cmd = t.split(/\s+/)[0]
    if (cmd !== 'G0' && cmd !== 'G1') continue
    const arg = (k: string): number | undefined => {
      const m = new RegExp(`(?:^|\\s)${k}(-?[\\d.]+)`).exec(t.slice(cmd.length))
      return m ? Number(m[1]) : undefined
    }
    const [nx, ny, nz, e] = [arg('X') ?? x, arg('Y') ?? y, arg('Z') ?? z, arg('E')]
    if (printing && e !== undefined && e > 0 && Math.hypot(nx - x, ny - y) > 0) {
      if (!changed && peak > nz) out.push(Math.round((peak - nz) * 1000) / 1000)
      peak = nz
      changed = false
    } else if (printing) peak = Math.max(peak, nz)
    ;[x, y, z] = [nx, ny, nz]
  }
  return out
}

describe.skipIf(noSx())('a PrusaSlicer ramp through the MCP server and sx slice', () => {
  it('prints the same moves, climbing by each travel\'s length', { timeout: sxTimeout * 3 }, async () => {
    const h = await connect({ engine: 'sx', sxBin })
    try {
      const path = join(h.dir, 'ramp.3mf')
      writeFileSync(path, readFileSync(project))
      const cli = spawnSync(sxBin, ['slice', path, '-o', join(h.dir, 'cli.gcode')], { encoding: 'utf8' })
      expect(cli.status, cli.stderr).toBe(0)
      const r = await h.call('slicerx_slice_file', { model: path, project_settings: true })
      expect(r.isError, JSON.stringify(r.content)).toBeFalsy()
      const viaCli = readFileSync(join(h.dir, 'cli.gcode'), 'utf8')
      const viaMcp = readFileSync(String(data<{ gcode_path: string }>(r).gcode_path), 'utf8')
      expect(moves(viaMcp)).toEqual(moves(viaCli))
      // At 1 degree up to 0.6 mm: travels between the boxes lift less than the full height, as far as their length
      // takes them, and none lifts more.
      const up = lifts(viaMcp)
      expect(up.some((l) => l > 0.05 && l < 0.59), JSON.stringify(up)).toBe(true)
      expect(Math.max(...up)).toBeLessThanOrEqual(0.6)
    } finally { await h.client.close() }
  })
})
