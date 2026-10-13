// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import type { Line, LineBasicMaterial, Sprite, SpriteMaterial } from 'three'
import { Strikes } from '../src/strikes'

describe('Strikes', () => {
  it('places one strike per mark, the selected one larger, close calls in the warning color', () => {
    const s = new Strikes()
    s.setColors('#ff0000', '#ffaa00')
    s.set([
      { x: 10, y: 20, z: 30 },
      { x: 50, y: 60, z: 5, close: true, selected: true },
    ])
    const [a, b] = s.root.children as Sprite[]
    expect(s.root.children).toHaveLength(2)
    expect(a!.position.toArray()).toEqual([10, 20, 30])
    expect(b!.scale.x).toBeGreaterThan(a!.scale.x)
    expect(b!.name).toBe('strike selected')
    // Drawn over the toolpaths at a fixed size on screen.
    const m = a!.material as SpriteMaterial
    expect(m.depthTest).toBe(false)
    expect(m.sizeAttenuation).toBe(false)
    expect(b!.material).not.toBe(a!.material)
    s.set(null)
    expect(s.root.children).toHaveLength(0)
    s.dispose()
  })

  it('outlines an area in the hit color over a faint wash, keeps it when marks change, and clears it', () => {
    const s = new Strikes()
    s.setColors('#ff0000', '#ffaa00')
    s.setArea([[15, 5], [25, 5], [25, 15], [15, 15]], 0.4)
    const area = s.root.getObjectByName('strike area')!
    expect(area.children.map((c) => c.type)).toEqual(['Mesh', 'Line', 'Line', 'Line'])
    const line = area.children[2] as Line
    // Four corners and the closing point, over the toolpaths like the marks.
    expect(line.geometry.getAttribute('position').count).toBe(5)
    expect((line.material as LineBasicMaterial).depthTest).toBe(false)
    expect((line.material as LineBasicMaterial).color.getHexString()).toBe('ff0000')
    s.set([{ x: 20, y: 10, z: 0.4, selected: true }])
    expect(s.root.getObjectByName('strike area')).toBe(area)
    expect(s.root.children).toHaveLength(2)
    s.setArea(null)
    expect(s.root.getObjectByName('strike area')).toBeUndefined()
    s.dispose()
  })
})
