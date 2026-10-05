// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Turns type into outlines, so no file in this kit needs a font on the machine that shows it, and
// builds the wordmark lockups. The fonts are SIL OFL from Google Fonts and are read from the
// workspace install of @expo-google-fonts, or from FONT_DIR (Unbounded.ttf, HankenGrotesk.ttf,
// JetBrainsMono.ttf, each at the weight named below).
import { createRequire } from 'node:module'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PALETTE, TEXT, markAt } from './geometry.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
export const opentype = require(join(here, '.cache/node_modules/opentype.js'))

function findFont(pkg, weightDir, file, override) {
  if (process.env.FONT_DIR && existsSync(join(process.env.FONT_DIR, override))) return join(process.env.FONT_DIR, override)
  const store = join(here, '../../../node_modules/.pnpm')
  const dir = readdirSync(store).find((d) => d.startsWith(`@expo-google-fonts+${pkg}@`))
  if (!dir) throw new Error(`Font ${pkg} not found. Run pnpm install, or set FONT_DIR.`)
  return join(store, dir, 'node_modules/@expo-google-fonts', pkg, weightDir, file)
}

export const fontPaths = {
  display: findFont('unbounded', '600SemiBold', 'Unbounded_600SemiBold.ttf', 'Unbounded.ttf'),
  body: findFont('hanken-grotesk', '500Medium', 'HankenGrotesk_500Medium.ttf', 'HankenGrotesk.ttf'),
  bodyBold: findFont('hanken-grotesk', '600SemiBold', 'HankenGrotesk_600SemiBold.ttf', 'HankenGrotesk.ttf'),
  mono: findFont('jetbrains-mono', '500Medium', 'JetBrainsMono_500Medium.ttf', 'JetBrainsMono.ttf'),
}
export const fonts = Object.fromEntries(Object.entries(fontPaths).map(([k, p]) => [k, opentype.loadSync(p)]))

/** Outlined text. `tracking` is letter spacing in em. Returns the path and its advance width. */
export function textPath(font, str, size, x, y, tracking = 0) {
  let cx = x
  let d = ''
  const bb = { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity }
  const glyphs = font.stringToGlyphs(str)
  glyphs.forEach((g, i) => {
    const gp = g.getPath(cx, y, size)
    d += gp.toPathData(2)
    if (gp.commands.length) {
      const b = gp.getBoundingBox()
      bb.x1 = Math.min(bb.x1, b.x1); bb.y1 = Math.min(bb.y1, b.y1); bb.x2 = Math.max(bb.x2, b.x2); bb.y2 = Math.max(bb.y2, b.y2)
    }
    cx += (g.advanceWidth / font.unitsPerEm) * size + tracking * size
    const next = glyphs[i + 1]
    if (next) cx += (font.getKerningValue(g, next) / font.unitsPerEm) * size
  })
  return { d, width: cx - x, box: bb }
}

// The cap height of the display cut as a share of its size, measured from Unbounded 600. It is the
// ratio the brand book uses for the live logo, so the files and the app agree.
export const CAPR = 0.735
export const TRACK = -0.02
const XOVER = 1.05

/**
 * The horizontal lockup: "Slicer" in Unbounded 600 with the mark standing in as its X. The X is
 * exactly the cap height, sits on the baseline, and its 4.5 unit overhang on each side is pulled
 * in so it spaces like a tight letter. Returns tight bounds of the visible artwork.
 *
 * `ink` is the word color. `palette` colors the X. Pass a one-color palette for a one-color lockup.
 * `cut` picks the optical cut for the X; small lockups take the small or tab cut.
 */
export function lockup({ size = 100, uid = 'l', ink = TEXT.dark, palette = PALETTE.dark, cut } = {}) {
  const cap = CAPR * size
  // Fine line work looks lighter than Unbounded's solid letters, so the X is drawn 5 percent over
  // the cap height, centered on it, the way a pointed letter overshoots.
  const s = (cap / 24) * XOVER
  const word = textPath(fonts.display, 'Slicer', size, 0, 0, TRACK)
  const visibleLeft = word.width + 0.015 * size
  // The X's visible box starts 4.5 units inside the 32 unit mark box.
  const mx = visibleLeft - 4.5 * s // x of the mark box origin
  const my = -cap / 2 - 16 * s // y of the mark box origin, so the X is centered on the cap height
  const xLeft = mx + 4.5 * s
  const xRight = mx + 27.5 * s
  const box = word.box
  const x0 = Math.min(box.x1, xLeft)
  const x1 = Math.max(box.x2, xRight)
  const y0 = Math.min(box.y1, my + 4 * s)
  const y1 = Math.max(box.y2, my + 28 * s)
  const m = markAt(uid, mx, my, s, { palette, cut })
  const content = `<path fill="${ink}" d="${word.d}"/>${m.content}`
  return { defs: m.defs, content, x: x0, y: y0, w: x1 - x0, h: y1 - y0, cap, size, mx, my, s }
}
