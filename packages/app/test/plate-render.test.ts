// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The plate grid's pictures: the objects drawn shaded, so faces turned differently read differently, with a dark edge
// around them, fitted to the picture, and the same plate always gives the same key (it is drawn once and kept).
import { describe, expect, it } from 'vitest'
import type { PlateEntry } from '../src/state/store'
import { plateKey, rasterPlate } from '../src/workspaces/preview/plate-render'

function box(id: string, size: number, at: [number, number], color = '#a0a0a0'): PlateEntry {
  const s = size
  const positions = new Float32Array([0, 0, 0, s, 0, 0, s, s, 0, 0, s, 0, 0, 0, s, s, 0, s, s, s, s, 0, s, s])
  const indices = new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5])
  return { id, name: id, handle: {} as PlateEntry['handle'], parts: [{ name: id, slot: 1, positions, indices }] as unknown as PlateEntry['parts'], colors: [color], transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, at[0], at[1], 0, 1] }
}

const colorsIn = (px: Uint8ClampedArray) => {
  const seen = new Set<string>()
  for (let i = 0; i < px.length; i += 4) if (px[i + 3]) seen.add(`${px[i]},${px[i + 1]},${px[i + 2]}`)
  return seen
}

describe('a plate picture', () => {
  it('is nothing for an empty plate', () => {
    expect(rasterPlate([], 64, 40)).toBeNull()
  })

  it('draws a box shaded: its faces read as different tones, with a darker edge, fitted with room around it', () => {
    const px = rasterPlate([box('a', 20, [50, 50])], 128, 80)!
    expect(px).not.toBeNull()
    const tones = colorsIn(px)
    // Top, front and side are lit differently, and the edge is darker still.
    expect(tones.size).toBeGreaterThanOrEqual(4)
    let opaque = 0
    for (let i = 3; i < px.length; i += 4) if (px[i]) opaque++
    expect(opaque / (128 * 80)).toBeGreaterThan(0.2)
    // The corners stay clear.
    expect(px[3]).toBe(0)
    expect(px[(128 * 80 - 1) * 4 + 3]).toBe(0)
  })

  it('keeps a small part visible beside a big one', () => {
    const px = rasterPlate([box('big', 60, [0, 0]), box('button', 4, [80, 0], '#ff0000')], 128, 80)!
    let red = 0
    for (let i = 0; i < px.length; i += 4) if (px[i + 3] && px[i]! > 2 * px[i + 1]! && px[i]! > 60) red++
    expect(red).toBeGreaterThan(4)
  })

  it('has one key per plate, size, placement and color', () => {
    const a = [box('a', 20, [50, 50])]
    expect(plateKey(a, 256, 160)).toBe(plateKey(a, 256, 160))
    expect(plateKey(a, 256, 160)).not.toBe(plateKey(a, 128, 80))
    expect(plateKey(a, 256, 160)).not.toBe(plateKey([box('a', 20, [60, 50])], 256, 160))
  })
})
