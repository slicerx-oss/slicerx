// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The .vp backdrop (app.css) shows until the 3D view's first frame, which then covers it. It has to be the picture the
// view's grade pass draws behind the plate (@slicerx/viewport post.ts, with the look's backdrop from look.ts), or the
// first frame lands with a visible step. These tests pin the shader's backdrop math, derive the CSS from it and the
// looks, and check that the CSS, as a browser composites it, stays within one 8-bit level of the shader everywhere.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DARK_PRECISION_LOOK, LIGHT_STUDIO_LOOK, SCENE, type ViewportLook } from '@slicerx/viewport'

const css = readFileSync(join(import.meta.dirname, '../src/styles/app.css'), 'utf8')
const shader = readFileSync(join(import.meta.dirname, '../../ui/viewport/src/post.ts'), 'utf8')

// The grade pass's backdrop: a bottom to top blend, a glow around (0.5, 0.58) whose radius is 0.85 of the height,
// gamma 2.2 into linear, sRGB out, then the vignette. These lines are what the CSS below is derived from.
const SHADER_LINES = [
  'vec2 q = vec2((vUv.x - 0.5) * aspect, vUv.y - 0.58);',
  'vec3 bg = mix(bgBot, bgTop, smoothstep(0.0, 1.0, vUv.y));',
  'bg = mix(bg, bgGlow, (1.0 - smoothstep(0.0, 0.85, length(q))) * glowK);',
  'vec3 lin = col + pow(bg, vec3(2.2)) * (1.0 - a);',
  'vec2 v = vUv - 0.5;',
  'o *= mix(1.0, 1.0 - dot(v, v) * vigK, mix(1.0 - a, 1.0, vigModel));',
]
const GLOW_Y = 0.58
const GLOW_R = 0.85
const STEPS = 8

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1)
  return t * t * (3 - 2 * t)
}
const toSrgb = (c: number) => {
  const x = Math.min(Math.max(c, 0), 1)
  return x < 0.0031308 ? x * 12.92 : 1.055 * x ** (1 / 2.4) - 0.055
}
const rgb01 = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
/** A backdrop color as the grade pass writes it with nothing in front: gamma 2.2 in, sRGB out. */
const transfer = (hex: string) => '#' + rgb01(hex).map((c) => Math.round(toSrgb(c ** 2.2) * 255).toString(16).padStart(2, '0')).join('')
const num = (x: number) => String(Number(x.toFixed(3)))

/** The background-image the .vp rule must have, built from the shader's constants. */
function expectedLayers(): string {
  const vig = Array.from({ length: STEPS + 1 }, (_, i) => {
    const t = (Math.SQRT2 * i) / STEPS // the ellipse's radius is half the box, so the corners sit at sqrt 2
    return i === 0 ? '#fff 0%' : `color-mix(in srgb, #000 calc(var(--vp-vignette) * ${num(25 * t * t)}%), #fff) ${num(t * 100)}%`
  })
  const closest = 1 - GLOW_Y // the circle's closest side is the top edge, 42% down
  const glow = Array.from({ length: STEPS + 1 }, (_, i) => {
    const r = (GLOW_R * i) / STEPS
    const at = `${num((r / closest) * 100)}%`
    return i === STEPS ? `transparent ${at}` : `color-mix(in srgb, var(--vp-glow) calc(var(--vp-glow-k) * ${num((1 - smooth(0, GLOW_R, r)) * 100)}%), transparent) ${at}`
  })
  const vert = Array.from({ length: STEPS + 1 }, (_, i) => {
    const at = `${num((i / STEPS) * 100)}%`
    if (i === 0) return `var(--vp-bottom) ${at}`
    if (i === STEPS) return `var(--vp-top) ${at}`
    return `color-mix(in srgb, var(--vp-top) ${num(smooth(0, 1, i / STEPS) * 100)}%, var(--vp-bottom)) ${at}`
  })
  return [
    `radial-gradient(50% 50% at 50% 50%, ${vig.join(', ')})`,
    `radial-gradient(circle closest-side at 50% ${num(closest * 100)}%, ${glow.join(', ')})`,
    `linear-gradient(to top, ${vert.join(', ')})`,
  ].join(', ')
}

