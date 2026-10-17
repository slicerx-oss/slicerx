// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import type { ScriptReview } from '@slicerx/contracts'
import { connect, data, noSx, sxBin, sxTimeout } from './helpers'
import { createSxSlicer } from '../src/sx'

describe.skipIf(noSx())('shared native script review', { timeout: sxTimeout }, () => {
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
