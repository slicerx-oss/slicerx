// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { COVER_COLORS, COVER_PROFILE, coverColor, coverLabels, mmLabel, renderCover, type CoverImage, type CoverMesh } from '../src/export/cover'
import { boxMesh } from '../src/plate/mesh-ops'

const box = (x: number, y: number, z: number, color = '#ff79c6'): CoverMesh => ({ ...boxMesh(x, y, z), color })

/** The same box as triangle soup, the way an STL arrives. */
function soup(m: CoverMesh): CoverMesh {
  const positions = new Float32Array(m.indices.length * 3)
  for (let i = 0; i < m.indices.length; i++) for (let k = 0; k < 3; k++) positions[i * 3 + k] = m.positions[(m.indices[i] ?? 0) * 3 + k] ?? 0
  return { positions, indices: Uint32Array.from({ length: m.indices.length }, (_, i) => i), color: m.color }
}

const px = (img: CoverImage, x: number, y: number) => Array.from(img.rgba.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 3))

/** Bounds of the pixels close to a color. */
function bounds(img: CoverImage, rgb: readonly number[], tol = 24) {
  let x0 = Infinity
  let x1 = -Infinity
  let y0 = Infinity
  let y1 = -Infinity
  let n = 0
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const o = (y * img.width + x) * 4
      if (Math.abs(img.rgba[o]! - rgb[0]!) + Math.abs(img.rgba[o + 1]! - rgb[1]!) + Math.abs(img.rgba[o + 2]! - rgb[2]!) > tol) continue
      n++
      x0 = Math.min(x0, x)
      x1 = Math.max(x1, x)
      y0 = Math.min(y0, y)
      y1 = Math.max(y1, y)
    }
  }
  return { x0, x1, y0, y1, n }
}

const INK = [0xf8, 0xf8, 0xf2]
const DIM = [0xbd, 0x93, 0xf9]
const PAPER = [0x26, 0x28, 0x33]

describe('shop drawing cover', () => {
  it('is the same picture every time', () => {
    const a = renderCover([box(30, 20, 10)], 200, 150)
    const b = renderCover([box(30, 20, 10)], 200, 150)
    expect(a.width).toBe(200)
    expect(a.height).toBe(150)
    expect(Buffer.from(a.rgba).equals(Buffer.from(b.rgba))).toBe(true)
  })

  it('fits every part to the same frame, whatever its size', () => {
    const W = 400
    const H = 300
    const small = bounds(renderCover([box(20, 20, 20)], W, H), INK)
    const big = bounds(renderCover([box(200, 200, 200)], W, H), INK)
    for (const k of ['x0', 'x1', 'y0', 'y1'] as const) expect(Math.abs(small[k] - big[k])).toBeLessThanOrEqual(2)
    // the outline fills the fit share on its tighter side, centered across, base at the base line
    const fill = Math.max((small.x1 - small.x0) / (W * COVER_PROFILE.fitWidth), (small.y1 - small.y0) / (H * COVER_PROFILE.fitHeight))
    expect(fill).toBeGreaterThan(0.97)
    expect(fill).toBeLessThan(1.04)
    expect(Math.abs((small.x0 + small.x1) / 2 - W / 2)).toBeLessThanOrEqual(2)
    expect(Math.abs(small.y1 - H * COVER_PROFILE.base)).toBeLessThanOrEqual(3)
  })

  it('places a model by its transform', () => {
    const at = { ...box(20, 20, 20), transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 128, 128, 0, 1] }
    expect(Buffer.from(renderCover([at], 160, 120).rgba).equals(Buffer.from(renderCover([box(20, 20, 20)], 160, 120).rgba))).toBe(true)
  })

  it('draws an STL triangle soup like the indexed mesh', () => {
    const indexed = renderCover([box(30, 20, 10)], 200, 150)
    const loose = renderCover([soup(box(30, 20, 10))], 200, 150)
    expect(Buffer.from(loose.rgba).equals(Buffer.from(indexed.rgba))).toBe(true)
  })

  it('labels width, depth and height in mm', () => {
    expect(coverLabels([20, 30, 5.55])).toEqual(['20 mm', '30 mm', '5.6 mm'])
    expect(coverLabels([170, 170, 0.2])).toEqual(['170 mm', '170 mm'])
    expect(mmLabel(9.96)).toBe('10')
    expect(mmLabel(12.4)).toBe('12')
    // the dimension color shows up below the part and to its left, where the labels sit
    const img = renderCover([box(20, 20, 20)], 400, 300)
    const ink = bounds(img, INK)
    const dim = bounds(img, DIM, 40)
    expect(dim.n).toBeGreaterThan(150)
    expect(dim.x0).toBeLessThan(ink.x0)
    expect(dim.y1).toBeGreaterThan(ink.y1)
    // a longer label draws more strokes
    const short = bounds(renderCover([box(8, 8, 8)], 400, 300), DIM, 40).n
    const long = bounds(renderCover([box(188, 188, 188)], 400, 300), DIM, 40).n
    expect(long).toBeGreaterThan(short)
  })

  it('fills each part in its own filament color, or the slot fallback when the file has none', () => {
    expect(coverColor('#8BE9FD')).toBe('#8be9fd')
    expect(coverColor('#50fa7bff')).toBe('#50fa7b')
    expect(coverColor('', 1)).toBe(COVER_COLORS[0])
    expect(coverColor(undefined, 2)).toBe(COVER_COLORS[1])
    // the middle of the top face: a cyan part reads blue, an orange part reads warm
    const top = (img: CoverImage) => px(img, 200, Math.round(img.height * 0.4))
    const cyan = top(renderCover([box(20, 20, 20, '#8be9fd')], 400, 300))
    const orange = top(renderCover([box(20, 20, 20, '#fab570')], 400, 300))
    expect(cyan[2]!).toBeGreaterThan(cyan[0]! + 20)
    expect(orange[0]!).toBeGreaterThan(orange[2]! + 5)
    // see-through: the fill is the color washed into the ground, not the color itself
    expect(cyan[2]!).toBeLessThan(0xfd - 60)
    // no color: slot 2 takes the second fallback, so a two-color print keeps two fills
    const fallback = top(renderCover([{ ...box(20, 20, 20), color: '', slot: 2 }], 400, 300))
    expect(fallback).toEqual(top(renderCover([box(20, 20, 20, COVER_COLORS[1])], 400, 300)))
    const two = renderCover([{ ...box(40, 20, 4), color: '' }, { ...box(10, 10, 30), color: '', slot: 2, transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 4, 1] }], 400, 300)
    const base = px(two, 130, Math.round(two.height * 0.66))
    const post = px(two, 200, Math.round(two.height * 0.4))
    expect(base).not.toEqual(post)
  })

  it('draws the ground alone for empty input and has a light ground', () => {
    const empty = renderCover([], 80, 60)
    expect(px(empty, 0, 0)).toEqual(PAPER)
    expect(bounds(empty, INK).n).toBe(0)
    const light = renderCover([box(20, 20, 20)], 80, 60, { theme: 'light' })
    expect(px(light, 0, 0)).toEqual([0xf7, 0xf6, 0xf3])
  })
})
