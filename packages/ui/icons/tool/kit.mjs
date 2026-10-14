// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Drawing kit for the shaded tool icons. two coordinate kinds:
//  px: pixel indices; a vertex at (3, 5) sits on the center of that pixel, so a 1px outline through it is crisp
//  raw: plain svg units, for curves and for even-width strokes that sit on pixel edges
// classes: t1 t2 t3 grays (lit, side, shade), a1 a2 a3 the accent shaded the same way, hl the cavity,
// ln an accent stroke (its width in the call), out an outline-only stroke

const n = (v) => +v.toFixed(2)
export const pc = ([x, y]) => `${n(x + 0.5)} ${n(y + 0.5)}`
const rc = ([x, y]) => `${n(x)} ${n(y)}`

/** a filled, outlined polygon on pixel centers */
export const poly = (cls, pts) => `<path class="${cls}" d="M${pts.map(pc).join('L')}Z"/>`
/** a filled polygon in raw units */
export const rpoly = (cls, pts) => `<path class="${cls}" d="M${pts.map(rc).join('L')}Z"/>`

/** the 2:1 pixel projection: +x runs right and down, +y left and down, +z straight up */
export const iso = (bx, by) => (x, y, z = 0) => [bx + 2 * x - 2 * y, by + x + y - z]

const lerp = (p, q, t) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]
const hiLine = (pts) => `<path class="hi" d="M${pts.map(pc).join('L')}"/>`

/**
 * an upright face [top left, top right, bottom right, bottom left]: its base tone, a shade that deepens toward the
 * floor in two steps, and a 1px catch light under its top edge
 */
export function vface(cls, q) {
  const [tl, tr, br, bl] = q
  const rows = Math.abs(bl[1] - tl[1]) >= 6 ? Math.abs(bl[1] - tl[1]) : 0
  let out = poly(cls, q)
  if (rows >= 3) out += poly('sh nos', [lerp(tl, bl, 0.55), lerp(tr, br, 0.55), br, bl]) + poly('sh nos', [lerp(tl, bl, 0.8), lerp(tr, br, 0.8), br, bl])
  const k = Math.abs(tr[1] - tl[1])
  if (rows >= 4 && k >= 2) {
    const d = [(tr[0] - tl[0]) / k, (tr[1] - tl[1]) / k]
    out += hiLine([[tl[0] + d[0], tl[1] + d[1] + 1], [tr[0] - d[0], tr[1] - d[1] + 1]])
  }
  return out
}

/** a top face [back, right, front, left]: base tone, a catch light inside its two back edges, a soft shade at the front */
export function tface(cls, q) {
  const [bk, rt, fr, lf] = q
  const out = poly(cls, q) + poly('sh3 nos', [lerp(lf, fr, 0.5), fr, lerp(rt, fr, 0.5)])
  const wide = Math.abs(rt[0] - bk[0]) >= 4 && Math.abs(lf[0] - bk[0]) >= 4
  return wide ? out + hiLine([[lf[0] + 2, lf[1]], [bk[0], bk[1] + 1], [rt[0] - 2, rt[1]]]) : out
}

/** an axis box; faces lit from the upper left: top t1, the +y face t2, the +x face t3 */
export function box(o, x0, y0, x1, y1, z0, z1, c = 'g') {
  const [t, l, r] = c === 'a' ? ['a1', 'a2', 'a3'] : c === 'ga' ? ['a1', 't2', 't3'] : ['t1', 't2', 't3']
  return (
    vface(r, [o(x1, y0, z1), o(x1, y1, z1), o(x1, y1, z0), o(x1, y0, z0)]) +
    vface(l, [o(x0, y1, z1), o(x1, y1, z1), o(x1, y1, z0), o(x0, y1, z0)]) +
    tface(t, [o(x0, y0, z1), o(x1, y0, z1), o(x1, y1, z1), o(x0, y1, z1)])
  )
}

/**
 * an upright cylinder in raw units: center x, top and bottom ellipse centers, rx (ry = rx / 2, the projection's
 * circle). Keep cx +- rx on a half pixel so the sides are crisp. The body splits at `split` (raw x) into the lit
 * left and the shaded right, with a deeper shade at the far right and a catch light down the lit side.
 */
export function cyl(cx, yt, yb, rx, c = 'g', split = cx + rx * 0.25, top = null) {
  const ry = rx / 2
  const [t, l, r] = c === 'a' ? ['a1', 'a2', 'a3'] : ['t1', 't2', 't3']
  const L = cx - rx, R = cx + rx
  const at = (x) => yb + ry * Math.sqrt(Math.max(0, 1 - ((x - cx) / rx) ** 2))
  const body = `M${n(L)} ${n(yt)}L${n(L)} ${n(yb)}A${n(rx)} ${n(ry)} 0 0 0 ${n(R)} ${n(yb)}L${n(R)} ${n(yt)}Z`
  const part = (x0, x1, sweepTo) => `M${n(x0)} ${n(yt)}L${n(x0)} ${n(at(x0))}A${n(rx)} ${n(ry)} 0 0 0 ${n(x1)} ${n(at(x1))}L${n(x1)} ${n(yt)}Z`
  const deep = cx + rx * 0.62
  const hx = Math.floor(L + rx * 0.42) + 0.5
  const tall = yb - yt >= 3 && rx >= 3
  return (
    `<path class="${r} nos" d="${body}"/><path class="${l} nos" d="${part(L, split)}"/>` +
    (tall ? `<path class="sh nos" d="${part(deep, R)}"/><path class="hi" d="M${hx} ${n(yt + 1)}V${n(at(hx) - 1.5)}"/>` : '') +
    `<path class="out${c === 'a' ? ' ao' : ''}" d="${body}"/>` +
    `<ellipse class="${top ?? t}" cx="${n(cx)}" cy="${n(yt)}" rx="${n(rx)}" ry="${n(ry)}"/>` +
    (rx >= 4 ? `<path class="hi" d="M${n(cx - rx + 1.5)} ${n(yt)}A${n(rx - 1.5)} ${n(ry - 1)} 0 0 1 ${n(cx + rx * 0.3)} ${n(yt - (ry - 1) * 0.95)}"/>` : '')
  )
}

/** an accent stroke with a dark underlay, so it reads on any face and any ground; raw units */
export function stroke(d, w, cls = 'ln', extra = '') {
  return `<path class="lu" style="stroke-width:${w + 2}px${extra}" d="${d}"/><path class="${cls}" style="stroke-width:${w}px${extra}" d="${d}"/>`
}
/** the same as a polyline through raw points */
export const sline = (pts, w, cls = 'ln') => stroke(`M${pts.map(rc).join('L')}`, w, cls)
/** a raw point list as path data */
export const pd = (pts) => `M${pts.map(rc).join('L')}`

/** a square handle centered on a pixel-center point, side s pixels (odd) */
export function knob(x, y, s, cls = 't1') {
  const h = (s - 1) / 2
  return poly(cls, [[x - h, y - h], [x + h, y - h], [x + h, y + h], [x - h, y + h]])
}

