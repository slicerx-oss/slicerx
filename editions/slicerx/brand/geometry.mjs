// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The SlicerX mark as geometry: an X drawn as offset perimeters, one source for every file in this kit.
// packages/ui/src/icons/mark-path.ts draws the same shapes live in the app.
// Everything is drawn on a 32 unit grid. See README.md for how each piece is used.

// The mark is an X drawn as offset perimeters: nested outlines, the way a slicer offsets each wall
// inward, in pink, purple and cyan. One master X, three optical cuts (see CUTS).
//
// The X is 24 units tall and 23 wide on the 32 unit grid, centered on (16, 16). Its two bands are
// `t` units thick measured across, with horizontal terminals, and meet at the center.
const HALF_H = 12
const HALF_W = 11.5
const r2 = (v) => +v.toFixed(2)

/**
 * The X outline inset by `d` units, as points. The band centerline stays where it is and the band
 * narrows, because a perpendicular inset of d moves each sloped edge sideways by d * sqrt(1 + k^2).
 * Terminals stay horizontal and move in by d.
 */
export function xPoints(d = 0, t = 9.6) {
  const xc0 = HALF_W - t / 2
  const k = xc0 / HALF_H
  const h = HALF_H - d
  const xc = k * h
  const tt = t - 2 * d * Math.sqrt(1 + k * k)
  if (tt <= 0 || h <= 0) return null
  const n = tt / (2 * k)
  return [
    [-xc - tt / 2, -h], [-xc + tt / 2, -h], [0, -n], [xc - tt / 2, -h], [xc + tt / 2, -h], [tt / 2, 0],
    [xc + tt / 2, h], [xc - tt / 2, h], [0, n], [-xc + tt / 2, h], [-xc - tt / 2, h], [-tt / 2, 0],
  ].map(([x, y]) => [r2(16 + x), r2(16 + y)])
}
export const xPath = (d, t) => {
  const p = xPoints(d, t)
  return p ? 'M' + p.map(([x, y]) => `${x} ${y}`).join('L') + 'z' : ''
}

export const X_PATH = xPath(0, 9.6)

// The X is 23 units wide and 24 tall, centered on (16, 16) of the 32 unit grid.
export const X_BOX = { x: 4.5, y: 4, w: 23, h: 24, cx: 16, cy: 16 }

// Subban tokens the kit draws from (design/tokens.css, packages/ui subbanLight).
export const INK = { 0: '#121319', 1: '#17181f', 2: '#1e1f29', 3: '#262835', 4: '#303241', line: '#3d4054' }
export const TEXT = { dark: '#f8f8f2', light: '#17181f', muted: '#a9afd0', mutedLight: '#4d5474', dim: '#7580ad' }
export const GROUND = { dark: INK[0], light: '#f4f4f9' }

// Ring colors. b is the outer ring (pink), a the middle one (purple) and c the inner one (cyan). The
// light set deepens all three, because the dark ones fall under 3 to 1 on a pale surface.
export const PALETTE = {
  dark: { a: '#bd93f9', b: '#ff79c6', c: '#8be9fd' },
  light: { a: '#6b3fc4', b: '#c1268a', c: '#0b7a99' },
  white: { a: '#f8f8f2', b: '#f8f8f2', c: '#f8f8f2' },
  ink: { a: '#17181f', b: '#17181f', c: '#17181f' },
  // The iOS tinted icon, which the system colors itself: a luminance ramp and no hue.
  mono: { a: '#bdbdbd', b: '#f2f2f2', c: '#8a8a8a' },
}
const ROLE = { o: 'b', m: 'a', i: 'c' }

/**
 * The cuts. Every ring is `d` units in from the outer edge (to the middle of its line) with line
 * width `w`, or a solid X when `solid`. The gaps between rings are under 1 unit at full, which
 * falls under a pixel below 48 px, so the small cut has one outline and a solid core, and the tab
 * cut is heavier still, the way a typeface has an optical size. It is one design, not three.
 */
