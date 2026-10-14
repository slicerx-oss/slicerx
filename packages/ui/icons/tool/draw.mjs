// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Model ribbon's shaded tool icons, each size drawn on its own grid (32, 24, 16). ICONS[name](size) is the
// inner svg markup. The 16 px drawings are snapped to whole pixels by scripts/snap-tool-icons.mjs (snapped16.json),
// and scripts/gen-tool-icons.mjs writes src/icons/tool-icons.ts from both.
import { box, cyl, iso, pd, poly, rpoly, stroke, tface, vface } from './kit.mjs'

/** an iso origin for a block a by b by h whose silhouette is centered on column cx with its top on row top */
const place = (cx, top, a, b, h) => iso(cx - a + b, top + h)
const by = (S, v32, v24, v16) => (S === 32 ? v32 : S === 24 ? v24 : v16)
const r = (p) => [p[0] + 0.5, p[1] + 0.5]
const f = (v) => +v.toFixed(2)
const ell = (cx, cy, rx, ry) => `M${f(cx - rx)} ${f(cy)}A${f(rx)} ${f(ry)} 0 1 0 ${f(cx + rx)} ${f(cy)}A${f(rx)} ${f(ry)} 0 1 0 ${f(cx - rx)} ${f(cy)}Z`

/** a square handle on raw center (cx, cy), side L between outline centers: L even on a pixel center, odd on an edge */
function knob(cx, cy, L, cls = 't1') {
  const h = L / 2
  return rpoly(cls, [[cx - h, cy - h], [cx + h, cy - h], [cx + h, cy + h], [cx - h, cy + h]])
}
const arrowUp = (x, y0, len, hd, w) => stroke(`M${x} ${y0}V${y0 - len}M${x - hd} ${y0 - len + hd}L${x} ${y0 - len}L${x + hd} ${y0 - len + hd}`, w)
const arrowDown = (x, y0, len, hd, w) => stroke(`M${x} ${y0}V${y0 + len}M${x - hd} ${y0 + len - hd}L${x} ${y0 + len}L${x + hd} ${y0 + len - hd}`, w)
/** a thin plate, the sketch plane */
const plate = (o, a, b = a) => box(o, 0, 0, a, b, 0, 1)
/** a knob snapped to the nearest pixel center (L even) or pixel edge (L odd) */
const knobAt = (p, L, cls = 't1') => {
  const sn = (v) => (L % 2 ? Math.round(v) : Math.floor(v) + 0.5)
  return knob(sn(p[0]), sn(p[1]), L, cls)
}
/** the sketch plane every Sketch tool sits on: a thick plate, its top face mapped from plane coords (0..a) */
function skPlate(S, lift = 0) {
  const [cx, top, a, h, w, L] = by(S, [15, 6, 7, 5, 2, 4], [11, 4, 5, 4, 2, 2], [7, 3, 3, 3, 1.5, 0])
  const o = place(cx, top + lift, a, a, h)
  const P = (u, v) => r(o(u, v, h))
  return { o, a, h, P, w, L, base: box(o, 0, 0, a, a, 0, h) }
}
/** sample a plane curve through P */
const along = (P, fn, n = 36) => Array.from({ length: n + 1 }, (_, k) => P(...fn(k / n)))
const circ = (cu, cv, rho, t0 = 0, t1 = 2 * Math.PI) => (t) => [cu + rho * Math.cos(t0 + (t1 - t0) * t), cv + rho * Math.sin(t0 + (t1 - t0) * t)]
const bez = (p0, c1, c2, p3) => (t) => { const u = 1 - t; return [0, 1].map((i) => u ** 3 * p0[i] + 3 * u * u * t * c1[i] + 3 * u * t * t * c2[i] + t ** 3 * p3[i]) }

const rad = (d) => (d * Math.PI) / 180
/**
 * the mesh tools' base: a low faceted mound on a flat iso footprint, wider than tall. short walls front left (t2)
 * and front right (t3), a low roof of five big triangles round an uneven ridge (q, s) and a front vertex m.
 * designed at 16 px (13 by 10);
 * k scales it, rot tilts it (degrees, clockwise), corners land on whole pixels
 */
const MOUND = { L: [0, 7], F: [6, 10], R: [12, 7], l: [0, 4], f: [6, 7], r: [12, 4], q: [3, 1], s: [8, 0], m: [6, 3] }
const MFACES = {
  wl: [['l', 'f', 'F', 'L'], 't2'], wr: [['f', 'r', 'R', 'F'], 't3'],
  a: [['l', 'q', 'm'], 't1'], b: [['q', 's', 'm'], 't1'], c: [['s', 'r', 'm'], 't2'], d: [['l', 'm', 'f'], 't1'], e: [['m', 'r', 'f'], 't2'],
}
const MORDER = ['wl', 'wr', 'a', 'b', 'c', 'd', 'e']
// below 32 the roof is three big triangles meeting at the front corner, so 16 and 24 stay clean
const MFACES_SMALL = { ...MFACES, a: [['l', 'q', 'f'], 't1'], b: [['q', 's', 'f'], 't1'], c: [['s', 'r', 'f'], 't2'] }
const MORDER_SMALL = ['wl', 'wr', 'a', 'b', 'c']
/**
 * at 16 the tools that cut, split or tip the mound draw the small mound above; the rest place BODY16, the same
 * mound hand-placed on whole pixels with its lines cut down to the silhouette (o), the two ridges and the front
 * edge (x), so the three roof faces (a, b, c) and the walls (l, r) stay readable under the tool's mark
 */
const BODY16 = [
  '......oooo...',
  '...ooobbxo...',
  '..oaxbbxcco..',
  '.oaaxbbxccco.',
  'olaaaxbxcccro',
  'olllaxbxccrro',
  'olllllxrrrrro',
  'olllllxrrrrro',
  '.oolllorrroo.',
  '...ooloroo...',
  '.....ooo.....',
]
/**
 * v6b: a smaller mound, 11 by 8, two roof faces (a, b) on one ridge (x), so the tool's mark gets half the cell and
 * the silhouette does the telling: a patch over a gap, two halves with a gap, an open rim round a dark cavity
 */
