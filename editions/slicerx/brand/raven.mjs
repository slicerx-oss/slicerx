// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The icon as geometry: huginn perched on three printed layers. The X stays in the wordmark
// (geometry.mjs); this is the standalone mark for app icons, favicons, tiles and avatars.
// packages/ui/src/icons/perch-path.ts draws the same shapes live in the app.
//
// Drawn on a 100 unit grid. The raven faces left with its tail over the right end of the stack,
// a solid silhouette with the folded wing and the eye cut out of it. The layers are three beads
// with round ends, each a step wider than the one above, the way a print's first layers spread.

const r2 = (v) => +v.toFixed(2)

// The silhouette clockwise from the beak tip: culmen, crown, back, tail, belly, chest. The wing
// gap cuts through the back to make the wing tip.
const OUTLINE = [
  'M15.5 35.2C19 29.8 24.5 26.6 30 26.5C33 23 37.6 21 43.6 21C49.6 21 54 23.8 56.6 28.6',
  'C60 33.6 65.4 37 71.2 40.8C77 44.5 82 51 85.2 58.2L92.6 73.4',
  'C93.4 74.6 93.2 76 92 76.6L90.4 77.4C89.6 77.8 88.6 77.6 88 77L79.5 71.4C75 68.8 71 68 66 67.6',
  'L55 67.6C45.5 67.2 38.6 62.2 35.8 54C35.2 52 34.8 50 34.4 47.6',
].join('')
// The throat: shaggy hackles on the full cut, a plain curve where they would be a blur.
const HACKLES = 'C33.4 48 32.4 48.1 31.4 48C32.2 47 32.6 46 32.7 45.2C31.6 45.4 30.2 45.3 29 45C30 44 30.8 42.8 31.1 41.8C30.2 41.6 29.1 41.2 28.1 40.6C29.2 39.8 30 38.6 30.4 37.4'
const THROAT = 'C33.4 43.6 32 40 30.4 37.4'
const GAPE = 'C25 37 20 36.4 16.4 35.9z'

export const RAVEN_PATH = OUTLINE + HACKLES + GAPE
export const RAVEN_PATH_SMALL = OUTLINE + THROAT + GAPE
/** The gap between the folded wing and the body: the line of the wing, as a stroke. */
export const RAVEN_WING = 'M49 37.5C56 48 68 57 89.6 65.4'
// The same gap as a shape for the full cut, pointed where the wing meets the shoulder and widening
// toward the tips, the way a feathered edge opens.
const WING_SHAPE = 'M49 37.5C56.6 47 68.6 56 90.4 64.4L89.6 66.4C67.4 58.6 55.4 49 49 37.5z'
export const RAVEN_EYE = { cx: 38.6, cy: 28.2 }
/** The legs, from inside the belly down to the top layer, drawn behind it. */
export const RAVEN_LEGS = 'M52.5 66.5L51.8 71M59.5 66.5L59 71'

/**
 * The cuts, one design at three optical sizes like the X's. Each moves the art by `at` so it sits
 * optically centered in the 100 box: the bird is heavy at the top left and its tail is light.
 * `bars` are [x, y, width, height] before that move.
 */
export const PERCH_CUTS = {
  // 64 px and up, and all print.
  full: {
    at: [-1.5, -5.2], body: RAVEN_PATH, wing: 0, eye: 1.6, legs: 2.8,
    bars: [[33, 70.4, 42, 4.8], [30, 77.2, 48, 4.8], [27, 84, 54, 4.8]],
  },
  // 24 to 48 px: no hackles, a wider wing gap, a larger eye, heavier layers with wider gaps.
  small: {
    at: [-1.5, -6], body: RAVEN_PATH_SMALL, wing: 3.4, eye: 2.6, legs: 3.6,
    bars: [[32, 70.6, 44, 6.4], [29, 79.6, 50, 6.4], [26, 88.6, 56, 6.4]],
  },
}

// The art's box in the 100 grid after the move, for placing it on a plate.
export const PERCH_BOX = { x: 14, y: 15.8, w: 77.9, h: 67.8 }

