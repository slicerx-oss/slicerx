// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Model tools' accent colors follow the theme: an edition's accent reaches the origin planes, the material an
// operation adds in its preview, and the soft sketch lines, unless the theme sets them on their own.
import { describe, expect, it } from 'vitest'
import { OpPreviewLook, SketchLayer } from '../src/cadtools'
import { OriginPlanes } from '../src/originplanes'
import { resolveTheme } from '../src/palette'

// what @slicerx/embed's sceneFor gives for the sample lime edition, dark
const LIME = { scene: { bgTop: '#1a1d23', bgBottom: '#0a0c10', bgGlow: '#22262e', plateSide: '#2a2e37', floorGrid: '#4a5363', edgeDark: '#050608', selection: '#b8f34a', liveLayer: '#8be9fd' } }

/** The three pieces, colored the way the view's setTheme colors them. */
function paint(theme?: Parameters<typeof resolveTheme>[0]) {
  const t = resolveTheme(theme)
  const planes = new OriginPlanes()
  const look = new OpPreviewLook()
  const sketch = new SketchLayer()
  planes.setColor(t.scene.originPlane)
  look.setColors(t.scene.addPreview, t.scene.overhangRed, false)
  sketch.setAccent(t.scene.selection)
  return { planes: planes.color(), add: look.colors().add, soft: sketch.accent() }
}

describe('Model tool accents', () => {
  it('stay the SlicerX purple with no theme', () => {
    expect(paint()).toEqual({ planes: '#bd93f9', add: '#bd93f9', soft: '#bd93f9' })
  })

  it('take a lime edition accent in the origin planes, the add preview and the soft sketch lines', () => {
    expect(paint(LIME)).toEqual({ planes: '#b8f34a', add: '#b8f34a', soft: '#b8f34a' })
  })

  it('can be set apart from the selection', () => {
    const t = resolveTheme({ scene: { ...LIME.scene, originPlane: '#4a5363', addPreview: '#7fd4c5' } })
    expect(t.scene.originPlane).toBe('#4a5363')
    expect(t.scene.addPreview).toBe('#7fd4c5')
    expect(t.scene.selection).toBe('#b8f34a')
  })
})