const MOUND16 = [
  '....o......',
  '...oxoo....',
  '.ooaxbboo..',
  'olaaaxbbbro',
  'olllaxbrrro',
  'oolllxrrroo',
  '..oolxroo..',
  '....ooo....',
]
/** rows y0..y1 of a map, or its columns x0..x1 */
const rows = (map, y0, y1) => map.slice(y0, y1 + 1)
const cols = (map, x0, x1) => map.map((row) => row.slice(x0, x1 + 1))
const PIX_CLASS = { o: 'po', x: 'po', a: 't1', b: 't2', c: 't3', l: 't2', r: 't3', A: 'a1', B: 'a2', P: 'pa', h: 'hl', w: 'nd' }
/** a pixel map (rows of letters, '.' empty) placed at (ox, oy), each letter a class via PIX_CLASS or tones */
function pix(map, ox, oy, tones = {}) {
  const runs = {}
  map.forEach((row, y) => {
    let x = 0
    while (x < row.length) {
      const ch = row[x]
      if (ch === '.') { x++; continue }
      let x1 = x
      while (x1 < row.length && row[x1] === ch) x1++
      const cls = tones[ch] ?? PIX_CLASS[ch]
      if (cls) (runs[cls] ??= []).push(`M${ox + x} ${oy + y}h${x1 - x}v1h-${x1 - x}z`)
      x = x1
    }
  })
  return Object.entries(runs).map(([cls, d]) => `<path class="${cls} nos px" d="${d.join('')}"/>`).join('')
}
/** the map with some letters swapped (fn(ch, x, y) returns the new letter or undefined) */
const remap = (map, fn) => map.map((row, y) => row.split('').map((ch, x) => fn(ch, x, y) ?? ch).join(''))
const at = (map, x, y) => map[y]?.[x] ?? '.'
const near8 = (map, x, y, set) => [-1, 0, 1].some((dy) => [-1, 0, 1].some((dx) => (dx || dy) && set.includes(at(map, x + dx, y + dy))))
function mound(x, y, k = 1, rot = 0) {
  const c = [6, 5], cs = Math.cos(rad(rot)), sn = Math.sin(rad(rot))
  const P = Object.fromEntries(Object.entries(MOUND).map(([n, [u, v]]) => {
    const du = u - c[0], dv = v - c[1]
    return [n, [x + Math.round((c[0] + du * cs - dv * sn) * k), y + Math.round((c[1] + du * sn + dv * cs) * k)]]
  }))
  const FACES = k >= 2 ? MFACES : MFACES_SMALL, ORDER = k >= 2 ? MORDER : MORDER_SMALL
  const pts = (id) => FACES[id][0].map((n) => P[n])
  const edge = (p, q) => `<path class="out" d="M${p[0] + 0.5} ${p[1] + 0.5}L${q[0] + 0.5} ${q[1] + 0.5}"/>`
  const half = (p, q) => [Math.round((p[0] + q[0]) / 2), Math.round((p[1] + q[1]) / 2)]
  // at 32 two more edges split the front roof into smaller triangles
  const extra = () => (k >= 2 ? edge(P.m, half(P.l, P.f)) + edge(P.m, half(P.f, P.r)) : '')
  const all = (tone = {}, skip = []) => ORDER.filter((id) => !skip.includes(id)).map((id) => poly(tone[id] ?? FACES[id][1], pts(id))).join('') + extra()
  return { P, pts, all, edge, half, order: ORDER, tone: (id) => FACES[id][1] }
}
/** a polygon clipped to one side of a vertical (ax 0) or horizontal (ax 1) line at c; less keeps the low side */
function clip(pts, ax, c, less) {
  const inside = (p) => (less ? p[ax] <= c : p[ax] >= c)
  const out = []
  pts.forEach((p, i) => {
    const q = pts[(i + 1) % pts.length]
    if (inside(p)) out.push(p)
    if (inside(p) !== inside(q)) {
      const t = (c - p[ax]) / (q[ax] - p[ax]), o = 1 - ax
      const m = []
      m[ax] = c
      m[o] = Math.round(p[o] + (q[o] - p[o]) * t)
      out.push(m)
    }
  })
  return out
}
const shift = (pts, dx, dy) => pts.map(([x, y]) => [x + dx, y + dy])
/** where each size puts the full mound, and its scale */
const xAt = (S) => by(S, [4, 6, 2], [3, 5, 1.5], [1, 3, 1])
/** the body each size draws: the scaled mound at 32 and 24, the hand-drawn one at 16 */
const body = (S, x, y, k = 1, rot = 0) => mound(x, y, k, rot)

// the action glyphs Solid and Mesh share: one drawing per size, the same whichever body sits under it
/** a dimension: a double-headed arrow across the top */
function dimGlyph(S) {
  const [x0, x1, yd, hd] = by(S, [4, 28, 6.5, 3], [3, 21, 5, 2.5], [1.5, 14.5, 3, 2])
  return stroke(`M${x0 + 1} ${yd}H${x1 - 1}M${x0 + hd + 1} ${yd - hd}L${x0 + 1} ${yd}L${x0 + hd + 1} ${yd + hd}M${x1 - hd - 1} ${yd - hd}L${x1 - 1} ${yd}L${x1 - hd - 1} ${yd + hd}`, 2)
}
/** export: an arrow leaving to the right, over the body's right side */
const exportGlyph = (S) => stroke(by(S, 'M14.5 15.5H27.5M23.5 11.5L27.5 15.5L23.5 19.5', 'M11 12H21M18 9L21 12L18 15', 'M7 8.5H14M11.5 6L14 8.5L11.5 11'), by(S, 3, 2, 2))
/** a cutting plane: a flat iso square in accent, centered on (cx, cy), half width hw, that reaches past the body */
const cutPlane = (cx, cy, hw) => poly('a1', [[cx - hw, cy], [cx, cy - hw / 2], [cx + hw, cy], [cx, cy + hw / 2]].map(([a, b]) => [Math.round(a), Math.round(b)]))
/** the sketch tools' drawing box, its corners on whole pixels so a 2px line along them is crisp */
function skBox(S) {
  const [x0, y0, x1, y1] = by(S, [5, 5, 27, 27], [4, 4, 20, 20], [2, 2, 14, 14])
  return { w: x1 - x0, P: (u, v) => [Math.round(x0 + u * (x1 - x0)), Math.round(y0 + v * (y1 - y0))] }
}
/** a sketch line: one 2px stroke, no underlay */
const skl = (d, cls = 'sk', style = '') => `<path class="${cls}" d="${d}"${style ? ` style="${style}"` : ''}/>`
/** a vertex node on a pixel corner: 2x2 white in a 1px ring of the line's color */
const node = (x, y) => `<path class="skf nos px" d="M${x - 2} ${y - 2}h4v4h-4z"/><path class="nd nos px" d="M${x - 1} ${y - 1}h2v2h-2z"/>`

