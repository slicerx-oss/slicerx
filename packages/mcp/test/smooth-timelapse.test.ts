// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Smooth timelapse on a Bambu Lab A1 through the integrator path: a client sets timelapse_type in overrides, slices,
// and reads back the prime tower the shots need (prime_tower), even with one filament. With the prime tower off the
// slice says the shots are taken as in a traditional timelapse. Nothing here sends anything to a printer.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { connect, data, noSx, sxBin, sxTimeout, text } from './helpers'

type Tower = { x: number; y: number; width: number; depth: number; angle: number }
type Summary = { prime_tower?: Tower; warnings: string[]; gcode_path?: string }

const A1 = ['machine:bambu-a1', 'process:standard']

describe.skipIf(noSx())('smooth timelapse on an A1', { timeout: sxTimeout }, () => {
  const slice = async (overrides: Record<string, unknown>): Promise<{ out: Summary; said: string }> => {
    const h = await connect({ engine: 'sx', sxBin })
    try {
      const r = await h.call('slicerx_slice_file', { model: join(h.dir, 'cube.stl'), profiles: A1, overrides })
      expect(r.isError, text(r)).toBeFalsy()
      return { out: data<Summary>(r), said: text(r) }
    } finally { await h.client.close() }
  }

  it('prints a prime tower with one filament and reads it back', async () => {
    const { out, said } = await slice({ timelapse_type: '1' })
    expect(out.prime_tower).toBeDefined()
    expect(out.prime_tower!.width).toBeGreaterThan(3)
    expect(out.prime_tower!.depth).toBeGreaterThan(3)
    expect(said).toMatch(/^Prime tower: [\d.]+ x [\d.]+ mm at \(/m)
    const g = readFileSync(out.gcode_path!, 'utf8')
    // Every layer: the shot, then the tower.
    // Layers start at the layer change template's progress line (the settings block at the end quotes the template).
    const layers = g.split(/^; layer num\/total_layer_count: \d+\//m).slice(1)
    expect(layers.length).toBeGreaterThan(1)
    for (const l of layers) {
      const shot = l.indexOf('SKIPTYPE: timelapse')
      const tower = l.indexOf('; FEATURE: Prime tower')
      expect(shot).toBeGreaterThan(-1)
      expect(tower).toBeGreaterThan(shot)
      expect(l.slice(0, tower)).not.toMatch(/; FEATURE: (?!Prime tower)/)
    }
  })

  it('prints no tower for a traditional timelapse with one filament', async () => {
    const { out } = await slice({ timelapse_type: '0' })
    expect(out.prime_tower).toBeUndefined()
    expect(readFileSync(out.gcode_path!, 'utf8')).not.toContain('; FEATURE: Prime tower')
  })

  it('says so when the prime tower is off', async () => {
    const { out } = await slice({ timelapse_type: '1', enable_prime_tower: false })
    expect(out.prime_tower).toBeUndefined()
    expect(out.warnings.some((w) => w.startsWith('Smooth timelapse needs the prime tower'))).toBe(true)
  })
})
