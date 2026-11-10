// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// sleipnir prints layers of at most half the nozzle: a layer height above that with sleipnir on gets a line, and its
// button turns sleipnir off, the only change made.
import type { EasySettings } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { goalEasy } from '../src/adapters/config'
import { capUnderSlice, sleipnirCapText, turnSleipnirOff } from '../src/plate/sleipnir-cap'
import { plateSliceConfig } from '../src/state/slice-plate'
import { get, set } from '../src/state/store'

// Easy writes sleipnir's thickest layer for the profile's nozzle (0.4 mm here); a 0.6 mm nozzle's profile gives 0.3 mm.
const SIX = { nozzle_diameter: [0.6], smart_layer_max_height: 0.3 }
const standard = () => ({ ...goalEasy('standard'), varyLayerHeight: true })
const setup = (overrides: Record<string, unknown>, easy: EasySettings = standard()) => set({ easy, overrides: overrides as never, calibration: {}, easyTouched: [] })
const sliced = () => plateSliceConfig(get(), get().plates.find((p) => p.id === get().activePlate)) as Record<string, unknown>

describe('the sleipnir layer height line', () => {
  it('names the 0.20 mm cap on a 0.4 mm nozzle and the 0.30 mm cap on a 0.6', () => {
    setup({ layer_height: 0.28, nozzle_diameter: [0.4] })
    expect(sleipnirCapText(get())).toBe('With sleipnir on, layers are at most 0.20 mm, not 0.28 mm.')
    setup({ layer_height: 0.4, ...SIX })
    expect(sleipnirCapText(get())).toBe('With sleipnir on, layers are at most 0.30 mm, not 0.40 mm.')
  })

  it('says nothing at exactly half the nozzle', () => {
    setup({ layer_height: 0.2, nozzle_diameter: [0.4] })
    expect(sleipnirCapText(get())).toBeNull()
    setup({ layer_height: 0.3, ...SIX })
    expect(sleipnirCapText(get())).toBeNull()
  })

  it('says nothing on Draft, which prints fixed layers', () => {
    setup({ layer_height: 0.28, nozzle_diameter: [0.4] }, goalEasy('draft'))
    expect(sliced()['smart_layer']).toBe('off')
    expect(sleipnirCapText(get())).toBeNull()
  })

  it('turns sleipnir off only when asked, keeping the layer height', () => {
    setup({ layer_height: 0.28, nozzle_diameter: [0.4], smart_layer: 'quality' })
    expect(get().easy.varyLayerHeight).toBe(true)
    turnSleipnirOff()
    expect(get().easy.varyLayerHeight).toBe(false)
    expect(get().easyTouched).toContain('varyLayerHeight')
    expect(get().overrides['smart_layer']).toBe('off')
    expect(get().overrides['layer_height']).toBe(0.28)
    expect(sliced()['smart_layer']).toBe('off')
    expect(sliced()['layer_height']).toBe(0.28)
    expect(sleipnirCapText(get())).toBeNull()
  })
})

describe('the line under the Slice plate button', () => {
  it('stays out while the settings are on screen beside it, so the line shows once', () => {
    // the desktop's settings pane open: the line is under Layer height only
    expect(capUnderSlice({ compact: false, sheetOpen: false, paneOpen: true })).toBe(false)
    // a phone with the settings sheet open: the sheet has it under Layer height
    expect(capUnderSlice({ compact: true, sheetOpen: true, paneOpen: true })).toBe(false)
  })

  it('shows while the settings are off screen: a phone with the sheet shut, or the pane shut', () => {
    expect(capUnderSlice({ compact: true, sheetOpen: false, paneOpen: true })).toBe(true)
    expect(capUnderSlice({ compact: false, sheetOpen: false, paneOpen: false })).toBe(true)
  })
})
