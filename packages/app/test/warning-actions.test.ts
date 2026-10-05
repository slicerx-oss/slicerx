// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { beforeEach, describe, expect, it } from 'vitest'
import type { SliceWarning } from '@slicerx/contracts'
import { fixApplies, jumpToWarning, runWarningFix, warningFix, warningScheme } from '../src/lib/warning-actions'
import { get, set } from '../src/state/store'

const w = (code: SliceWarning['code'], over: Partial<SliceWarning> = {}): SliceWarning => ({ code, message: 'm', ...over })

beforeEach(() => {
  set({ preview: { layerCount: 50 } as never, layerHi: 50, layerLo: 1, colorMode: 'speed', easy: { ...get().easy, supports: 'off' } })
})

describe('slice warning rows', () => {
  it('jumps to the layer (0 based in the warning) and the scheme that shows it', () => {
    jumpToWarning(w('floating_region', { layer: 11 }))
    expect(get().layerHi).toBe(12)
    expect(get().colorMode).toBe('feature')
    jumpToWarning(w('unsupported_setting', { layer: 3, message: 'Volumetric speed capped at 12 mm3/s' }))
    expect(get().colorMode).toBe('flow')
    expect(get().layerHi).toBe(4)
  })

  it('keeps the scheme and layer when the warning has none', () => {
    set({ colorMode: 'speed', layerHi: 20 })
    jumpToWarning(w('safety_limit'))
    expect(get().colorMode).toBe('speed')
    expect(get().layerHi).toBe(20)
  })

  it('offers fixes by code, and none for supports already on', async () => {
    expect(warningFix(w('outside_bed'))?.id).toBe('arrange')
    expect(warningFix(w('open_edges'))).toBeNull()
    expect(warningFix(w('open_edges', { objectId: 'a' }))?.id).toBe('repair')
    expect(warningScheme(w('manual_step'))).toBeNull()
    expect(fixApplies(w('floating_region'))).toBe(true)
    await runWarningFix(w('floating_region'), async () => {})
    expect(get().easy.supports).toBe('auto')
    expect(fixApplies(w('floating_region'))).toBe(false)
  })
})

describe('warning spot', () => {
  it('reads the bed position from the message and asks the camera for it', async () => {
    const { warningSpot } = await import('../src/lib/warning-actions')
    const { setCameraBus } = await import('../src/plate/tools')
    expect(warningSpot(w('floating_region', { message: 'An overhang on layer 4 near X 12.5 Y -3 mm reaches' }))).toEqual({ x: 12.5, y: -3 })
    expect(warningSpot(w('safety_limit', { message: 'Nozzle temperature lowered' }))).toBeNull()
    const calls: unknown[][] = []
    setCameraBus({ focusBedPoint: (...a) => void calls.push(a) })
    set({ preview: { layerCount: 50, layerZ: new Float32Array(50).map((_, i) => 0.2 * (i + 1)) } as never })
    jumpToWarning(w('floating_region', { layer: 4, message: 'near X 10 Y 20 mm' }))
    expect(calls).toEqual([[10, 20, expect.closeTo(1, 5), { animate: true }]])
    setCameraBus(null)
  })
})
