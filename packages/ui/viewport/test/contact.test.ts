// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import type { Color, Mesh, ShaderMaterial } from 'three'
import type { LineMaterial } from 'three/addons/lines/LineMaterial.js'
import type { LineSegments2 } from 'three/addons/lines/LineSegments2.js'
import { CONTACT_MIN_MM, CONTACT_STYLE, ContactBox } from '../src/contact'
import { DANGER_EDGE } from '../src/post'

const luminance = (c: Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b

describe('ContactBox', () => {
  it('hatches the struck region in the hit color over the model and toolpaths, edged two-tone, and clears it', () => {
    const c = new ContactBox()
    c.setColor('#ff0000')
    c.set({ min: [10, 20, 5], max: [30, 24, 15] })
    const box = c.root.getObjectByName('contact box')!
    expect(c.root.visible).toBe(true)
    expect(box.position.toArray()).toEqual([20, 22, 10])
    expect(box.scale.toArray()).toEqual([20, 4, 10])
    const fill = box.getObjectByName('contact fill') as Mesh
    const m = fill.material as ShaderMaterial
    // Drawn through the part it sits in, in front of the toolpaths, as stripes of the hit color over a faint wash.
    expect(m.depthTest).toBe(false)
    expect(m.transparent).toBe(true)
    expect((m.uniforms['uColor']!.value as Color).getHexString()).toBe('ff0000')
    expect(m.uniforms['uOn']!.value).toBeGreaterThan(0.5)
    expect(m.uniforms['uOff']!.value).toBeLessThan(0.2)
    // Stripes fixed to the screen, so they never crawl: no time uniform, nothing pulses.
    expect(m.fragmentShader).toContain('gl_FragCoord')
    expect(Object.keys(m.uniforms)).not.toContain('uTime')
    // A light line on a dark halo, both wider than a hair, in front of the stripes.
    const halo = box.getObjectByName('contact halo') as LineSegments2
    const edge = box.getObjectByName('contact edge') as LineSegments2
    const hm = halo.material as LineMaterial
    const em = edge.material as LineMaterial
    expect(luminance(hm.color)).toBeLessThan(0.05)
    expect(luminance(em.color)).toBeGreaterThan(0.8)
    expect(hm.linewidth).toBeGreaterThan(em.linewidth)
    expect(em.linewidth).toBeGreaterThanOrEqual(2)
    expect([hm.depthTest, em.depthTest]).toEqual([false, false])
    expect(fill.renderOrder < halo.renderOrder && halo.renderOrder < edge.renderOrder).toBe(true)
    c.dispose()
  })

  it('keeps its widths in screen pixels on a high density screen', () => {
    const c = new ContactBox()
    c.setResolution(2880, 1800, 2)
    const halo = c.root.getObjectByName('contact halo') as LineSegments2
    const edge = c.root.getObjectByName('contact edge') as LineSegments2
    expect((halo.material as LineMaterial).linewidth).toBe(CONTACT_STYLE.haloPx * 2)
    expect((edge.material as LineMaterial).linewidth).toBe(CONTACT_STYLE.linePx * 2)
    expect((edge.material as LineMaterial).resolution.toArray()).toEqual([2880, 1800])
    const fill = c.root.getObjectByName('contact fill') as Mesh
    expect((fill.material as ShaderMaterial).uniforms['uPeriod']!.value).toBe(CONTACT_STYLE.stripePx * 2)
    c.dispose()
  })

  it('edges the struck part with the same two tones, whatever the theme', () => {
    expect(DANGER_EDGE).toEqual({ line: CONTACT_STYLE.line, halo: CONTACT_STYLE.halo })
  })

  it('gives a region thinner than a line a size that shows, around its middle', () => {
    const c = new ContactBox()
    c.set({ min: [5, 5, 0.2], max: [5, 5, 0.2] })
    const box = c.root.getObjectByName('contact box')!
    expect(box.position.toArray()).toEqual([5, 5, 0.2])
    expect(box.scale.toArray()).toEqual([CONTACT_MIN_MM, CONTACT_MIN_MM, CONTACT_MIN_MM])
    expect(CONTACT_MIN_MM).toBeGreaterThanOrEqual(1)
    c.set(null)
    expect(c.root.visible).toBe(false)
    c.dispose()
  })

  it('recolors its stripes with the theme', () => {
    const c = new ContactBox()
    c.set({ min: [0, 0, 0], max: [1, 1, 1] })
    c.setColor('#00ff00')
    const fill = c.root.getObjectByName('contact fill') as Mesh
    expect(((fill.material as ShaderMaterial).uniforms['uColor']!.value as Color).getHexString()).toBe('00ff00')
    c.dispose()
  })
})
