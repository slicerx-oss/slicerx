// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Every move, rotate and scale handle reads on whatever is behind it: 3:1 for graphical objects (WCAG 2.2, non-text
// contrast). A handle passes on its own fill or on the near black outline drawn under it, and every handle color is at
// least 9:1 off the outline, so one of the two clears 3:1 against any color at all. The beds the view draws (each
// bundled theme's studio, the bare bed's faint fill, each plate surface lit and in a part's shadow) are checked by name
// as well, so a failure says where it shows.
import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DARK_PRECISION_LOOK, LIGHT_STUDIO_LOOK } from '../src/look'
import { SCENE, hexToRgb, mixHex, srgbToLinear, type HandleColors } from '../src/palette'
import { PLATE_SURFACES } from '../src/stage'

const MIN = 3
/**
 * How the studio draws a plate surface against its base color, measured on screen: 0.88 (cool) to 1.07 (textured PEI)
 * in the lit studio, and down to about 0.5 in the contact shadow under a part, where the scale handles sit.
 */
const LIT = [0.5, 0.88, 1, 1.1]
/** The bare bed's fill: the grid color laid over the backdrop at this strength at most (stage.ts, PLATE_OUTLINE_FS). */
const BED_FILL = 0.07

const lum = (hex: string) => {
  const [r, g, b] = hexToRgb(hex).map(srgbToLinear) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrast = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)]
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}
const scaled = (hex: string, k: number) => `#${hexToRgb(hex).map((v) => Math.min(255, Math.round(v * k)).toString(16).padStart(2, '0')).join('')}`
const hue = (hex: string) => {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255) as [number, number, number]
  const max = Math.max(r, g, b)
  const d = max - Math.min(r, g, b)
  if (d === 0) return { h: 0, s: 0 }
  const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return { h: h * 60, s: d / max }
}
/** The better of a handle's fill and its outline against `bg`. */
const reads = (fill: string, bg: string) => Math.max(contrast(fill, bg), contrast(SCENE.handleHalo, bg))

interface Studio { name: string; top: string; bottom: string; glow: string; grid: string }

/** The Subban studios come from the look presets; every other bundled theme keeps its own scene block. */
function studios(): Studio[] {
  const dir = new URL('../../themes/', import.meta.url)
  const out: Studio[] = []
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json') || f === 'schema.json') continue
    const t = JSON.parse(readFileSync(new URL(f, dir), 'utf8')) as { id: string; isDark: boolean; scene: { top: string; bottom: string; glow: string; grid: string } }
    const preset = t.id.startsWith('subban') ? (t.isDark ? DARK_PRECISION_LOOK : LIGHT_STUDIO_LOOK).backdrop : null
    out.push({ name: t.id, top: preset?.top ?? t.scene.top, bottom: preset?.bottom ?? t.scene.bottom, glow: preset?.center ?? t.scene.glow, grid: t.scene.grid })
  }
  return out
}

function beds(s: Studio): Record<string, string> {
  const out: Record<string, string> = { top: s.top, bottom: s.bottom, glow: s.glow }
  for (const k of ['top', 'bottom'] as const) out[`bed fill over ${k}`] = mixHex(s[k], s.grid, BED_FILL)
  for (const [name, p] of Object.entries(PLATE_SURFACES)) for (const k of LIT) out[`${name} x${k}`] = scaled(p.color, k)
  return out
}

/** Every color a handle shows at rest, hovered or dragged, or pinned. Scale stems take their handle's color. */
const handles = (c: HandleColors): Record<string, string> => ({ 'x axis': c.axisX, 'y axis': c.axisY, 'z axis': c.axisZ, uniform: c.axisUniform, hot: c.handleHot, pinned: c.handlePinned })

describe('handle contrast', () => {
  const all = studios()

  it('covers both schemes of the bundled themes', () => {
    expect(all.some((s) => s.name === 'subban-dark')).toBe(true)
    expect(all.some((s) => s.name === 'subban-light')).toBe(true)
    expect(all.length).toBeGreaterThanOrEqual(20)
  })

  it('every handle keeps 3:1 against every bed of every bundled theme, on its fill or its outline', () => {
    const fails: string[] = []
    for (const s of all) for (const [bed, bg] of Object.entries(beds(s))) for (const [h, fill] of Object.entries(handles(SCENE))) {
      const best = reads(fill, bg)
      if (best < MIN) fails.push(`${s.name} ${bed} ${bg}: ${h} ${fill} ${best.toFixed(2)}`)
    }
    expect(fails).toEqual([])
  })

  it('every handle color is 9:1 off the outline, so it keeps 3:1 against any color, every gray from black to white included', () => {
    for (const [h, fill] of Object.entries(handles(SCENE))) {
      expect(contrast(fill, SCENE.handleHalo), h).toBeGreaterThanOrEqual(MIN * MIN)
      // contrast depends on luminance alone, and the grays run through every luminance a color can have
      for (let v = 0; v <= 255; v++) {
        const gray = `#${v.toString(16).padStart(2, '0').repeat(3)}`
        expect(reads(fill, gray), `${h} on ${gray}`).toBeGreaterThanOrEqual(MIN)
      }
    }
  })

  it('keeps X red, Y green and Z blue', () => {
    const h = (c: string) => hue(c).h
    expect(h(SCENE.axisX) < 15 || h(SCENE.axisX) > 345).toBe(true)
    expect(h(SCENE.axisY)).toBeGreaterThan(100)
    expect(h(SCENE.axisY)).toBeLessThan(150)
    expect(h(SCENE.axisZ)).toBeGreaterThan(195)
    expect(h(SCENE.axisZ)).toBeLessThan(230)
  })

  it('a hovered or dragged handle stays apart from every handle at rest, and a pinned one from both', () => {
    const hot = hue(SCENE.handleHot)
    for (const c of [SCENE.axisX, SCENE.axisY, SCENE.axisZ, SCENE.axisUniform]) {
      const d = Math.abs(hue(c).h - hot.h) % 360
      expect(Math.min(d, 360 - d), c).toBeGreaterThanOrEqual(40)
    }
    // the pinned handle is the one gray among saturated colors
    expect(hue(SCENE.handlePinned).s).toBeLessThan(0.1)
    for (const c of [SCENE.axisX, SCENE.axisY, SCENE.axisZ, SCENE.axisUniform, SCENE.handleHot]) expect(hue(c).s, c).toBeGreaterThan(0.4)
  })
})