export const ICONS = {
  // ---------- create ----------
  sketch(S) {
    const { P, a, base, w } = skPlate(S, by(S, 5, 4, 2))
    const [i, len, hw, cone] = by(S, [1.5, 15, 2.5, 5], [1, 11, 2, 4], [0.5, 8, 1.75, 3.5])
    const T = P(a * 0.55, a * 0.45)
    const d = [Math.SQRT1_2, -Math.SQRT1_2], nv = [Math.SQRT1_2, Math.SQRT1_2]
    const at = (s, k) => [T[0] + d[0] * s + nv[0] * k, T[1] + d[1] * s + nv[1] * k]
    return base + (S === 16 ? '' : stroke(pd([P(i, i), P(a - i, i), P(a - i, a - i), P(i, a - i)]) + 'Z', w)) +
      rpoly('t2', [at(cone, -hw), at(len, -hw), at(len, hw), at(cone, hw)]) +
      rpoly('t1 nos', [at(cone, -hw + 0.5), at(len - 0.5, -hw + 0.5), at(len - 0.5, 0), at(cone, 0)]) +
      rpoly('t1', [T, at(cone, -hw), at(cone, hw)]) +
      rpoly('a1', [T, at(cone * 0.45, -hw * 0.45), at(cone * 0.45, hw * 0.45)])
  },
  extrude(S) {
    // at 16 the plate drops and the block stands on the floor, with its arrow
    const [cx, top, a, i, z0, hz, w, len, hd] = by(S, [15, 12, 7, 1.5, 1, 9, 3, 6, 3], [11, 9, 5, 1, 1, 6, 3, 4, 2.5], [7, 6, 3, 0, 0, 3, 2, 4, 2])
    const o = place(cx, top, a, a, 1)
    const [tx, ty] = o(a / 2, a / 2, hz)
    const x = w % 2 ? tx + 0.5 : tx + 1
    return (S === 16 ? '' : plate(o, a)) + box(o, i, i, a - i, a - i, z0, hz, 'a') + (w ? arrowUp(x, ty - 1, len, hd, w) : '')
  },
  revolve(S) {
    // the solid on its axis, and the arrow turning around it; the same turn at every size, 16 drops the axis
    const [cx, rx, yt, yb, a0, ay, arx, hd, w] = by(S, [15.5, 9, 9, 22, 2, 17, 10.5, 2.5, 2], [11.5, 6, 7, 16, 1, 13, 7.5, 2, 2], [7.5, 3.5, 5, 12, null, 10, 5.5, 1.5, 2])
    const ary = arx * 0.4, L = cx - arx, R = cx + arx
    const axis = a0 === null ? '' : `<path class="lu" style="stroke-width:3px;stroke-linecap:butt" d="M${cx} ${a0}V${yt}"/><path class="lw" style="stroke-width:1px;stroke-linecap:butt" d="M${cx} ${a0}V${yt}"/>`
    return axis + cyl(cx, yt, yb, rx, 'g') +
      stroke(`M${f(L)} ${ay}A${f(arx)} ${f(ary)} 0 0 0 ${f(R)} ${ay}M${f(R - hd)} ${f(ay + hd)}L${f(R)} ${ay}L${f(R + hd)} ${f(ay + hd)}`, w)
  },
  'box-shape'(S) {
    // add a shape: a block and a plus
    const [cx, top, a, h, pc, arm, w] = by(S, [12, 9, 5, 8, [25.5, 7.5], 3, 3], [9, 7, 4, 5, [17.5, 5.5], 2, 3], [5, 5, 2, 4, [12, 4], 2, 2])
    return box(place(cx, top, a, a, h), 0, 0, a, a, 0, h) +
      stroke(`M${pc[0] - arm} ${pc[1]}H${pc[0] + arm}M${pc[0]} ${pc[1] - arm}V${pc[1] + arm}`, w)
  },
  cube(S) {
    const [cx, top, a, h] = by(S, [15, 5, 6, 9], [11, 4, 5, 6], [7, 3, 3, 4])
    return box(place(cx, top, a, a, h), 0, 0, a, a, 0, h)
  },
  cylinder(S) {
    const [cx, rx, yt, yb] = by(S, [15.5, 10, 9, 21.5], [12, 7.5, 6.75, 15.5], [7.5, 5, 5, 10.5])
    return cyl(cx, yt, yb, rx, 'g', cx + rx * 0.2)
  },
  sphere(S) {
    const [c, R] = by(S, [16, 11], [12, 8], [8, 5.5])
    const hx = c - R * 0.32, hy = c - R * 0.36
    const p = (deg, rr = R) => [c + rr * Math.cos((deg * Math.PI) / 180), c + rr * Math.sin((deg * Math.PI) / 180)]
    const [s0, s1] = [p(-35), p(145)]
    const q = (v) => `${f(v[0])} ${f(v[1])}`
    return `<circle class="t2" cx="${c}" cy="${c}" r="${R}"/>` +
      `<path class="t3 nos" d="M${q(s0)}A${R} ${R} 0 0 1 ${q(s1)}A${f(R * 1.25)} ${f(R * 1.25)} 0 0 0 ${q(s0)}Z"/>` +
      `<circle class="t1 nos" cx="${f(hx)}" cy="${f(hy)}" r="${f(R * 0.34)}"/>` +
      `<circle class="out" cx="${c}" cy="${c}" r="${R}"/>`
  },
  cone(S) {
    const [cx, rx, ap, yb] = by(S, [15.5, 11, 3, 22.5], [11.5, 8, 2.5, 16.5], [7.5, 5, 1.5, 11])
    const ry = rx / 2, L = cx - rx, R = cx + rx, sx = cx + rx * 0.2
    const sy = yb + ry * Math.sqrt(1 - 0.04)
    const full = `M${cx} ${ap}L${L} ${yb}A${rx} ${ry} 0 0 0 ${R} ${yb}Z`
    return `<path class="t3 nos" d="${full}"/><path class="t2 nos" d="M${cx} ${ap}L${L} ${yb}A${rx} ${ry} 0 0 0 ${f(sx)} ${f(sy)}Z"/><path class="out" d="${full}"/>`
  },
  'on-face'(S) {
    const [cx, top, a, h, i] = by(S, [15, 6, 6, 7, 1.5], [11, 5, 5, 6, 1], [7, 3, 3, 4, 0.5])
    const o = place(cx, top, a, a, h)
    return box(o, 0, 0, a, a, 0, h) + poly('a1', [o(i, i, h), o(a - i, i, h), o(a - i, a - i, h), o(i, a - i, h)])
  },
  'shape-face'(S) {
    const [cx, top, a, h, rx, bh] = by(S, [15, 9, 7, 5, 5, 6], [11, 7, 5, 4, 4, 4], [7, 5, 3, 3, 3, 3])
    const o = place(cx, top, a, a, h)
    const [x, y] = r(o(a / 2, a / 2, h))
    return box(o, 0, 0, a, a, 0, h) + cyl(x, y - bh, y, rx, 'a')
  },
  'text-face'(S) {
    // a letter set into the front face
    const [cx, top, a, h, bar, stem] = by(S, [15, 5, 6, 9, [1, 5, 6, 7.5], [2.5, 3.5, 1.5, 6]], [11, 4, 4, 7, [0.5, 3.5, 4.5, 5.5], [1.5, 2.5, 1, 4.5]], [7, 3, 3, 5, [0.5, 2.5, 3.5, 4.5], [1, 2, 1, 3.5]])
    const o = place(cx, top, a, a, h)
    const on = ([x0, x1, z0, z1]) => poly('a1', [o(x0, a, z1), o(x1, a, z1), o(x1, a, z0), o(x0, a, z0)])
    return box(o, 0, 0, a, a, 0, h) + on(bar) + on(stem)
  },
  'svg-face'(S) {
    const [cx, top, a, h, p0, p1, w, k] = by(S, [15, 9, 7, 6, [1, 5], [6, 2], 2, 3], [11, 7, 5, 4, [1, 4], [4, 1], 2, 3], [7, 5, 3, 3, [0.5, 2.5], [2.5, 0.5], 1.5, 0])
    const o = place(cx, top, a, a, h)
    const bez = (t) => {
      const c1 = [p0[0], p1[1]], c2 = [p1[0], p0[1]], u = 1 - t
      const x = u ** 3 * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t ** 3 * p1[0]
      const y = u ** 3 * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t ** 3 * p1[1]
      return r(o(x, y, h))
    }
    const pts = Array.from({ length: 13 }, (_, j) => bez(j / 12))
    const [e0, e1] = [pts[0], pts.at(-1)]
    return box(o, 0, 0, a, a, 0, h) + stroke(pd(pts), w) + (k ? knob(e0[0], e0[1], k - 1) + knob(e1[0], e1[1], k - 1) : '')
  },

  // ---------- modify ----------
  push(S) {
    const [cx, top, a, h, i, up, w, len, hd] = by(S, [15, 13, 6, 4, 1.5, 4, 3, 10, 3], [11, 10, 4, 4, 1, 3, 3, 6, 2.5], [7, 6, 3, 3, 1, 2, 2, 4, 2])
    const o = place(cx, top, a, a, h)
    const [tx, ty] = o(a / 2, a / 2, h + up)
    const x = w % 2 ? tx + 0.5 : tx + 1
    const y0 = ty - 1, y1 = y0 - len
    return box(o, 0, 0, a, a, 0, h) + box(o, i, i, a - i, a - i, h, h + up, 'a') +
      stroke(`M${x} ${y0}V${y1}M${x - hd} ${y1 + hd}L${x} ${y1}L${x + hd} ${y1 + hd}${S === 16 ? '' : `M${x - hd} ${y0 - hd}L${x} ${y0}L${x + hd} ${y0 - hd}`}`, w)
  },
  fillet(S) {
    return edgeBreak(S, true)
  },
  chamfer(S) {
    return edgeBreak(S, false)
  },
  shell(S) {
    const [cx, top, a, h, t, d] = by(S, [15, 6, 6, 8, 1, 5], [11, 5, 4, 6, 1, 4], [7, 3, 3, 4, 0.5, 2.5])
    const o = place(cx, top, a, a, h)
    const z = h - d, u = a - t
    const ring = (pts) => 'M' + pts.map((p) => r(p).map(f).join(' ')).join('L') + 'Z'
    return poly('t1', [o(t, t, z), o(u, t, z), o(u, u, z), o(t, u, z)]) +
      vface('t3', [o(t, t, h), o(t, u, h), o(t, u, z), o(t, t, z)]) +
      vface('t2', [o(t, t, h), o(u, t, h), o(u, t, z), o(t, t, z)]) +
      vface('t3', [o(a, 0, h), o(a, a, h), o(a, a, 0), o(a, 0, 0)]) +
      vface('t2', [o(0, a, h), o(a, a, h), o(a, a, 0), o(0, a, 0)]) +
      `<path class="a1" fill-rule="evenodd" d="${ring([o(0, 0, h), o(a, 0, h), o(a, a, h), o(0, a, h)])}${ring([o(t, t, h), o(u, t, h), o(u, u, h), o(t, u, h)])}"/>`
  },
  'hole-fit'(S) {
    const [cx, top, a, h, rx, dp, w] = by(S, [15, 8, 7, 6, 8, 4, 2], [11, 6, 5, 5, 6, 3, 2], [7, 5, 3, 2, 4.5, 1.5, 2])
    const o = place(cx, top, a, a, h)
    const [x, y] = r(o(a / 2, a / 2, h))
    const ry = rx / 2
    const iy = y + dp / 2, ix = rx * Math.sqrt(1 - (dp / 2 / ry) ** 2)
    const wall = `M${f(x - ix)} ${f(iy)}A${rx} ${ry} 0 1 1 ${f(x + ix)} ${f(iy)}A${rx} ${ry} 0 0 0 ${f(x - ix)} ${f(iy)}Z`
    return box(o, 0, 0, a, a, 0, h) + `<path class="hl" d="${ell(x, y, rx, ry)}"/><path class="t3 nos" d="${wall}"/>` + stroke(ell(x, y, rx, ry), w)
  },
  'thread-bolt'(S) {
    if (S === 16) {
      // pixel by pixel: a head, a shaft, and crests that step 2:1 like a helix
      const px = (x, y, w, h, c) => rpoly(c + ' nos', [[x, y], [x + w, y], [x + w, y + h], [x, y + h]])
      const crest = (y) => px(6, y + 1, 2, 1, 'a1') + px(8, y, 2, 1, 'a1') + px(6, y + 2, 2, 1, 'hl') + px(8, y + 1, 2, 1, 'hl')
      return poly('t3', [[5, 6], [10, 6], [10, 14], [5, 14]]) + px(6, 7, 2, 7, 't2') + crest(7) + crest(10) +
        cyl(7.5, 3.5, 5, 4, 'g')
    }
    const [cx, hrx, hyt, hyb, srx, syt, syb, rings, w] = by(S,
      [15.5, 9, 6.5, 10, 5, 11, 26, [16, 20.5, 25], 2],
      [11.5, 7, 5, 7.5, 4, 8, 19, [12.5, 16.5], 2],
      [7.5, 5, 4.5, 6, 3, 7, 13.5, [10.5, 13.5], 1.5])
    const ry = srx / 2
    return cyl(cx, syt, syb, srx, 'g') + cyl(cx, hyt, hyb, hrx, 'g') +
      rings.map((y) => stroke(`M${cx - srx} ${y}A${srx} ${ry} 0 0 0 ${cx + srx} ${f(y - ry * 0.7)}`, w)).join('')
  },
  'subtract-shape'(S) {
    const [cx, top, a, h, n0, zn] = by(S, [15, 5, 6, 8, 3, 4], [11, 4, 4, 6, 2, 3], [7, 3, 3, 4, 2, 2])
    const o = place(cx, top, a, a, h)
    return poly('t3', [o(a, 0, h), o(a, n0, h), o(a, n0, zn), o(a, a, zn), o(a, a, 0), o(a, 0, 0)]) +
      poly('t2', [o(0, a, h), o(n0, a, h), o(n0, a, zn), o(a, a, zn), o(a, a, 0), o(0, a, 0)]) +
      poly('t1', [o(0, 0, h), o(a, 0, h), o(a, n0, h), o(n0, n0, h), o(n0, a, h), o(0, a, h)]) +
      poly('a3', [o(n0, n0, h), o(n0, a, h), o(n0, a, zn), o(n0, n0, zn)]) +
      poly('a2', [o(n0, n0, h), o(a, n0, h), o(a, n0, zn), o(n0, n0, zn)]) +
      poly('a1', [o(n0, n0, zn), o(a, n0, zn), o(a, a, zn), o(n0, a, zn)])
  },
  cut(S) {
    // a flat cutting plane through the part, the top half lifted off it
    const [cx, top, a, z0, zp, z1, z2, e] = by(S, [15, 5, 5, 3, 5, 7, 11, 1], [11, 3, 4, 2, 4, 6, 9, 0.5], [7, 3, 2, 2, 3, 4, 6, 0.5])
    const o = place(cx, top, a, a, z2)
    return box(o, 0, 0, a, a, 0, z0) + poly('a1', [o(-e, -e, zp), o(a + e, -e, zp), o(a + e, a + e, zp), o(-e, a + e, zp)]) + box(o, 0, 0, a, a, z1, z2)
  },
  'array-linear'(S) {
    const [cx, top, k, step, n, h] = by(S, [15, 6, 3, 4, 3, 6], [11, 4, 2, 3, 3, 5], [8, 4, 1.5, 2, 3, 3])
    const ax = step * (n - 1) + k
    const o = place(cx, top, ax, k, h)
    return Array.from({ length: n }, (_, j) => box(o, j * step, 0, j * step + k, k, 0, h, j ? 'a' : 'g')).join('')
  },
  merge(S) {
    // combine: a block and the cylinder joining it
    const [bc, top, a, h, ccx, rx, yt, yb] = by(S, [12, 4, 5, 7, 20.5, 7, 15, 22], [9, 3, 4, 5, 15.5, 5, 12, 16.5], [5, 2, 2, 4, 10.5, 4, 8.5, 11.5])
    return box(place(bc, top, a, a, h), 0, 0, a, a, 0, h) + cyl(ccx, yt, yb, rx, 'a')
  },
  split(S) {
    const [cx, top, ax, b, h, p1, p2] = by(S, [15, 5, 7, 7, 8, [0, 3], [4, 7]], [11, 4, 5, 5, 6, [0, 2], [3, 5]], [8, 2, 5, 2, 5, [0, 2], [3, 5]])
    const o = place(cx, top, ax, b, h)
    return box(o, p1[0], 0, p1[1], b, 0, h) + box(o, p2[0], 0, p2[1], b, 0, h, 'a')
  },

  // ---------- inspect, output ----------
  measure(S) {
    // the part under the dimension arrow it shares with Mesh
    const [cx, top, a, h] = by(S, [15, 13, 6, 5], [11, 10, 4, 4], [7, 8, 2, 3])
    return box(place(cx, top, a, a, h), 0, 0, a, a, 0, h) + dimGlyph(S)
  },
  'named-values'(S) {
    // a part with a named size: an "x =" chip; at 16 the chip fills the icon
    if (S === 16) return rpoly('a1', [[1.5, 3.5], [14.5, 3.5], [14.5, 12.5], [1.5, 12.5]]) + '<path class="out ao" style="stroke-width:1.5px;stroke-linecap:square" d="M4 6L7 10M7 6L4 10M9.5 6.5H12.5M9.5 9.5H12.5"/>'
    const [cx, top, a, h, chip, glyph] = by(S,
      [12, 11, 5, 6, [16.5, 3.5, 29.5, 12.5], 'M19.5 6.5L22.5 9.5M22.5 6.5L19.5 9.5M24.5 6.5H27.5M24.5 9.5H27.5'],
      [9, 8, 4, 5, [12.5, 2.5, 21.5, 9.5], 'M14.5 4.5L16.5 7.5M16.5 4.5L14.5 7.5M17.5 4.5H19.5M17.5 7.5H19.5'])
    const [x0, y0, x1, y1] = chip
    return box(place(cx, top, a, a, h), 0, 0, a, a, 0, h) + rpoly('a1', [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]) +
      `<path class="out ao" style="stroke-linecap:square" d="${glyph}"/>`
  },
  export(S) {
    return exportIcon(S, 'g')
  },
  'export-selection'(S) {
    // the selected part outlined in accent, the rest gray, and out it goes
    if (S === 16) {
      const o = place(5, 4, 2, 2, 4)
      return box(o, 0, 0, 2, 2, 0, 4) + stroke(pd([o(0, 0, 4), o(2, 0, 4), o(2, 0, 0), o(2, 2, 0), o(0, 2, 0), o(0, 2, 4)].map(r)) + 'Z', 1.5) + stroke('M10 8H14M12 6L14 8L12 10', 2)
    }
    const [A, B, d, w] = by(S,
      [[8, 5, 3, 4], [13, 12, 4, 5], 'M21.5 19.5H27.5M24.5 16.5L27.5 19.5L24.5 22.5', 3],
      [[6, 4, 2, 3], [10, 9, 3, 4], 'M16 14H21M18 11L21 14L18 17', 2])
    const oa = place(A[0], A[1], A[2], A[2], A[3]), ob = place(B[0], B[1], B[2], B[2], B[3]), k = B[2], hb = B[3]
    const sil = [ob(0, 0, hb), ob(k, 0, hb), ob(k, 0, 0), ob(k, k, 0), ob(0, k, 0), ob(0, k, hb)].map(r)
    return box(oa, 0, 0, A[2], A[2], 0, A[3]) + box(ob, 0, 0, k, k, 0, hb) + stroke(pd(sil) + 'Z', 2) + stroke(d, w)
  },
  'project-file'(S) {
    const [page, fold, cx, top, a, h] = by(S,
      ['M7.5 3.5H19.5L25.5 9.5V28.5H7.5Z', 'M19.5 3.5V9.5H25.5Z', 16, 14, 3, 3],
      ['M5.5 2.5H14.5L19.5 7.5V21.5H5.5Z', 'M14.5 2.5V7.5H19.5Z', 12, 10, 2, 3],
      ['M3.5 1.5H9.5L12.5 4.5V14.5H3.5Z', 'M9.5 1.5V4.5H12.5Z', 8, 6, 2, 2])
    return `<path class="t1" d="${page}"/><path class="t2" d="${fold}"/>` + box(place(cx, top, a, a, h), 0, 0, a, a, 0, h, 'a')
  },

  // ---------- mesh ----------
  // every mesh tool sits on the same faceted mound, never the solid box; the shared actions use the Solid glyphs
  'repair-mesh'(S) {
    // one roof triangle missing, a dark hole, and the purple patch dropping in to fill it
    if (S === 16) {
      // the left roof face is the hole; the same shape, outlined, is the patch floating above it
      // the right roof face is the gap, the patch a solid triangle two rows above it
      const patch = ['...A...', '..AAA..', '.AAAAA.', 'AAAAAAA']
      return pix(remap(MOUND16, (ch) => (ch === 'b' ? 'h' : ch)), 3, 8) + pix(patch, 7, 2)
    }
    const [x, y, k] = xAt(S), m = body(S, x + by(S, 2, 1, 1), y + by(S, 3, 2, 3), k)
    return m.all({ a: 'hl' }) + poly('a1', shift(m.pts('a'), -by(S, 2, 1, 1), -by(S, 6, 4, 4)))
  },
  'simplify-mesh'(S) {
    // the left still in fine facets, the right reduced to one clean face
    if (S === 16) {
      // the right roof face clean in accent; two more lines split the left roof and wall into smaller facets
      // the left still in facets (two more lines), the right roof and wall one accent face
      const fine = [[1, 4], [2, 5], [3, 6]]
      const is = (list, x, y) => list.some(([fx, fy]) => fx === x && fy === y)
      return pix(remap(MOUND16, (ch, x, y) => ('br'.includes(ch) ? 'A' : is(fine, x, y) ? 'o' : ch)), 2, 4)
    }
    const [x, y, k] = xAt(S), m = body(S, x, y, k), { l, f, F, L, s: sp, r, R, q, m: mv } = m.P
    const fine = m.edge(l, F) + m.edge(m.half(l, f), k >= 2 ? mv : m.P.q) + (S > 16 ? m.edge(m.half(l, q), mv) + m.edge(f, m.half(L, F)) : '')
    return m.all({}, ['c', 'e']) + poly('a1', k >= 2 ? [mv, sp, r, f] : [sp, r, f]) + fine
  },
  hollow(S) {
    // the roof taken off: the wall's thickness in accent round the rim, the cavity dark inside (Shell's mark on the mound)
    if (S === 16) {
      // the roof gone: the lines round it in dark accent, one pixel of wall thickness inside, the cavity dark
      // the roof off: an accent rim round a dark cavity, the walls as they are
      const open = ['....A......', '...AhAA....', '.AAhhhhAA..', 'oAhhhhhhhAo', 'olAAhhhAAro', 'oollAAArroo', '..ooloroo..', '....ooo....']
      return pix(open, 2, 5)
    }
    const [x, y, k] = xAt(S), m = body(S, x, y, k), { l, q, s: sp, r, f } = m.P
    const rim = [l, q, sp, r, f]
    const cx = rim.reduce((a, p) => a + p[0], 0) / rim.length, cy = rim.reduce((a, p) => a + p[1], 0) / rim.length
    const w = by(S, 0.3, 0.34, 0.4)
    const cavity = rim.map(([px, py]) => [Math.round(px + (cx - px) * w), Math.round(py + (cy - py) * w)])
    const roof = m.order.filter((id) => !id.startsWith('w'))
    return m.all({}, roof) + poly('a1', rim) + poly('hl nos', cavity)
  },
  orient(S) {
    // the mound tipped up on one edge, its flat base (accent) turning down onto the bed
    const [x, y, k, rot] = by(S, [5, 4, 1.6, -24], [3, 3, 1.25, -24], [1, 1, 0.85, -24])
    const m = body(S, x, y, k, rot), { L, F, R } = m.P
    const [x0, x1, yb] = by(S, [2, 29, 27], [2, 21, 20], [1, 14, 13])
    const bed = poly('t2', [[x0, yb], [x1, yb], [x1, yb + 2], [x0, yb + 2]])
    const base = S === 16 ? '' : stroke(pd([L, F, R].map(([a, b]) => [a + 0.5, b + 0.5])), 2)
    const [ax, ay, rr, hd, w] = by(S, [25, 6, 4.5, 3, 2], [18, 5, 4, 2.5, 2], [12.5, 3.5, 2.5, 2, 1.5])
    const e = [ax + rr, ay + rr * 0.9]
    const arrow = stroke(`M${ax - rr} ${ay}A${rr} ${rr} 0 0 1 ${f(e[0])} ${f(e[1])}M${f(e[0] - hd)} ${f(e[1] - hd * 0.4)}L${f(e[0])} ${f(e[1])}L${f(e[0] + hd * 0.4)} ${f(e[1] - hd)}`, w)
    return bed + m.all() + base + arrow
  },
  'mesh-cut'(S) {
    // the cutting plane through the mound, the top lifted off it: Cut's plane on the mesh body
    if (S === 16) {
      const plane = ['....AAAAAAA....', 'AAAAAAAAAAAAAAA', '....AAAAAAA....']
      return pix(rows(MOUND16, 0, 3), 2, 1) + pix(plane, 0, 6) + pix(rows(MOUND16, 4, 7), 2, 9)
    }
    const [x, y, k] = xAt(S), m = body(S, x, y + by(S, 2, 2, 1), k), { f: fr, q } = m.P
    const cy = Math.round(fr[1] - (fr[1] - q[1]) * 0.5)
    const lift = by(S, 4, 3, 3)
    const piece = (id, less, dy) => { const p = clip(m.pts(id), 1, cy, less); return p.length > 2 ? poly(m.tone(id), shift(p, 0, dy)) : '' }
    const low = m.order.map((id) => piece(id, false, 0)).join('')
    const up = m.order.map((id) => piece(id, true, -lift)).join('')
    const xs = m.order.flatMap((id) => clip(m.pts(id), 1, cy, false)).filter((p) => p[1] === cy).map((p) => p[0])
    const xl = Math.min(...xs), xr = Math.max(...xs)
    return low + cutPlane((xl + xr) / 2, cy, (xr - xl) / 2 + by(S, 2, 1.5, 0.5)) + up
  },
  'mesh-split'(S) {
    // the mound split down its front corner, the far piece pulled off in accent
    if (S === 16) {
      // the ridge column is the gap; the right half lifts one row and goes accent
      const right = remap(cols(MOUND16, 6, 10), (ch) => ({ b: 'A', r: 'B', o: 'P' })[ch])
      return pix(cols(MOUND16, 0, 4), 2, 5) + pix(right, 8, 4)
    }
    const [x, y, k] = xAt(S), m = body(S, x - by(S, 2, 1, 1), y + by(S, 1, 1, 1), k), cx = m.P.F[0]
    const [gx, gy] = by(S, [4, 2], [3, 2], [2, 1])
    const tone = { wl: 'a2', wr: 'a3', a: 'a1', b: 'a1', c: 'a2', d: 'a1', e: 'a2' }
    const a = m.order.map((id) => { const p = clip(m.pts(id), 0, cx, true); return p.length > 2 ? poly(m.tone(id), p) : '' }).join('')
    const b = m.order.map((id) => { const p = clip(m.pts(id), 0, cx, false); return p.length > 2 ? poly(tone[id], shift(p, gx, -gy)) : '' }).join('')
    return a + b
  },
  'mesh-measure'(S) {
    // the mound under the dimension arrow
    if (S === 16) return pix(MOUND16, 2, 8) + dimGlyph(S)
    const [x, y, k] = by(S, [5, 12, 1.7], [4, 9, 1.25])
    return body(S, x, y, k).all() + dimGlyph(S)
  },
  'mesh-export'(S) {
    if (S === 16) return pix(MOUND16, 0, 5) + exportGlyph(S)
    const [x, y, k] = by(S, [1, 9, 1.5], [1, 7, 1.1])
    return body(S, x, y, k).all() + exportGlyph(S)
  },
  // ---------- sketch ----------
  // draw and edit tools are weightless 2D: one 2px accent line on nothing, white square nodes at ends and corners
  'select-object'(S) {
    // the pointer alone: a node on its tip would blunt it
    const { P } = skBox(S)
    const tip = P(0.15, 0.05)
    const k = by(S, 1.15, 0.85, 0.62)
    const arrow = [[0, 0], [0, 15], [3.5, 11.5], [6, 17], [8.5, 16], [6, 10.5], [11, 10.5]].map(([x, y]) => [tip[0] + x * k, tip[1] + y * k])
    return `<path class="skf nos" d="${pd(arrow.map(([x, y]) => [Math.round(x), Math.round(y)]))}Z"/>`
  },
  'sk-line'(S) {
    const { P } = skBox(S)
    const a = P(0, 1), b = P(1, 0)
    return skl(pd([a, b])) + node(...a) + node(...b)
  },
  'sk-rect'(S) {
    const { P } = skBox(S)
    const [x0, y0] = P(0, 0.15), [x1, y1] = P(1, 0.85)
    return skl(`M${x0} ${y0}H${x1}V${y1}H${x0}Z`) + node(x0, y0) + node(x1, y0) + node(x1, y1) + node(x0, y1)
  },
  'sk-circle'(S) {
    const { P, w } = skBox(S)
    const c = P(0.5, 0.5), rr = w / 2
    return skl(ell(c[0], c[1], rr, rr)) + node(...c)
  },
  'sk-arc'(S) {
    const { P, w } = skBox(S)
    const a = P(0, 1), b = P(1, 0)
    return skl(`M${a[0]} ${a[1]}A${w} ${w} 0 0 1 ${b[0]} ${b[1]}`) + node(...a) + node(...b)
  },
  'sk-polygon'(S) {
    const { P, w } = skBox(S)
    const c = P(0.5, 0.5), R = (w / 2) / Math.cos(Math.PI / 6)
    const v = Array.from({ length: 6 }, (_, k) => [Math.round(c[0] + R * Math.cos(((-90 + 60 * k) * Math.PI) / 180) * 0.98), Math.round(c[1] + R * Math.sin(((-90 + 60 * k) * Math.PI) / 180) * 0.98)])
    return skl(pd(v) + 'Z') + v.filter((_, k) => S > 16 || k % 2 === 0).map((p) => node(...p)).join('')
  },
  'sk-slot'(S) {
    const { P, w } = skBox(S)
    const rr = Math.round(w * by(S, 0.27, 0.28, 0.3)), [, y] = P(0, 0.5), [a] = P(0, 0), [c] = P(1, 0)
    const l = a + rr, r = c - rr
    return skl(`M${l} ${y - rr}H${r}A${rr} ${rr} 0 0 1 ${r} ${y + rr}H${l}A${rr} ${rr} 0 0 1 ${l} ${y - rr}Z`) + (S > 16 ? node(l, y) + node(r, y) : '')
  },
  'sk-spline'(S) {
    const { P, w } = skBox(S)
    const a = P(0, 1), b = P(1, 0)
    return skl(`M${a[0]} ${a[1]}C${a[0] + w * 0.3} ${b[1] - w * 0.1} ${b[0] - w * 0.3} ${a[1] + w * 0.1} ${b[0]} ${b[1]}`) + node(...a) + node(...b)
  },
  trim(S) {
    // a curve meets an edge; the piece past it is cut off and goes faint and dashed
    const { P, w } = skBox(S)
    const [xe] = P(0.58, 0), [, y0] = P(0, 0), [, y1] = P(0, 1), a = P(0, 1), b = P(1, 0)
    const ym = Math.round((y0 + y1) / 2) + by(S, 1, 1, 0)
    const dash = by(S, '3 2', '2 2', '2 1')
    return skl(`M${xe} ${y0}V${y1}`) +
      skl(`M${a[0]} ${a[1]}Q${a[0] + (xe - a[0]) * 0.35} ${ym} ${xe} ${ym}`) +
      skl(`M${xe} ${ym}Q${xe + (b[0] - xe) * 0.5} ${ym - w * 0.1} ${b[0]} ${b[1]}`, 'skc', `stroke-dasharray:${dash}`) +
      node(...a) + node(xe, ym)
  },
  dimension(S) {
    // an edge with its nodes, and its size marked off above it
    const { P } = skBox(S)
    const [x0, ye] = P(0, 0.92), [x1] = P(1, 0), [, yt] = P(0, 0.1), [, yd] = P(0, 0.32)
    const hd = by(S, 4, 3, 2)
    return skl(`M${x0} ${ye}H${x1}`) + node(x0, ye) + node(x1, ye) +
      skl(`M${x0} ${yt}V${ye - 4}M${x1} ${yt}V${ye - 4}`, 'skc') +
      skl(`M${x0 + 1} ${yd}H${x1 - 1}M${x0 + hd + 1} ${yd - hd}L${x0 + 1} ${yd}L${x0 + hd + 1} ${yd + hd}M${x1 - hd - 1} ${yd - hd}L${x1 - 1} ${yd}L${x1 - hd - 1} ${yd + hd}`)
  },
  mirror(S) {
    // a profile, the line it mirrors across, and the copy on the far side
    const { P } = skBox(S)
    const [m, y0] = P(0.5, 0), [, y1] = P(0, 1), g = by(S, 3, 2, 2)
    const [xl] = P(0, 0), [xr] = P(1, 0), [, yt] = P(0, 0.12), [, yb] = P(0, 0.88)
    const L = [[m - g, yt], [m - g, yb], [xl, yb]], R = L.map(([x, y]) => [2 * m - x, y])
    return skl(`M${m} ${y0}V${y1}`, 'skc', `stroke-dasharray:${by(S, '3 2', '2 2', '2 1')}`) + skl(pd(L) + 'Z', 'skc') +
      skl(pd(R) + 'Z') + R.filter((_, k) => S > 16 || k !== 1).map((p) => node(...p)).join('')
  },
  'look-at'(S) {
    // an eye straight over the sketch plane, looking down at it square on
    const pl = skPlate(S, by(S, 6, 5, 4))
    if (S === 16) {
      // pixel by pixel: the lids, a 3 by 3 pupil, and the line down to the plane
      const px = (x, y, w, h, c) => rpoly(c + ' nos', [[x, y], [x + w, y], [x + w, y + h], [x, y + h]])
      const lids = px(6, 0, 3, 1, 'a2') + px(4, 1, 2, 1, 'a2') + px(9, 1, 2, 1, 'a2') + px(3, 2, 1, 1, 'a2') + px(11, 2, 1, 1, 'a2') + px(4, 3, 2, 1, 'a2') + px(9, 3, 2, 1, 'a2') + px(6, 4, 3, 1, 'a2')
      return pl.base + lids + px(6, 1, 3, 3, 'a1') + px(7, 2, 1, 1, 'pa')
    }
    const [cx, cy, rx, ry, pr, w] = by(S, [15.5, 7, 7.5, 5, 2.25, 2], [11.5, 5.5, 5.5, 3.75, 1.75, 2])
    return pl.base + stroke(`M${cx - rx} ${cy}Q${cx} ${cy - ry * 2} ${cx + rx} ${cy}Q${cx} ${cy + ry * 2} ${cx - rx} ${cy}Z`, w) +
      `<circle class="a1 ao" cx="${cx}" cy="${cy}" r="${pr}"/>`
  },
  'sketch-finish'(S) {
    // done: a check drawn the sketch way
    const { P } = skBox(S)
    const a = P(0.1, 0.65), b = P(0.36, 0.88), c = P(1, 0.12)
    return skl(pd([a, b, c])) + node(...a) + node(...b) + node(...c)
  },
}