/** The declarations of the first rule with exactly this selector. */
function block(selector: string): Record<string, string> {
  const start = css.indexOf(`\n${selector} {\n`)
  if (start < 0) return {}
  const body = css.slice(start + selector.length + 4, css.indexOf('\n}', start))
  const out: Record<string, string> = {}
  for (const decl of body.split(/;\s*(?=--|[a-z-]+:)/)) {
    const i = decl.indexOf(':')
    if (i > 0) out[decl.slice(0, i).trim()] = decl.slice(i + 1).replace(/;\s*$/, '').replace(/\s+/g, ' ').replace(/\( /g, '(').trim()
  }
  return out
}

const LOOKS: [string, string, ViewportLook][] = [
  ['dark', '.vp', DARK_PRECISION_LOOK],
  ['light', ':root[data-scheme="light"] .vp', LIGHT_STUDIO_LOOK],
]

describe('the .vp backdrop before the first 3D frame', () => {
  it('follows the grade pass backdrop math it was derived from', () => {
    // A change here changes what the view draws behind the plate: update expectedLayers and app.css with it.
    for (const line of SHADER_LINES) expect(shader).toContain(line)
  })

  it('draws the shader backdrop as three layers, the vignette multiplied over the glow and the blend', () => {
    // on .vp, and on its stage, which is where the canvas sits (on a phone it fills only some of .vp's rows)
    const vp = block('.vp, .vp-stage')
    expect(vp['background-image']).toBe(expectedLayers())
    expect(vp['background-size']).toBe('100% 100%, 300% 100%, 100% 100%')
    expect(vp['background-position']).toBe('50% 50%')
    expect(vp['background-repeat']).toBe('no-repeat')
    expect(vp['background-blend-mode']).toBe('multiply, normal, normal')
  })

  it.each(LOOKS)('takes the %s look\'s backdrop colors through the grade pass\'s transfer', (_scheme, selector, look) => {
    const b = look.backdrop
    expect(b.top && b.bottom && b.center).toBeTruthy()
    expect(block(selector)).toMatchObject({
      '--vp-top': transfer(b.top!),
      '--vp-bottom': transfer(b.bottom!),
      '--vp-glow': transfer(b.center!),
      '--vp-glow-k': String(b.centerStrength),
      '--vp-vignette': String(b.vignette),
    })
  })

  it('gives another theme its own studio colors, with the same transfer and the view\'s default colors as fallbacks', () => {
    const rule = css.slice(css.indexOf('@supports (color: rgb(from'), css.indexOf('\n}\n', css.indexOf('@supports (color: rgb(from')))
    const ch = (c: string) => `calc(max(0, 1.055 * pow(${c} / 255, 2.2 / 2.4) - 0.055) * 255)`
    for (const [name, scene, fallback] of [['--vp-top', '--scene-top', SCENE.bgTop], ['--vp-bottom', '--scene-bottom', SCENE.bgBottom], ['--vp-glow', '--scene-glow', SCENE.bgGlow]]) {
      expect(rule).toContain(`${name}: rgb(from var(${scene}, ${fallback}) ${ch('r')} ${ch('g')} ${ch('b')});`)
    }
    expect(rule).toContain(':not([data-sx-theme="subban"], [data-sx-theme="subban-dark"], [data-sx-theme="subban-light"]) .vp')
  })

  // How a browser paints the CSS: each gradient interpolates linearly between its stops in sRGB, the glow is laid over
  // the blend with its alpha, and the vignette multiplies the result. Compared with the shader at every point.
  const lerpStops = (stops: [number, number][], x: number) => {
    if (x <= stops[0]![0]) return stops[0]![1]
    for (let i = 1; i < stops.length; i++) {
      const [x1, y1] = stops[i]!
      const [x0, y0] = stops[i - 1]!
      if (x <= x1) return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0)
    }
    return stops[stops.length - 1]![1]
  }
  const grid = Array.from({ length: STEPS + 1 }, (_, i) => i / STEPS)
  const vertStops = grid.map((p): [number, number] => [p, smooth(0, 1, p)])
  const glowStops = grid.map((p): [number, number] => [GLOW_R * p, 1 - smooth(0, GLOW_R, GLOW_R * p)])
  const vigStops = grid.map((p): [number, number] => [Math.SQRT2 * p, (Math.SQRT2 * p) ** 2 / 4])

  it.each(LOOKS)('stays within one level of the shader across the %s view, at any shape', (_scheme, selector, look) => {
    const b = look.backdrop
    const vars = block(selector)
    type Rgb = number[]
    const [T, B, G] = [b.top!, b.bottom!, b.center!].map(rgb01) as [Rgb, Rgb, Rgb]
    const [cT, cB, cG] = [vars['--vp-top']!, vars['--vp-bottom']!, vars['--vp-glow']!].map(rgb01) as [Rgb, Rgb, Rgb]
    let worst = 0
    for (const aspect of [0.6, 1, 1.21, 1.6, 2.4]) {
      for (let iy = 0; iy <= 40; iy++) {
        for (let ix = 0; ix <= 40; ix++) {
          const u = ix / 40
          const v = iy / 40 // up from the bottom, as vUv
          const r = Math.hypot((u - 0.5) * aspect, v - GLOW_Y)
          const d = (u - 0.5) ** 2 + (v - 0.5) ** 2
          for (let c = 0; c < 3; c++) {
            const s = smooth(0, 1, v)
            const blend = B[c]! + (T[c]! - B[c]!) * s
            const lit = blend + (G[c]! - blend) * (1 - smooth(0, GLOW_R, r)) * b.centerStrength
            const want = toSrgb(lit ** 2.2) * (1 - d * b.vignette)
            const cblend = cB[c]! + (cT[c]! - cB[c]!) * lerpStops(vertStops, v)
            // the ellipse radius is half the box on each axis, so its parameter is twice the distance in box units
            const clit = cblend + (cG[c]! - cblend) * lerpStops(glowStops, r) * b.centerStrength
            const got = clit * (1 - b.vignette * lerpStops(vigStops, 2 * Math.sqrt(d)))
            worst = Math.max(worst, Math.abs(got - want) * 255)
          }
        }
      }
    }
    expect(worst).toBeLessThan(1)
  })
})
