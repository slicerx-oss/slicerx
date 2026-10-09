// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Picking one filament out (hovering its slot in the sidebar): the toolpaths change a uniform only, and the models'
// parts on other slots take a quarter of their color.
import { describe, expect, it } from 'vitest'
import { FEATURE } from '@slicerx/contracts'
import type { InstancedBufferGeometry, Mesh } from 'three'
import { Toolpaths } from '../src/toolpaths'
import { dimHex } from '../src/viewport'
import { buildPreview, type Seg } from './sxpv-fixture'

const seg = (x: number): Seg => ({ a: [x, 0], b: [x + 1, 0], feature: FEATURE.outerWall })
const preview = buildPreview([[seg(0), seg(1)], [seg(2), seg(3)]])

const geometry = (t: Toolpaths) => ((t.root.children.find((c) => (c as Mesh).isMesh && c.name !== 'nozzle') as Mesh).geometry as InstancedBufferGeometry)

describe('filament highlight', () => {
  it('toggles the toolpaths highlight without touching the buffers', () => {
    const t = new Toolpaths()
    t.set(preview)
    const geo = geometry(t)
    const attrs = Object.values(geo.attributes).map((a) => ('data' in a ? (a as { data: { version: number } }).data.version : (a as { version: number }).version))
    expect(t.highlightTool).toBeNull()
    expect(t.setHighlightTool(1)).toBe(true)
    expect(t.highlightTool).toBe(1)
    expect(t.setHighlightTool(1)).toBe(false)
    expect(t.setHighlightTool(null)).toBe(true)
    expect(t.highlightTool).toBeNull()
    expect(t.setHighlightTool(-3)).toBe(false)
    // Same geometry, same attribute versions: nothing was uploaded again.
    expect(geometry(t)).toBe(geo)
    expect(Object.values(geo.attributes).map((a) => ('data' in a ? (a as { data: { version: number } }).data.version : (a as { version: number }).version))).toEqual(attrs)
  })

  it('dims a part color to a quarter', () => {
    expect(dimHex('#ffffff')).toBe('#404040')
    expect(dimHex('#ff8000')).toBe('#402000')
    expect(dimHex('not a color')).toBe('not a color')
  })
})
