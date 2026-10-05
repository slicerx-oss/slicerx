// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Builds the credit kit's badges and button into docs/integrators/credit-kit: "Made possible by
// SlicerX" in three heights and a "Support SlicerX" button, each on dark and on light, as outlined
// SVG plus PNG at 1x and 2x. Run through ./build.sh, or alone with `node credit.mjs`.
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CUTS, GROUND, INK, PALETTE, TEXT, svgDoc } from './geometry.mjs'
import { fonts, lockup, textPath } from './text.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const sharp = createRequire(import.meta.url)(join(here, '.cache/node_modules/sharp'))
const kit = join(here, '../../../docs/integrators/credit-kit')
const r2 = (v) => +v.toFixed(2)

// cap height of a font as a share of its size, from the H
const capOf = (font) => font.charToGlyph('H').getBoundingBox().y2 / font.unitsPerEm

const THEMES = {
  dark: { bg: GROUND.dark, line: INK.line, word: TEXT.dark, muted: TEXT.muted, palette: PALETTE.dark, accent: '#bd93f9', heart: PALETTE.dark.b },
  light: { bg: GROUND.light, line: '#d6d8e6', word: TEXT.light, muted: TEXT.mutedLight, palette: PALETTE.light, accent: '#6b3fc4', heart: PALETTE.light.b },
}

// heights 20, 32 and 48 px. The X is under 24 px tall in all of them, so the small two take the
// tab cut and the large one the small cut.
const BADGES = {
  small: { h: 20, r: 3, pad: 7, text: 11, font: 'bodyBold', word: 12, gap: 5, cut: CUTS.tab },
  medium: { h: 32, r: 6, pad: 12, text: 15, font: 'body', word: 17.5, gap: 8, cut: CUTS.tab },
  large: { h: 48, r: 10, pad: 18, text: 21, font: 'body', word: 26, gap: 11, cut: CUTS.small },
}

/** A line of type with its visible left edge at x and its cap height centered on y. */
function line(font, str, size, x, y, tracking = 0) {
  const probe = textPath(font, str, size, 0, 0, tracking)
  const t = textPath(font, str, size, x - probe.box.x1, y + (capOf(font) * size) / 2, tracking)
  return { d: t.d, w: probe.box.x2 - probe.box.x1 }
}

/** The lockup with its visible left edge at x and its cap height centered on y. */
function word(theme, size, cut, uid, x, y) {
  const l = lockup({ size, ink: theme.word, palette: theme.palette, cut, uid })
  return { defs: l.defs, content: `<g transform="translate(${r2(x - l.x)} ${r2(y + l.cap / 2)})">${l.content}</g>`, w: l.w }
}

function plate(W, H, r, theme, stroke = theme.line, opacity = 1) {
  return `<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="${r - 0.5}" fill="${theme.bg}" stroke="${stroke}" stroke-opacity="${opacity}"/>`
}

function badge(spec, theme) {
  const font = fonts[spec.font]
  const cy = spec.h / 2
  const t = line(font, 'Made possible by', spec.text, spec.pad, cy, 0.005)
  const l = word(theme, spec.word, spec.cut, 'c', spec.pad + t.w + spec.gap, cy)
  const W = Math.ceil(spec.pad * 2 + t.w + spec.gap + l.w)
  const body = plate(W, spec.h, spec.r, theme) + `<path fill="${theme.muted}" d="${t.d}"/>` + l.content
  return svgDoc(W, spec.h, body, { title: 'Made possible by SlicerX', defs: l.defs })
}

// the heart from the app's icon set, on its 24 unit grid
const HEART = 'M12 20s-7.5-4.4-7.5-10A4.3 4.3 0 0 1 12 7.4 4.3 4.3 0 0 1 19.5 10c0 5.6-7.5 10-7.5 10z'

function button(theme) {
  const H = 40
  const pad = 16
  const icon = 18
  const cy = H / 2
  const heart = `<path fill="none" stroke="${theme.heart}" stroke-width="2" stroke-linejoin="round" transform="translate(${pad} ${r2(cy - icon / 2 + 0.5)}) scale(${icon / 24})" d="${HEART}"/>`
  const t = line(fonts.bodyBold, 'Support', 15, pad + icon + 8, cy, 0.005)
  const l = word(theme, 16, CUTS.tab, 'b', pad + icon + 8 + t.w + 6, cy)
  const W = Math.ceil(pad * 2 + icon + 8 + t.w + 6 + l.w)
  const body = plate(W, H, 10, theme, theme.accent, 0.55) + heart + `<path fill="${theme.word}" d="${t.d}"/>` + l.content
  return svgDoc(W, H, body, { title: 'Support SlicerX', defs: l.defs })
}

async function emit(folder, name, svg) {
  const dir = join(kit, folder)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${name}.svg`), svg)
  const w = Number(/ width="([\d.]+)"/.exec(svg)[1])
  for (const [scale, suffix] of [[1, ''], [2, '@2x']]) {
    const png = await sharp(Buffer.from(svg), { density: 72 * scale })
      .resize(w * scale)
      .png({ palette: true, colors: 256, dither: 0, compressionLevel: 9, effort: 10 })
      .toBuffer()
    writeFileSync(join(dir, `${name}${suffix}.png`), png)
  }
}

for (const [size, spec] of Object.entries(BADGES)) {
  for (const [name, theme] of Object.entries(THEMES)) await emit('badges', `made-possible-by-slicerx-${size}-${name}`, badge(spec, theme))
}
for (const [name, theme] of Object.entries(THEMES)) await emit('button', `support-slicerx-${name}`, button(theme))
console.log(`credit kit badges and button written to ${kit}`)
