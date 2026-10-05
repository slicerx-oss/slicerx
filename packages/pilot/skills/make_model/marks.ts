// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Brand marks and straight-line SVG paths as polygons for sx-geom `build` extrude.
export type Pt = [number, number]

/** The SlicerX X on the kit's 32 unit grid (editions/slicerx/brand/paths.json, `x`). */
export const SLICERX_X_PATH = 'M4.5 4h6.2l5.3 8.1L21.3 4h6.2l-8.3 12 8.3 12h-6.2L16 19.9 10.7 28H4.5l8.3-12z'

/**
 * Points of a path made of M, L, H, V and Z (absolute or relative), one closed ring per
 * subpath. Null when the path uses curves or arcs, which need the geometry engine.
 */
export function pathRings(d: string): Pt[][] | null {
  const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e-?\d+)?/g)
  if (!tokens) return null
  const rings: Pt[][] = []
  let ring: Pt[] = []
  let x = 0
  let y = 0
  let sx = 0
  let sy = 0
  let cmd = ''
  let i = 0
  const num = (): number => Number(tokens[i++])
  const close = (): void => {
    if (ring.length >= 3) rings.push(ring)
    ring = []
    x = sx
    y = sy
  }
  while (i < tokens.length) {
    const t = tokens[i] as string
    if (/[a-zA-Z]/.test(t)) {
      cmd = t
      i++
      if (cmd === 'z' || cmd === 'Z') {
        close()
        continue
      }
    } else if (cmd === '') return null
    const rel = cmd === cmd.toLowerCase()
    switch (cmd.toUpperCase()) {
      case 'M': {
        if (ring.length) close()
        const nx = num()
        const ny = num()
        x = rel ? x + nx : nx
        y = rel ? y + ny : ny
        sx = x
        sy = y
        ring.push([x, y])
        cmd = rel ? 'l' : 'L'
        break
      }
      case 'L': {
        const nx = num()
        const ny = num()
        x = rel ? x + nx : nx
        y = rel ? y + ny : ny
        ring.push([x, y])
        break
      }
      case 'H':
        x = rel ? x + num() : num()
        ring.push([x, y])
        break
      case 'V':
        y = rel ? y + num() : num()
        ring.push([x, y])
        break
      default:
        return null
    }
  }
  if (ring.length) close()
  return rings.length ? rings : null
}

export interface Placed {
  points: Pt[]
  widthMm: number
  heightMm: number
}

/** Rings scaled to `widthMm`, y flipped (SVG y points down), the bounding box moved to the origin. Counterclockwise. */
export function placeRing(ring: Pt[], widthMm: number, bounds?: { minX: number; minY: number; maxX: number; maxY: number }): Placed {
  const b = bounds ?? ring.reduce((a, [px, py]) => ({ minX: Math.min(a.minX, px), minY: Math.min(a.minY, py), maxX: Math.max(a.maxX, px), maxY: Math.max(a.maxY, py) }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity })
  const k = widthMm / (b.maxX - b.minX)
  const pts = ring.map(([px, py]): Pt => [Math.round((px - b.minX) * k * 1e6) / 1e6, Math.round((b.maxY - py) * k * 1e6) / 1e6])
  const area = pts.reduce((a, p, j) => a + (p[0] * (pts[(j + 1) % pts.length] as Pt)[1] - (pts[(j + 1) % pts.length] as Pt)[0] * p[1]), 0)
  return { points: area < 0 ? pts.reverse() : pts, widthMm, heightMm: (b.maxY - b.minY) * k }
}