export const CUTS = {
  // Two nested outlines around a solid core: 48 px and up, and all print.
  full: { t: 9.6, rings: [{ d: 0.55, w: 1.1, r: 'o' }, { d: 2.35, w: 0.9, r: 'm' }, { d: 3.45, solid: true, r: 'i' }] },
  // An outline and a solid core: 24 to 48 px.
  small: { t: 9.6, rings: [{ d: 0.75, w: 1.5, r: 'o' }, { d: 3.0, solid: true, r: 'm' }] },
  // The heavier outline and core that a 16 px tab can hold.
  tab: { t: 10.5, rings: [{ d: 1.2, w: 2.4, r: 'o' }, { d: 3.9, solid: true, r: 'm' }] },
}

/** The rings as drawn shapes: {d, stroke width or null, role}. */
export function ringShapes(cut) {
  return cut.rings.map((g) => ({ path: xPath(g.solid ? g.d : g.d, cut.t), w: g.solid ? null : g.w, role: g.r }))
}

/**
 * The mark on the 32 unit grid: defs plus the rings. `uid` keeps ids unique when several marks share
 * one document. `classes` writes class names (o, m, i) instead of colors, for a file that sets its
 * own colors in a style block, such as the tab icon.
 *
 * `glow` draws a soft violet halo that exists outside the X only, masked off inside the shape so
 * the gaps between rings stay clear. It is for large marks on a ground: an app icon, a splash, a
 * card. It is left off small sizes and anywhere the mark sits on a surface the brand does not own.
 */
export function markParts(uid, { palette = PALETTE.dark, cut = CUTS.full, glow = 0, classes = false } = {}) {
  const defs = glow
    ? `<filter id="b${uid}" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="${glow.blur ?? 1.15}"/></filter>` +
      `<mask id="m${uid}" maskUnits="userSpaceOnUse" x="-16" y="-16" width="64" height="64"><rect x="-16" y="-16" width="64" height="64" fill="#fff"/><path d="${X_PATH}" fill="#000"/></mask>`
    : ''
  const halo = glow
    ? `<g mask="url(#m${uid})"><path d="${X_PATH}" fill="${palette.a}" opacity="${glow.opacity ?? 0.6}" filter="url(#b${uid})"/></g>`
    : ''
  const col = (role) => (classes ? `class="${role}"` : null)
  const body = ringShapes(cut).map((g) => {
    const c = palette[ROLE[g.role]]
    if (g.w === null) return `<path ${classes ? col(g.role) : `fill="${c}"`} d="${g.path}"/>`
    return `<path fill="none" ${classes ? col(g.role) : `stroke="${c}"`} stroke-width="${g.w}" stroke-linejoin="miter" d="${g.path}"/>`
  }).join('')
  return { defs, halo, body }
}

/** The mark drawn at (x, y) with the X `height` units tall in the parent's units. */
export function placeMark(uid, x, y, height, opts) {
  const s = height / X_BOX.h
  const { defs, halo, body } = markParts(uid, opts)
  // Put the center of the X at (x, y).
  const t = `translate(${r2(x - X_BOX.cx * s)} ${r2(y - X_BOX.cy * s)}) scale(${+s.toFixed(4)})`
  return { defs, content: `<g transform="${t}">${halo}${body}</g>` }
}

/** The mark with its 32 unit box origin at (ox, oy) and `s` output units per grid unit. */
export function markAt(uid, ox, oy, s, opts) {
  const { defs, halo, body } = markParts(uid, opts)
  return { defs, content: `<g transform="translate(${r2(ox)} ${r2(oy)}) scale(${+s.toFixed(5)})">${halo}${body}</g>` }
}

export function svgDoc(w, h, body, { title, viewBox, defs = '', desc } = {}) {
  const vb = viewBox ?? `0 0 ${w} ${h}`
  const label = title ? ` role="img" aria-label="${title}"` : ' aria-hidden="true"'
  const d = defs ? `<defs>${defs}</defs>` : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" width="${w}" height="${h}"${label}>${desc ? `<desc>${desc}</desc>` : ''}${d}${body}</svg>\n`
}

/** A superellipse, the continuous corner Apple's icon plate uses, as a path in a `size` box. */
export function squircle(x, y, size, n = 5, steps = 96) {
  const a = size / 2
  const pts = []
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * Math.PI * 2
    const c = Math.cos(t), s = Math.sin(t)
    pts.push([x + a + a * Math.sign(c) * Math.abs(c) ** (2 / n), y + a + a * Math.sign(s) * Math.abs(s) ** (2 / n)])
  }
  return 'M' + pts.map(([px, py]) => `${r2(px)} ${r2(py)}`).join('L') + 'Z'
}
