// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import type { PrintConfig } from '@slicerx/contracts/settings'
import { EASY_GOALS, SMART_LAYER_LABELS } from '@slicerx/contracts/settings'
import { applyEasy, goalEasy, matchGoal } from './easy'
import { settingDef } from './schema'
import { isSmartLayerOn, smartLayerBounds, smartLayerLimits, smartLayerWindow } from './smartlayer'
import { validate } from './validate'

const research = { smartLayer: { minRatio: 0.2, maxRatio: 0.6, note: 'silk shows steps', src: ['x'] } }

describe('sleipnir window', () => {
  it('is a quarter to three quarters of the nozzle on the layer step grid', () => {
    expect(smartLayerWindow(0.4)).toEqual({ min: 0.1, max: 0.3 })
    expect(smartLayerWindow(0.6)).toEqual({ min: 0.16, max: 0.44 })
    expect(smartLayerWindow(0.2)).toEqual({ min: 0.06, max: 0.14 })
  })
  it('follows the material research when there is some', () => {
    expect(smartLayerWindow(0.4, research)).toEqual({ min: 0.08, max: 0.24 })
    expect(smartLayerLimits(research)).toMatchObject({ minRatio: 0.2, maxRatio: 0.6, note: 'silk shows steps' })
    expect(smartLayerLimits()).toMatchObject({ minRatio: 0.25, maxRatio: 0.75, src: [] })
  })
  it('puts the bounds around the layer height the Detail slider gives', () => {
    expect(smartLayerBounds({ nozzleDiameter: 0.4 })).toEqual({ min: 0.1, max: 0.3 })
    expect(smartLayerBounds({ nozzleDiameter: 0.4, layerHeight: 0.12 })).toEqual({ min: 0.1, max: 0.18 })
    expect(smartLayerBounds({ nozzleDiameter: 0.4, layerHeight: 0.08 })).toEqual({ min: 0.1, max: 0.12 })
    expect(smartLayerBounds({ nozzleDiameter: 0.4, layerHeight: 0.28 })).toEqual({ min: 0.14, max: 0.3 })
  })
  it('gives each mode its own band, and the material narrows it', () => {
    expect(smartLayerWindow(0.4, undefined, 'quality')).toEqual({ min: 0.08, max: 0.2 })
    expect(smartLayerWindow(0.4, undefined, 'strength')).toEqual({ min: 0.12, max: 0.2 })
    expect(smartLayerWindow(0.6, undefined, 'quality')).toEqual({ min: 0.12, max: 0.3 })
    expect(smartLayerBounds({ nozzleDiameter: 0.4, layerHeight: 0.28, mode: 'strength' })).toEqual({ min: 0.14, max: 0.2 })
    expect(smartLayerLimits({ smartLayer: { minRatio: 0.4, maxRatio: 0.7, src: [] } }, 'quality')).toMatchObject({ minRatio: 0.4, maxRatio: 0.5 })
    expect(smartLayerLimits({ smartLayer: { modes: { strength: { minRatio: 0.35, maxRatio: 0.45 } }, src: [] } }, 'strength')).toMatchObject({ minRatio: 0.35, maxRatio: 0.45 })
    // No overlap with the mode band: the material's window wins.
    expect(smartLayerLimits({ smartLayer: { minRatio: 0.6, maxRatio: 0.7, src: [] } }, 'strength')).toMatchObject({ minRatio: 0.6, maxRatio: 0.7 })
    expect(smartLayerLimits(undefined, 'quality')).toMatchObject({ minRatio: 0.2, maxRatio: 0.5 })
  })
  it('knows the modes', () => {
    expect(isSmartLayerOn('quality') && isSmartLayerOn('strength')).toBe(true)
    expect(isSmartLayerOn('off')).toBe(false)
    expect(SMART_LAYER_LABELS.quality).toBe('sleipnir: Quality')
    expect(settingDef('smart_layer')?.enumLabels).toEqual(['Off', 'sleipnir: Quality', 'sleipnir: Strength'])
    expect(settingDef('smart_layer')?.label).toBe('sleipnir')
  })
})

describe('sleipnir in Easy mode', () => {
  const base = { nozzle_diameter: [0.4], layer_height: 0.2 } as unknown as PrintConfig
  it('is on for every goal but Draft: Quality for Standard and Fine, Strength for Strong', () => {
    expect(EASY_GOALS.fine.varyLayerHeight).toBe(true)
    expect(EASY_GOALS.strong.varyLayerHeight).toBe(true)
    expect(EASY_GOALS.draft.varyLayerHeight).toBe(false)
    expect(EASY_GOALS.standard.varyLayerHeight).toBe(true)
    expect(applyEasy(goalEasy('fine'), base)['smart_layer']).toBe('quality')
    expect(applyEasy(goalEasy('strong'), base)['smart_layer']).toBe('strength')
    expect('smart_layer_min_height' in applyEasy(goalEasy('draft'), base)).toBe(false)
    expect(applyEasy(goalEasy('standard'), base)['smart_layer']).toBe('quality')
  })
  it('lets the Detail slider set the bounds, always inside the window', () => {
    const at = (detail: number) => {
      const out = applyEasy({ ...goalEasy('fine'), detail }, base)
      return [out['smart_layer_min_height'], out['smart_layer_max_height']]
    }
    expect(at(0)).toEqual([0.18, 0.2])
    expect(at(40)).toEqual([0.15, 0.2])
    expect(at(80)).toEqual([0.09, 0.18])
    expect(at(100)).toEqual([0.08, 0.12])
  })
  it('produces bounds that validate cleanly, for any detail and nozzle', () => {
    for (const nozzle of [0.2, 0.4, 0.6, 0.8]) {
      for (let detail = 0; detail <= 100; detail += 10) {
        const cfg = { nozzle_diameter: [nozzle], layer_height: 0.2 } as unknown as PrintConfig
        const out = applyEasy({ ...goalEasy('strong'), detail }, cfg)
        const issues = validate(out).filter((i) => i.code.startsWith('smart_layer_min') || i.code.startsWith('smart_layer_max') || i.code === 'smart_layer_bounds_order')
        expect(issues, `${nozzle} at ${detail}`).toEqual([])
      }
    }
  })
  it('counts sleipnir when matching a goal', () => {
    expect(matchGoal(goalEasy('fine'))).toBe('fine')
    expect(matchGoal({ ...goalEasy('fine'), varyLayerHeight: false })).toBeNull()
    expect(matchGoal({ detail: 0, strength: 10, speed: 'sport', supports: 'auto', brim: true, smartLayer: 'off' })).toBe('draft')
  })
})