/**
 * Two stops for the bird, top left to bottom right, and two for the layers, left to right: cyan to
 * purple, the aegis gradient, whose purple end meets the bird's. Light surfaces get deeper ends
 * that read on white. One-color palettes pass the same color twice,
 * have no `layers`, and get a plain fill with no gradient.
 */
export const PERCH_PALETTE = {
  dark: { from: '#bd93f9', to: '#ff79c6', layers: ['#8be9fd', '#bd93f9'] },
  light: { from: '#6b3fc4', to: '#c1268a', layers: ['#1a8fb0', '#6b3fc4'] },
  white: { from: '#f8f8f2', to: '#f8f8f2' },
  ink: { from: '#17181f', to: '#17181f' },
  current: { from: 'currentColor', to: 'currentColor' },
  // The iOS tinted icon, which the system colors itself: a luminance ramp and no hue.
  mono: { from: '#f2f2f2', to: '#bdbdbd' },
}

/**
 * The mark on the 100 grid: defs and the drawn art. `uid` keeps ids unique when several marks
 * share a document. `glow` is a soft halo around the bird, outside its silhouette only, for large
 * art on a ground of ours, like the X's. The layers cast none, so the gaps between them stay as
 * dark as the plate.
 */
export function perchParts(uid, { cut = 'full', palette = PERCH_PALETTE.dark, glow = 0 } = {}) {
  const c = PERCH_CUTS[cut]
  const solid = palette.from === palette.to
  const [lf, lt] = palette.layers ?? [palette.from, palette.to]
  const [bx0, , bw0] = c.bars[c.bars.length - 1]
  const bird = solid ? palette.from : `url(#rb${uid})`
  const bar = solid ? palette.from : `url(#rl${uid})`
  // one gradient across the bird and its legs, so the legs take the color of the belly above them
  let defs = solid ? '' :
    `<linearGradient id="rb${uid}" gradientUnits="userSpaceOnUse" x1="15.5" y1="21" x2="93.4" y2="77.8"><stop offset="0" stop-color="${palette.from}"/><stop offset="1" stop-color="${palette.to}"/></linearGradient>` +
    `<linearGradient id="rl${uid}" gradientUnits="userSpaceOnUse" x1="${bx0}" y1="0" x2="${bx0 + bw0}" y2="0"><stop offset="0" stop-color="${lf}"/><stop offset="1" stop-color="${lt}"/></linearGradient>`
  const wing = c.wing
    ? `<path d="${RAVEN_WING}" fill="none" stroke="#000" stroke-width="${c.wing}" stroke-linecap="round"/>`
    : `<path d="${WING_SHAPE}" fill="#000"/>`
  defs +=
    `<mask id="rc${uid}" maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100"><rect width="100" height="100" fill="#fff"/>` +
    `${wing}<circle cx="${RAVEN_EYE.cx}" cy="${RAVEN_EYE.cy}" r="${c.eye}" fill="#000"/></mask>`
  const bars = (fill) => c.bars.map(([x, y, w, h]) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${fill}"/>`).join('')
  const legs = (stroke) => `<path d="${RAVEN_LEGS}" fill="none" stroke="${stroke}" stroke-width="${c.legs}"/>`
  let halo = ''
  if (glow) {
    const shape = `${bars('#000')}${legs('#000')}<path d="${c.body}" fill="#000"/>`
    defs +=
      `<filter id="rf${uid}" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="${glow.blur ?? 3}"/></filter>` +
      `<mask id="rm${uid}" maskUnits="userSpaceOnUse" x="-50" y="-50" width="200" height="200"><rect x="-50" y="-50" width="200" height="200" fill="#fff"/>${shape}</mask>`
    halo = `<g mask="url(#rm${uid})"><g filter="url(#rf${uid})" opacity="${glow.opacity ?? 0.45}">` +
      `<path d="${c.body}" fill="${palette.from}"/></g></g>`
  }
  const art = `${legs(bird)}${bars(bar)}<path d="${c.body}" fill="${bird}" mask="url(#rc${uid})"/>`
  return { defs, content: `<g transform="translate(${c.at[0]} ${c.at[1]})">${halo}${art}</g>` }
}

/** The mark scaled by `s` with the center of its 100 box at (cx, cy) in the parent's units. */
export function placePerch(uid, cx, cy, s, opts) {
  const { defs, content } = perchParts(uid, opts)
  return { defs, content: `<g transform="translate(${r2(cx - 50 * s)} ${r2(cy - 50 * s)}) scale(${+s.toFixed(5)})">${content}</g>` }
}

// Pixel cuts for 16 and 32 px, each on its own grid in whole pixels: the bird scaled by `k` with
// the beak tip at column `x` and the crown on row `y`, the layers on whole rows, and the eye a
// round hole on whole pixels. The 16 px cut has no wing gap and no legs, which would be under a
// pixel, and keeps the eye only on a ground of ours.
const PIXEL_CUTS = {
  16: { k: 0.15, x: 1.6, y: 1.6, bars: [[5, 10, 7], [4, 12, 9], [3, 14, 11]], h: 1, eye: [5.5, 2.5, 0.5], wing: 0, legs: 0 },
  32: { k: 0.322, x: 3, y: 4.5, bars: [[9, 21, 13], [8, 24, 15], [7, 27, 17]], h: 2, eye: [10, 7, 1], wing: 3.4, legs: 3.6 },
}

/** The 16 or 32 px cut on a `grid` px square. `eye` false leaves the eye out, for a clear 16 px mark. */
export function perchPixel(uid, grid, { palette = PERCH_PALETTE.dark, eye = true } = {}) {
  const p = PIXEL_CUTS[grid]
  const solid = palette.from === palette.to
  const [lf, lt] = palette.layers ?? [palette.from, palette.to]
  const [bx0, , bw0] = p.bars[p.bars.length - 1]
  let defs = solid ? '' :
    `<linearGradient id="pb${uid}" gradientUnits="userSpaceOnUse" x1="15.5" y1="21" x2="93.4" y2="77.8"><stop offset="0" stop-color="${palette.from}"/><stop offset="1" stop-color="${palette.to}"/></linearGradient>` +
    `<linearGradient id="pl${uid}" gradientUnits="userSpaceOnUse" x1="${bx0}" y1="0" x2="${bx0 + bw0}" y2="0"><stop offset="0" stop-color="${lf}"/><stop offset="1" stop-color="${lt}"/></linearGradient>`
  const bird = solid ? palette.from : `url(#pb${uid})`
  const bar = solid ? palette.from : `url(#pl${uid})`
  const t = `translate(${r2(p.x - 15.5 * p.k)} ${r2(p.y - 21 * p.k)}) scale(${p.k})`
  const showEye = eye || grid > 16
  const cuts = (p.wing ? `<path transform="${t}" d="${RAVEN_WING}" fill="none" stroke="#000" stroke-width="${p.wing}" stroke-linecap="round"/>` : '') +
    (showEye ? `<circle cx="${p.eye[0]}" cy="${p.eye[1]}" r="${p.eye[2]}" fill="#000"/>` : '')
  if (cuts) defs += `<mask id="pc${uid}" maskUnits="userSpaceOnUse" x="0" y="0" width="${grid}" height="${grid}"><rect width="${grid}" height="${grid}" fill="#fff"/>${cuts}</mask>`
  const bars = p.bars.map(([x, y, w]) => `<rect x="${x}" y="${y}" width="${w}" height="${p.h}" rx="${p.h / 2}" fill="${bar}"/>`).join('')
  const legs = p.legs ? `<path transform="${t}" d="${RAVEN_LEGS}" fill="none" stroke="${bird}" stroke-width="${p.legs}"/>` : ''
  // the bird's gradient is in its own units, like the full cut's; the mask is in the grid's
  const path = `<path transform="${t}" d="${RAVEN_PATH_SMALL}" fill="${bird}"/>`
  const body = cuts ? `<g mask="url(#pc${uid})">${path}</g>` : path
  return { defs, content: legs + bars + body }
}
