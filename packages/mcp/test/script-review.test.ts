// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import type { ScriptReview, ScriptReplacement } from '@slicerx/contracts'
import { connect, data, noSx, sxBin, sxTimeout } from './helpers'
import { createSxSlicer } from '../src/sx'

describe.skipIf(noSx())('shared native script review', { timeout: sxTimeout }, () => {
  it('retains the same replacement record through CLI and MCP without applying it', async () => {
    const input = { selected: { model: 'bambu-p1s', firmware: 'marlin' }, declared: [], key: 'machine_pause_gcode', original: 'M400 U1\r\n\r\nM500', replacement: 'M400 U1' }
    const native = JSON.parse(execFileSync(sxBin, ['prepare-script-replacement', '-'], { input: JSON.stringify(input), encoding: 'utf8', timeout: 30_000, windowsHide: true })) as ScriptReplacement
    const h = await connect({ engine: 'sx', sxBin })
    try {
      const response = await h.call('slicerx_prepare_script_replacement', input)
      expect(response.isError, JSON.stringify(response.content)).toBeFalsy()
      expect(data<ScriptReplacement>(response)).toEqual(native)
      expect(native.decision).toBe('prepared')
      expect(native.original).toBe(input.original)
      expect(native.stockReview.reason).toBe('stock_equivalent')
      const rejected = await h.call('slicerx_prepare_script_replacement', { ...input, replacement: 'M400 U1\nM500' })
      expect(data<ScriptReplacement>(rejected)).toMatchObject({ decision: 'review', reason: 'script_changed', original: input.original })
    } finally { await h.client.close() }
  })
  it('keeps batch decisions in request order', async () => {
    const inputs = [
      { selected: null, key: 'machine_start_gcode', text: 'M500' },
      { selected: { model: 'unknown', firmware: 'marlin' }, key: 'machine_start_gcode', text: 'G28' },
    ]
    const native = JSON.parse(execFileSync(sxBin, ['review-script', '-', '--batch'], { input: JSON.stringify(inputs), encoding: 'utf8', timeout: 30_000, windowsHide: true })) as ScriptReview[]
    const backend = createSxSlicer(sxBin)
    expect(await backend.reviewScripts!(inputs)).toEqual(native)
    expect(native.map((r) => r.reason)).toEqual(['printer_identity_required', 'stock_version_unknown'])
    expect(await backend.reviewScripts!([])).toEqual([])
  })
  it('returns the same refusal and read-back through CLI and MCP', async () => {
    const input = { selected: null, declared: [{ model: 'bambu-p1s', firmware: 'marlin' }], key: 'machine_start_gcode', text: 'M500 ; imported printer name alone is insufficient' }
    const native = JSON.parse(execFileSync(sxBin, ['review-script', '-'], { input: JSON.stringify(input), encoding: 'utf8', timeout: 30_000, windowsHide: true })) as ScriptReview
    const h = await connect({ engine: 'sx', sxBin })
    try {
      const result = await h.call('slicerx_review_script', input)
      expect(result.isError, JSON.stringify(result.content)).toBeFalsy()
      expect(data<ScriptReview>(result)).toEqual(native)
      expect(native.decision).toBe('review')
      expect(native.reason).toBe('printer_identity_required')
      expect(native.stockVersion).toBeNull()
    } finally {
      await h.client.close()
    }
  })
})
