// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The app mark as geometry, with no React: huginn perched on three printed layers.
// The same shapes as editions/slicerx/brand/raven.mjs, which builds the icon files, on a 100 unit
// grid, plus the 16 px cut on its own 16 px grid.

const OUTLINE =
  'M15.5 35.2C19 29.8 24.5 26.6 30 26.5C33 23 37.6 21 43.6 21C49.6 21 54 23.8 56.6 28.6' +
  'C60 33.6 65.4 37 71.2 40.8C77 44.5 82 51 85.2 58.2L92.6 73.4' +
  'C93.4 74.6 93.2 76 92 76.6L90.4 77.4C89.6 77.8 88.6 77.6 88 77L79.5 71.4C75 68.8 71 68 66 67.6' +
  'L55 67.6C45.5 67.2 38.6 62.2 35.8 54C35.2 52 34.8 50 34.4 47.6'
const HACKLES =
  'C33.4 48 32.4 48.1 31.4 48C32.2 47 32.6 46 32.7 45.2C31.6 45.4 30.2 45.3 29 45C30 44 30.8 42.8 31.1 41.8' +
  'C30.2 41.6 29.1 41.2 28.1 40.6C29.2 39.8 30 38.6 30.4 37.4'
const THROAT = 'C33.4 43.6 32 40 30.4 37.4'
const GAPE = 'C25 37 20 36.4 16.4 35.9z'
const WING_LINE = 'M49 37.5C56 48 68 57 89.6 65.4'
const WING_SHAPE = 'M49 37.5C56.6 47 68.6 56 90.4 64.4L89.6 66.4C67.4 58.6 55.4 49 49 37.5z'
const LEGS = 'M52.5 66.5L51.8 71M59.5 66.5L59 71'

export type PerchCut = 'full' | 'small' | 'px16'

export interface PerchShapes {
  viewBox: string
  /** Applied to the bird, its legs and the wing cut. The layers and the eye are in viewBox units. */
  birdTransform: string
  bars: { x: number; y: number; width: number; height: number; rx: number }[]
  body: string
  /** Leg strokes, drawn behind the layers. Null where they would be under a pixel. */
  legs: { d: string; width: number } | null
  /** The gap between wing and body, cut out of the bird: a stroke width, or null for a filled shape. */
  wing: { d: string; width: number | null } | null
  eye: { cx: number; cy: number; r: number } | null
  /** Gradient ends: the bird's in its own units, the layers' along x in viewBox units. */
  birdGradient: { x1: number; y1: number; x2: number; y2: number }
  barGradient: { x1: number; x2: number }
}

const bars = (rows: readonly (readonly [number, number, number, number])[], dx = 0, dy = 0) =>
  rows.map(([x, y, width, height]) => ({ x: x + dx, y: y + dy, width, height, rx: height / 2 }))

const BIRD_GRADIENT = { x1: 15.5, y1: 21, x2: 93.4, y2: 77.8 }

/** The shapes of a cut. `full` from 64 px, `small` from 20 px, `px16` below. */
export function perchShapes(cut: PerchCut = 'full'): PerchShapes {
  if (cut === 'px16') {
    const k = 0.15
    return {
      viewBox: '0 0 16 16',
      birdTransform: `translate(${+(1.6 - 15.5 * k).toFixed(2)} ${+(1.6 - 21 * k).toFixed(2)}) scale(${k})`,
      bars: bars([[5, 10, 7, 1], [4, 12, 9, 1], [3, 14, 11, 1]]),
      body: OUTLINE + THROAT + GAPE,
      legs: null,
      wing: null,
      eye: { cx: 5.5, cy: 2.5, r: 0.5 },
      birdGradient: BIRD_GRADIENT,
      barGradient: { x1: 3, x2: 14 },
    }
  }
  // each cut is moved so the art sits optically centered in the 100 box
  const full = cut === 'full'
  const [dx, dy] = full ? [-1.5, -5.2] : [-1.5, -6]
  const rows = full
    ? ([[33, 70.4, 42, 4.8], [30, 77.2, 48, 4.8], [27, 84, 54, 4.8]] as const)
    : ([[32, 70.6, 44, 6.4], [29, 79.6, 50, 6.4], [26, 88.6, 56, 6.4]] as const)
  return {
    viewBox: '0 0 100 100',
    birdTransform: `translate(${dx} ${dy})`,
    bars: bars(rows, dx, dy),
    body: OUTLINE + (full ? HACKLES : THROAT) + GAPE,
    legs: { d: LEGS, width: full ? 2.8 : 3.6 },
    wing: full ? { d: WING_SHAPE, width: null } : { d: WING_LINE, width: 3.4 },
    eye: { cx: 38.6 + dx, cy: 28.2 + dy, r: full ? 1.6 : 2.6 },
    birdGradient: BIRD_GRADIENT,
    barGradient: { x1: rows[2][0] + dx, x2: rows[2][0] + rows[2][2] + dx },
  }
}

/** The cut to use for a rendered size in pixels. */
export function perchCutFor(px: number): PerchCut {
  return px >= 64 ? 'full' : px >= 20 ? 'small' : 'px16'
}