function edgeBreak(S, round) {
  // the top edge broken, shown where its profile cuts the end face's outline: fillet a quarter round, chamfer a 45 degree
  // notch. The accent is only the new surface; the fillet's shades from lit at the top to dark at the side
  const [cx, top, a, h, rr] = by(S, [15, 6, 6, 8, 4], [11, 4, 4, 7, 3], [7, 3, 3, 5, 2])
  const o = place(cx, top, a, a, h)
  const N = 12
  const prof = (y) => round
    ? Array.from({ length: N + 1 }, (_, k) => {
      const t = (k / N) * (Math.PI / 2)
      return o(a - rr + rr * Math.sin(t), y, h - rr + rr * Math.cos(t))
    })
    : [o(a - rr, y, h), o(a, y, h - rr)]
  const near = prof(a), far = prof(0)
  const band = round
    ? [[0, 4, 'a1'], [4, 8, 'a2'], [8, N, 'a3']].map(([p, q, c]) => poly(c + ' nos', [...near.slice(p, q + 1), ...far.slice(p, q + 1).reverse()])).join('') + poly('out ao', [...near, ...[...far].reverse()])
    : poly('a2', [...near, ...[...far].reverse()])
  const zs = h * 0.45
  return vface('t3', [o(a, 0, h - rr), o(a, a, h - rr), o(a, a, 0), o(a, 0, 0)]) +
    poly('t2', [o(0, a, h), ...near, o(a, a, 0), o(0, a, 0)]) + poly('sh nos', [o(0, a, zs), o(a, a, zs), o(a, a, 0), o(0, a, 0)]) +
    tface('t1', [o(0, 0, h), o(a - rr, 0, h), o(a - rr, a, h), o(0, a, h)]) + band
}

