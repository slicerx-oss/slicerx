// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { afterEach, describe, expect, it } from 'vitest'
import { MAIN_BRUSHES, MORE_BRUSHES } from '../src/workspaces/prepare/paint-panel'
import { viewportTheme } from '../src/viewport/scene-theme'
import { featureStyle } from '../src/workspaces/preview/preview-hud'
import { FEATURE } from '@slicerx/contracts'
import { get, set } from '../src/state/store'

afterEach(() => set({ appearance: { ...get().appearance, colorVision: 'standard' } }))

describe('paint brushes', () => {
  it('puts Brush, Fill and Height up front and the rest behind More', () => {
    expect(MAIN_BRUSHES.map((b) => b.label)).toEqual(['Brush', 'Fill', 'Height'])
    expect(MORE_BRUSHES.map((b) => b.value)).toEqual(['triangle', 'gap'])
  })
})

describe('toolpath palette', () => {
  it('standard leaves the viewport theme alone, color-blind swaps features, ramp and overhang colors', () => {
    const el = document.createElement('div')
    expect(viewportTheme('standard', el)?.features).toBeUndefined()
    const t = viewportTheme('colorblind', el)!
    expect(t.features?.[FEATURE.outerWall]).toBe('#e69f00')
    expect(t.scene?.overhangRed).toBe('#d55e00')
    expect(t.heatRamp).toHaveLength(5)
  })

  it('the legend follows the picked palette', () => {
    const std = featureStyle(FEATURE.sparseInfill).color
    set({ appearance: { ...get().appearance, colorVision: 'blueyellow' } })
    expect(featureStyle(FEATURE.sparseInfill).color).not.toBe(std)
    set({ appearance: { ...get().appearance, colorVision: 'redgreen' } })
    expect(featureStyle(FEATURE.sparseInfill).color).not.toBe(std)
  })
})
