// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { connect, noSx, sxBin, sxTimeout } from './helpers'
import { resolveSliceConfig } from '../src/config'
import { reviewProjectScripts } from '../src/project-script-review'
import { createSxSlicer } from '../src/sx'

describe.skipIf(noSx())('native stock review in project settings', { timeout: sxTimeout }, () => {
  it('accepts a bound cosmetic match and rejects a stale text result', async () => {
    const h = await connect({ engine: 'sx', sxBin })
    try {
      const names: string[] = []
      await h.ctx.profiles.prepare(names)
      const project = { name: 'pause.3mf', model: 'bambu-p1s', config: { printer_model: 'Bambu Lab P1S', gcode_flavor: 'marlin', machine_pause_gcode: '  M400 U1 ; pause\r\n' } }
      expect(() => resolveSliceConfig(h.ctx.store, h.ctx.profiles, names, undefined, { project })).toThrow()
      const scriptReviews = await reviewProjectScripts(h.ctx.profiles, names, { project }, undefined, createSxSlicer(sxBin), { model: 'bambu-p1s', firmware: 'marlin' })
      expect(scriptReviews).toHaveLength(1)
      expect(scriptReviews[0]!.review.decision, JSON.stringify(scriptReviews)).toBe('cosmetic')
      const result = resolveSliceConfig(h.ctx.store, h.ctx.profiles, names, undefined, { project, scriptReviews })
      expect(result.explicit.machine_pause_gcode).toBe(project.config.machine_pause_gcode)
      expect(result.gcodeKept.some((k) => k.key === 'machine_pause_gcode')).toBe(true)
      const conflicting = { ...project, config: { ...project.config, gcode_flavor: ['marlin', 'klipper'] } }
      expect(() => resolveSliceConfig(h.ctx.store, h.ctx.profiles, names, undefined, { project: conflicting, scriptReviews })).toThrow()
      const otherPrinter = { ...project, model: 'bambu-a1', config: { ...project.config, printer_model: 'Bambu Lab A1' } }
      expect(() => resolveSliceConfig(h.ctx.store, h.ctx.profiles, names, undefined, { project: otherPrinter, scriptReviews })).toThrow()
      project.config.machine_pause_gcode += '\nM500'
      expect(() => resolveSliceConfig(h.ctx.store, h.ctx.profiles, names, undefined, { project, scriptReviews })).toThrow()
    } finally { await h.client.close() }
  })

  it('requires explicit selection and reports a conflicting imported identity', async () => {
    const h = await connect({ engine: 'sx', sxBin })
    try {
      const names: string[] = []
      await h.ctx.profiles.prepare(names)
      const project = { name: 'conflict.3mf', model: 'bambu-a1', config: { printer_model: 'Bambu Lab A1', gcode_flavor: 'marlin', machine_pause_gcode: '  M400 U1 ; pause' } }
      const backend = createSxSlicer(sxBin)
      expect(await reviewProjectScripts(h.ctx.profiles, [], { project }, undefined, backend)).toEqual([])
      const scriptReviews = await reviewProjectScripts(h.ctx.profiles, names, { project }, undefined, backend, { model: 'bambu-p1s', firmware: 'marlin' })
      expect(scriptReviews[0]!.review.reason).toBe('printer_identity_conflict')
      expect(() => resolveSliceConfig(h.ctx.store, h.ctx.profiles, names, undefined, { project, scriptReviews })).toThrow()
    } finally { await h.client.close() }
  })

  it('retains every firmware declaration in imported arrays', async () => {
    const h = await connect({ engine: 'sx', sxBin })
    try {
      await h.ctx.profiles.prepare([])
      const backend = createSxSlicer(sxBin)
      for (const gcode_flavor of [['marlin', 'klipper'], [7], []]) {
        const project = { name: 'firmware.3mf', model: 'bambu-p1s', config: { printer_model: 'Bambu Lab P1S', gcode_flavor, machine_pause_gcode: '  M400 U1 ; pause' } }
        const reviews = await reviewProjectScripts(h.ctx.profiles, [], { project }, undefined, backend, { model: 'bambu-p1s', firmware: 'marlin' })
        expect(reviews[0]!.review.reason, JSON.stringify(gcode_flavor)).toBe('printer_identity_conflict')
      }
    } finally { await h.client.close() }
  })
})