function exportIcon(S, top) {
  const [cx, t, a, h] = by(S, [11, 6, 5, 9], [8, 5, 3, 7], [5, 4, 2, 4])
  return box(place(cx, t, a, a, h), 0, 0, a, a, 0, h, top) + exportGlyph(S)
}

/** each icon's name in the app, the tab and group the ribbon puts it in */
export const SET = [
  ['Solid · Create', ['sketch', 'extrude', 'revolve', 'box-shape', 'cube', 'cylinder', 'sphere', 'cone', 'on-face', 'shape-face', 'text-face', 'svg-face']],
  ['Solid · Modify', ['push', 'fillet', 'chamfer', 'shell', 'hole-fit', 'thread-bolt', 'subtract-shape', 'cut', 'array-linear', 'merge', 'split']],
  ['Solid · Inspect and output', ['measure', 'named-values', 'export', 'export-selection', 'project-file']],
  ['Mesh', ['repair-mesh', 'simplify-mesh', 'hollow', 'orient', 'mesh-cut', 'mesh-split', 'mesh-measure', 'mesh-export']],
  ['Sketch', ['select-object', 'sk-line', 'sk-rect', 'sk-circle', 'sk-arc', 'sk-polygon', 'sk-slot', 'sk-spline', 'trim', 'dimension', 'mirror', 'look-at', 'sketch-finish']],
]

