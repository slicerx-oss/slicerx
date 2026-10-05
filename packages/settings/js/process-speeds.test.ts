// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Locks the speeds, accelerations and jerk of the process tiers: per printer, the makers' own presets (Bambu
// Studio's for Bambu Lab, OrcaSlicer's for the rest), diffed privately against the current profiles.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PROCESS_SPEED_SOURCES, listPrinterProfiles, listProcessPresets, processConfig, processSpeedSource } from './profiles'

const file = fileURLToPath(new URL('../../profiles/process-speeds.json', import.meta.url))
const lockPath = fileURLToPath(new URL('../fixtures/process-speeds-lock.json', import.meta.url))
function fnv(text: string): string {
  let h = 0x811c9dc5
  for (const b of new TextEncoder().encode(text)) h = Math.imul(h ^ b, 0x01000193) >>> 0
  return h.toString(16).padStart(8, '0')
}
const num = (c: unknown, k: string): number[] => ((c as Record<string, unknown>)[k] as number[]).map(Number)

describe('process tier speeds', () => {
  it('follow the maker for each printer and tier', () => {
    const models = listPrinterProfiles().map((p) => p.id).filter((id) => processSpeedSource(id, 'standard'))
    expect(models).toHaveLength(56)
    expect(PROCESS_SPEED_SOURCES.bambuStudio).toMatch(/^[0-9a-f]{7,}$/)
    expect(processSpeedSource('bambu-p2s', 'fine')).toBe('Bambu Studio/BBL/0.12mm High Quality @BBL P2S')
    expect(processSpeedSource('bambu-p2s', 'strong')).toBe(processSpeedSource('bambu-p2s', 'standard'))
    // The P2S preset in Bambu Studio's source ships a travel speed of 1000 at every quality.
    for (const tier of ['draft', 'standard', 'fine', 'extra_fine']) expect(num(processConfig(tier, 0.4, 'bambu-p2s'), 'travel_speed')[0], tier).toBe(1000)
    expect(num(processConfig('standard', 0.4, 'prusa-mk4s'), 'outer_wall_speed')[0]).toBe(170)
  })
  it('puts the tuned quality values on the Fine tier of the P2S and H2 family only', () => {
    const p2s = processConfig('fine', 0.4, 'bambu-p2s') as unknown as Record<string, unknown>
    expect(num(p2s, 'outer_wall_speed')).toEqual([50, 60, 60])
    expect(num(p2s, 'overhang_2_4_speed')).toEqual([40, 40, 40])
    expect(p2s).toMatchObject({ support_interface_top_layers: 3, support_top_z_distance: 0.16, support_object_xy_distance: 0.4, support_threshold_angle: 25, skirt_loops: 1, top_shell_layers: 5, seam_position: 'aligned' })
    const std = processConfig('standard', 0.4, 'bambu-p2s') as unknown as Record<string, unknown>
    expect(num(std, 'outer_wall_speed')[0]).toBe(200)
    const x1c = processConfig('fine', 0.4, 'bambu-x1-carbon') as unknown as Record<string, unknown>
    expect(num(x1c, 'outer_wall_speed')).toEqual([60, 60])
  })
  it('falls back to the plain process, not a scaled one, for other nozzles and unknown printers', () => {
    for (const cfg of [processConfig('fine', 0.6, 'bambu-p2s'), processConfig('fine', 0.4), processConfig('fine', 0.4, 'generic-klipper')]) expect(num(cfg, 'outer_wall_speed')).toEqual([60])
    expect(listProcessPresets(0.4, 'bambu-p2s').map((p) => p.label)).toContain('0.12 mm Fine')
  })
  it('matches the lock file', () => {
    const now = fnv(readFileSync(file, 'utf8'))
    if (process.env['UPDATE_GOLDEN'] === '1') {
      writeFileSync(lockPath, JSON.stringify({ comment: 'FNV-1a of packages/profiles/process-speeds.json. Written by js/process-speeds.test.ts (UPDATE_GOLDEN=1) after the private parity check passes.', orcaCommit: PROCESS_SPEED_SOURCES.orcaSlicer, bambuStudioCommit: PROCESS_SPEED_SOURCES.bambuStudio, file: now }, null, 1) + '\n')
      return
    }
    const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as { file: string; orcaCommit: string; bambuStudioCommit: string }
    expect(lock).toMatchObject({ file: now, orcaCommit: PROCESS_SPEED_SOURCES.orcaSlicer, bambuStudioCommit: PROCESS_SPEED_SOURCES.bambuStudio })
  })
})
