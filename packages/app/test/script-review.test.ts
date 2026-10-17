// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { execFileSync } from 'node:child_process'
import type { ScriptReviewInput, SlicerHost } from '@slicerx/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { recognizedScript, reviewImportedScripts } from '../src/project/script-review'
import { runCall } from '../src/app-link/methods'
import { get, set } from '../src/state/store'
import { returnToProjectPrinter } from '../src/project/project-printer'

const sx = process.env['SLICERX_TEST_SX_BIN']
if (!sx && process.env['SLICERX_TEST_REQUIRE_SX'] === '1') throw new Error('SLICERX_TEST_SX_BIN is required')
const selected = { model: 'bambu-p1s', firmware: 'marlin' }
const text = '  M400 U1 ; pause\r\n'
const settings = { printer_model: 'Bambu Lab P1S', gcode_flavor: 'marlin', machine_pause_gcode: text }
const reviewScripts = async (inputs: ScriptReviewInput[]) => JSON.parse(execFileSync(sx!, ['review-script', '-', '--batch'], {
  input: JSON.stringify(inputs), encoding: 'utf8', timeout: 30000, windowsHide: true,
}))

describe.skipIf(!sx)('imported script read-back from the native engine', () => {
  afterEach(() => set({ projectScriptReviews: null }))
  it('preserves original text and the complete engine review', async () => {
    const result = await reviewImportedScripts({ reviewScripts } as SlicerHost, settings, selected)
    const native = await reviewScripts([{ selected, declared: [selected], key: 'machine_pause_gcode', text }])
    expect(result).toEqual([{ key: 'machine_pause_gcode', text, review: native[0] }])
    expect(result[0]!.review.decision).toBe('cosmetic')
    const vouched = get().vouchedGcode
    set({ projectScriptReviews: { source: 'pause.3mf', records: result } })
    expect(await runCall('app.info', {})).toMatchObject({ script_review_source: 'pause.3mf', script_reviews: [{ key: 'machine_pause_gcode', ...native[0] }] })
    expect(get().vouchedGcode).toBe(vouched)
    expect(recognizedScript('machine_pause_gcode', text, selected.model, settings, result)).toBe(true)
    expect(recognizedScript('machine_pause_gcode', `${text}\nM500`, selected.model, settings, result)).toBe(false)
    expect(recognizedScript('machine_pause_gcode', text, 'bambu-a1', settings, result)).toBe(false)
    expect(recognizedScript('machine_pause_gcode', text, selected.model, { ...settings, printer_model: 'Bambu Lab A1' }, result)).toBe(false)
    expect(recognizedScript('machine_pause_gcode', text, selected.model, { gcode_flavor: ['marlin', 'klipper'] }, result)).toBe(false)
    expect(recognizedScript('machine_pause_gcode', [text, 'M500'], selected.model, settings, result)).toBe(false)
  })

  it('cannot select a printer from imported metadata or hide firmware conflicts', async () => {
    const host = { reviewScripts } as SlicerHost
    expect((await reviewImportedScripts(host, settings, null))[0]!.review.reason).toBe('printer_identity_required')
    const conflict = { ...settings, gcode_flavor: ['marlin', 'klipper'] }
    expect((await reviewImportedScripts(host, conflict, selected))[0]!.review.reason).toBe('printer_identity_conflict')
  })

  it('does not turn automatic recognition into person approval after switching printers', () => {
    const previous = get()
    try {
      set({ vouchedGcode: {}, projectPrinter: {
        id: 'project-printer', name: 'P1S', vendor: 'Bambu Lab', model: 'P1S', profileId: 'bambu-p1s', nozzle: 0.4,
        source: 'pause.3mf', previousPrinterId: null, gcodeKeys: ['machine_pause_gcode'], recognizedGcodeKeys: ['machine_pause_gcode'],
        parked: { machine_pause_gcode: text },
      } })
      returnToProjectPrinter()
      expect(get().overrides.machine_pause_gcode).toBe(text)
      expect(get().vouchedGcode).toEqual({})
    } finally { set({ projectPrinter: previous.projectPrinter, vouchedGcode: previous.vouchedGcode, overrides: previous.overrides }) }
  })
})
