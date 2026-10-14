// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The tool icons in the tooltip loops' language. Each icon is the loop's primitive (block, cylinder, mesh mound,
// sketch plane, or bare sketch strokes) with the tool's one action on it in the accent. 32 and 24 are vector; 16 is
// placed pixel by pixel, one silhouette and one accent feature, inside a 14 px box. Cut, measure and export keep one
// mark across Solid and Mesh; the body under the mark says the workspace.
import { ACC, arrow, boxFaces, ctx, cyl, exporter, fill, glyph, grid, mask, measure, node, nodeAt, pixels, put, Q, solid, stamp, wrap } from './kit.mjs'

const r2 = (v) => Math.round(v * 100) / 100
const lerp = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t)
const quarter = (cx, cz, rad, y, n = 7) => Array.from({ length: n }, (_, i) => {
  const a = (i / (n - 1)) * (Math.PI / 2)
  return [cx + rad * Math.cos(a), y, cz + rad * Math.sin(a)]
})
const edge = (m) => {
  const out = []
  for (let j = 0; j < 16; j++) for (let i = 0; i < 16; i++) if (m[j][i] === '#' && [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([a, b]) => m[j + b]?.[i + a] !== '#')) out.push([i, j])
  return out
}

// ---------- vector bodies ----------
const M = { b: 6.5, t0: 1.6, t1: 4.9, h: 3 }
function moundPts(o = {}) {
  const { b, t0, t1, h } = { ...M, ...o }
  return { L: [0, b, 0], F: [b, b, 0], R: [b, 0, 0], TR: [t1, t0, h], TB: [t0, t0, h], TL: [t0, t1, h], TF: [t1, t1, h] }
}
function mound(c, o = {}, top = 't1', wire = true) {
  const m = moundPts(o)
  let s = c.poly('t2', m.L, m.F, m.TF, m.TL) + c.poly('t3', m.R, m.F, m.TF, m.TR) + c.poly(top, m.TB, m.TR, m.TF, m.TL)
  if (wire) s += c.line('mesh', [m.L, m.TF]) + c.line('mesh', [m.R, m.TF]) + c.line('mesh', [m.TR, m.TL])
  return s
}
const cube = (c, z = 4.5, w = 6) => c.box([0, 0, 0], [w, w, z])
const plane = (c, w = 7) => c.box([0, 0, -0.4], [w, w, 0])
/** points in the plane of a block's left face (y = Y): u runs along x, v up z */
const onLeft = (Y, ps) => ps.map(([u, v]) => [u, Y, v])
/** the mound between two heights, lifted by `lift` */
function moundSlab(c, z0, z1, lift = 0) {
  const { b, t0, t1, h } = M
  const at = (z) => { const t = z / h; return { lo: t0 * t, hi: b - (b - t1) * t } }
  const A = at(z0), B = at(z1)
  const L = (z, s) => [s.lo, s.hi, z + lift], F = (z, s) => [s.hi, s.hi, z + lift], R = (z, s) => [s.hi, s.lo, z + lift], K = (z, s) => [s.lo, s.lo, z + lift]
  return c.poly('t2', L(z0, A), F(z0, A), F(z1, B), L(z1, B)) + c.poly('t3', R(z0, A), F(z0, A), F(z1, B), R(z1, B)) + c.poly('t1', K(z1, B), R(z1, B), F(z1, B), L(z1, B))
}

// ---------- pixel bodies ----------
const MB = 7, MT0 = 2, MT1 = 5, MH = 5
const moundFaces = (q, t = ['1', '2', '3'], o = {}) => {
  const { B, T0, T1, H } = { B: MB, T0: MT0, T1: MT1, H: MH, ...o }
  return [
    [[q(0, B, 0), q(B, B, 0), q(T1, T1, H), q(T0, T1, H)], t[1]],
    [[q(B, 0, 0), q(B, B, 0), q(T1, T1, H), q(T1, T0, H)], t[2]],
    [[q(T0, T0, H), q(T1, T0, H), q(T1, T1, H), q(T0, T1, H)], t[0]],
  ]
}
/** an upright cylinder at 16: top ellipse centered (cx, y0), body down to y1, radius rx across */
function cyl16(g, cx, y0, y1, rx, t = ['1', '2', '3'], ol = 'o') {
  const ry = rx / 2, N = 16
  const arc = (y, from, to) => Array.from({ length: N + 1 }, (_, i) => { const a = from + ((to - from) * i) / N; return [cx + rx * Math.cos(a), y + ry * Math.sin(a)] })
  const split = cx + rx * 0.25
  const low = arc(y1, Math.PI, 0)
  const left = [[cx - rx, y0], ...low.filter(([x]) => x <= split), [split, y1 + ry], [split, y0]]
  const right = [[split, y0], [split, y1 + ry], ...low.filter(([x]) => x > split), [cx + rx, y0]]
  return solid(g, [[left, t[1]], [right, t[2]], [arc(y0, 0, 2 * Math.PI), t[0]]], ol)
}
const ring = (cx, cy, rx, ry, n = 24) => Array.from({ length: n }, (_, i) => [cx + rx * Math.cos((i / n) * 2 * Math.PI), cy + ry * Math.sin((i / n) * 2 * Math.PI)])
function measure16(g, x, y) {
  put(g, [[x, y - 1], [x, y], [x, y + 1], [x + 8, y + 3], [x + 8, y + 4], [x + 8, y + 5]], 'l')
  for (let i = 1; i < 8; i++) put(g, [[x + i, y + Math.floor(i / 2)]], 'l')
}
const exporter16 = (g, x, y) => glyph(g, x, y - 5, ['  aaaa', '   aaa', '  aaaa', ' aaa a', 'aaa   ', 'aa    '])
const arrowUp16 = (g, x, y) => glyph(g, x, y, ['  aa  ', ' aaaa ', 'aaaaaa'])
/** the cut plane at 16: an accent rhombus across the body, centered on row y, cols x0 to x1 */
const plane16 = (g, x0, x1, y) => { const cx = (x0 + x1 + 1) / 2, hw = (x1 + 1 - x0) / 2; fill(g, [[x0, y], [cx, y - hw / 2], [x1 + 1, y], [cx, y + hw / 2]], 'a') }
/** halve a 16 px drawing down column `at`: the left keeps its colors, the right moves `gap` px right in the accent */
function halve(m, at, gap) {
  const g = grid(), tone = { 1: 'a', 2: 'b', 3: 'c', o: 'd' }
  for (let j = 0; j < 16; j++)
    for (let i = 0; i < 16; i++) {
      const v = m[j][i]
      if (v === '.') continue
      if (i < at) g[j][i] = i === at - 1 ? 'o' : v
      else if (i + gap < 16) g[j][i + gap] = i === at ? 'd' : tone[v] ?? v
    }
  return g
}

/** the shared cut mark at 16: a 2 row accent band across the whole box at row y, drawn under what comes after */
const cutBand = (g, y) => { for (let i = 1; i <= 14; i++) put(g, [[i, y], [i, y + 1]], i === 1 || i === 14 ? 'd' : 'a'); for (let i = 2; i <= 13; i++) put(g, [[i, y - 1], [i, y + 2]], 'd') }

const V = {}, G = {}

// ---------- Solid · Create ----------
V.sketch = (c) => {
  const p = (u, v) => c.P(u, v, 0)
  const sq = [p(1.4, 1.4), p(5.6, 1.4), p(5.6, 5.6), p(1.4, 5.6)]
  return plane(c) + `<path class="sk" d="M${sq.map((q) => q.join(' ')).join('L')}Z"/>` + node(c, ...p(1.4, 5.6)) + node(c, ...p(5.6, 1.4))
}
G.sketch = () => {
  const g = grid(), q = Q(8, 8)
  solid(g, boxFaces(q, [0, 0, -1], [7, 7, 0]))
  put(g, edge(mask([q(1.2, 1.2, 0), q(5.8, 1.2, 0), q(5.8, 5.8, 0), q(1.2, 5.8, 0)])), 'l')
  return g
}
V['sketch-finish'] = (c) => {
  const [a, b, d] = [c.P(1.6, 4.2, 0.2), c.P(3.4, 6, 0.2), c.P(6, 1.6, 0.2)]
  return plane(c) + `<path class="sk" style="stroke-width:${c.sz === 32 ? 3 : 2.5}px;stroke-linecap:round;stroke-linejoin:round" d="M${a.join(' ')}L${b.join(' ')}L${d.join(' ')}"/>`
}
G['sketch-finish'] = () => {
  const g = grid(), q = Q(8, 9)
  solid(g, boxFaces(q, [0, 0, -1], [7, 7, 0]))
  stamp(g, 3, 3, ['         ll', '        lll', '       lll ', 'll    lll  ', 'lll  lll   ', ' lllll     ', '  lll      '])
  return g
}
V.extrude = (c) => {
  const s = plane(c) + c.abox([2, 2, 0], [5, 5, 3])
  const [x, y] = c.P(3.5, 3.5, 3)
  const L = c.sz === 32 ? 8 : 6
  return s + node(c, ...c.P(2, 5, 0)) + node(c, ...c.P(5, 5, 0)) + node(c, ...c.P(5, 2, 0)) + arrow(c, x, y - L - 3 * c.k, 0, L)
}
G.extrude = () => {
  const g = grid(), q = Q(8, 9)
  solid(g, boxFaces(q, [2, 2, 0], [5, 5, 4], ACC), 'd')
  for (let i = 1; i <= 14; i++) if (g[12][i] === '.') put(g, [[i, 12], [i, 13]], 's'); else put(g, [[i, 13]], 's')
  arrowUp16(g, 6, 3)
  return g
}
V.revolve = (c) => {
  const s = cyl(c, 3, 3, 0, 5, 2.1)
  const d = c.disc(3, 3, 2.2, 3.3)
  const x0 = r2(d.cx - d.rx), x1 = r2(d.cx + d.rx), h = c.k * 4
  c.mark(x0, d.cy + d.ry); c.mark(x1 + h, d.cy - h)
  return s + `<path class="sk" d="M${x0} ${d.cy}A${d.rx} ${d.ry} 0 0 0 ${x1} ${d.cy}"/>` +
    `<path class="a1" d="M${x1} ${r2(d.cy - h * 1.3)}L${r2(x1 + h)} ${r2(d.cy + h * 0.4)}L${r2(x1 - h)} ${r2(d.cy + h * 0.4)}Z"/>`
}
G.revolve = () => {
  // the cylinder, and one 2 px accent turn round its front with its head up at the right
  const g = grid()
  cyl16(g, 7.5, 3.5, 11.5, 4)
  for (let x = 2; x <= 12; x++) {
    const t = (x + 0.5 - 7.5) / 5.5, y = 8 + Math.round(2.5 * Math.sqrt(Math.max(0, 1 - t * t)))
    put(g, [[x, y], [x, y + 1]], 'l')
  }
  glyph(g, 11, 4, ['  a', ' aa', 'aaa', ' aa'])
  return g
}
V['box-shape'] = (c) => cyl(c, 6, 1, 0, 4.5, 1.8) + c.abox([0, 2.2, 0], [4, 6.2, 3.6])
G['box-shape'] = () => {
  const g = grid()
  cyl16(g, 10.5, 3.5, 9.5, 3)
  solid(g, boxFaces(Q(6, 8.5), [0, 0, 0], [4.5, 4.5, 4.5], ACC), 'd')
  return g
}
V.cube = (c) => c.abox([0, 0, 0], [6, 6, 5])
G.cube = () => { const g = grid(); solid(g, boxFaces(Q(8, 8.5), [0, 0, 0], [6, 6, 6], ACC), 'd'); return g }
V.cylinder = (c) => cyl(c, 3, 3, 0, 5.5, 2.8, true)
G.cylinder = () => { const g = grid(); cyl16(g, 7.5, 3.5, 11, 5.5, ACC, 'd'); return g }
V.sphere = (c) => {
  const R = 11 * c.k, cx = 16 * c.k, cy = 16 * c.k
  c.mark(cx - R, cy - R); c.mark(cx + R, cy + R)
  return `<ellipse class="a2" cx="${cx}" cy="${cy}" rx="${R}" ry="${R}"/><ellipse class="a1 nos" cx="${r2(cx - R * 0.25)}" cy="${r2(cy - R * 0.25)}" rx="${r2(R * 0.66)}" ry="${r2(R * 0.66)}"/><ellipse class="nf out ao" cx="${cx}" cy="${cy}" rx="${R}" ry="${R}"/>`
}
G.sphere = () => { const g = grid(); solid(g, [[ring(8, 8, 6.5, 6.5), 'b'], [ring(7, 7, 4, 4), 'a']], 'd'); return g }
V.cone = (c) => {
  const b = c.disc(3, 3, 0, 3), [ax, ay] = c.P(3, 3, 6.5)
  return `<path class="cya out ao" d="M${ax} ${ay}L${r2(b.cx - b.rx)} ${b.cy}A${b.rx} ${b.ry} 0 0 0 ${r2(b.cx + b.rx)} ${b.cy}Z"/>`
}
G.cone = () => {
  const g = grid()
  const base = Array.from({ length: 17 }, (_, i) => { const a = Math.PI - (i / 16) * Math.PI; return [8 + 6 * Math.cos(a), 11 + 3 * Math.sin(a)] })
  solid(g, [[[[8, 1.5], ...base.filter(([x]) => x <= 9.2), [9.2, 14]], 'b'], [[[8, 1.5], [9.2, 14], ...base.filter(([x]) => x > 9.2)], 'c']], 'd')
  return g
}
V['on-face'] = (c) => cube(c, 5) + c.poly('a2', ...onLeft(6, [[1.4, 1.2], [4.6, 1.2], [4.6, 3.8], [1.4, 3.8]]))
G['on-face'] = () => {
  // the block with its picked face in the accent
  const g = grid(), q = Q(8, 8.5)
  solid(g, boxFaces(q, [0, 0, 0], [6, 6, 6], ['1', 'b', '3']))
  return g
}
V['shape-face'] = (c) => cube(c, 3.6) + cyl(c, 3, 3, 3.6, 5, 1.9, true)
G['shape-face'] = () => {
  const g = grid()
  solid(g, boxFaces(Q(8, 10.5), [0, 0, 0], [6, 6, 5]))
  cyl16(g, 8, 6, 7.5, 3, ACC, 'd')
  return g
}
V['text-face'] = (c) => cube(c, 5) + c.poly('a2', ...onLeft(6, [[1, 4.2], [5, 4.2], [5, 3.3], [3.5, 3.3], [3.5, 0.8], [2.5, 0.8], [2.5, 3.3], [1, 3.3]]))
G['text-face'] = () => {
  const g = grid(), q = Q(8, 8.5)
  solid(g, boxFaces(q, [0, 0, 0], [6, 6, 6]))
  fill(g, [q(0.8, 6, 5), q(5.2, 6, 5), q(5.2, 6, 4), q(0.8, 6, 4)], 'b')
  fill(g, [q(2.4, 6, 4), q(3.6, 6, 4), q(3.6, 6, 0.8), q(2.4, 6, 0.8)], 'b')
  return g
}
V['svg-face'] = (c) => {
  const pts = Array.from({ length: 13 }, (_, i) => [0.9 + (i / 12) * 4.2, 6, 2.5 + 1.2 * Math.sin((i / 12) * 2 * Math.PI)])
  return cube(c, 5) + c.line('sk', pts, ' style="stroke-linejoin:round;stroke-linecap:round"') + node(c, ...c.P(...pts[0])) + node(c, ...c.P(...pts[12]))
}
G['svg-face'] = () => {
  const g = grid(), q = Q(8, 8.5)
  solid(g, boxFaces(q, [0, 0, 0], [6, 6, 6]))
  for (let i = 0; i <= 10; i++) {
    const [x, y] = q(0.6 + (i / 10) * 4.8, 6, 3 + 1.4 * Math.sin((i / 10) * 2 * Math.PI))
    put(g, [[Math.floor(x), Math.floor(y)]], 'l')
  }
  return g
}

// ---------- Solid · Modify ----------
V.push = (c) => {
  const s = c.box([0, 0, 0], [6, 6, 2.6]) + c.abox([0, 0, 2.6], [6, 6, 4.4])
  const [x, y] = c.P(3, 3, 4.4)
  const L = c.sz === 32 ? 13 : 10
  return s + arrow(c, x, y - L + 2, 0, L)
}
G.push = () => {
  const g = grid(), q = Q(8, 10.5)
  solid(g, boxFaces(q, [0, 0, 0], [5, 5, 3]))
  solid(g, boxFaces(q, [0, 0, 3], [5, 5, 5], ACC), 'd')
  glyph(g, 5, 1, ['  aa  ', ' aaaa ', 'aaaaaa', '  aa  ', '  aa  '])
  return g
}
function edgeRound(c, R, flat) {
  const X = 6, Y = 6, Z = 5.2
  const arc = (y) => (flat ? [[X, y, Z - R], [X - R, y, Z]] : quarter(X - R, Z - R, R, y))
  return (
    c.poly('t3', [X, 0, 0], [X, Y, 0], [X, Y, Z - R], [X, 0, Z - R]) +
    c.poly(flat ? 'a1' : 'a2', ...arc(0), ...arc(Y).reverse()) +
    c.poly('t1', [0, 0, Z], [X - R, 0, Z], [X - R, Y, Z], [0, Y, Z]) +
    c.poly('t2', [0, Y, 0], [X, Y, 0], ...arc(Y), [0, Y, Z])
  )
}
function edgeRound16(flat) {
  const g = grid(), q = Q(8, 9), X = 6, Y = 6, Z = 6, R = flat ? 2.2 : 1.8
  const arc = (y) => (flat ? [q(X, y, Z - R), q(X - R, y, Z)] : quarter(X - R, Z - R, R, y).map((p) => q(...p)))
  solid(g, [
    [[q(X, 0, 0), q(X, Y, 0), q(X, Y, Z - R), q(X, 0, Z - R)], '3'],
    [[...arc(0), ...arc(Y).reverse()], 'a'],
    [[q(0, 0, Z), q(X - R, 0, Z), q(X - R, Y, Z), q(0, Y, Z)], '1'],
    [[q(0, Y, 0), q(X, Y, 0), ...arc(Y), q(0, Y, Z)], '2'],
  ])
  return g
}
V.fillet = (c) => edgeRound(c, 1.8, false)
G.fillet = () => edgeRound16(false)
V.chamfer = (c) => edgeRound(c, 2, true)
G.chamfer = () => edgeRound16(true)
V.shell = (c) => {
  const X = 7, Y = 7, Z = 4, T = 0.9, F = 2.4
  const [a0, a1, b0, b1] = [T, X - T, T, Y - T]
  const open = c.pts([a0, b0, Z], [a1, b0, Z], [a1, b1, Z], [a0, b1, Z])
  return c.box([0, 0, 0], [X, Y, Z]) + `<clipPath id="ti-shell-${c.sz}"><path d="M${open}Z"/></clipPath><g clip-path="url(#ti-shell-${c.sz})">` +
    c.poly('t3', [a0, b0, Z], [a0, b1, Z], [a0, b1, F], [a0, b0, F]) + c.poly('t2', [a0, b0, Z], [a1, b0, Z], [a1, b0, F], [a0, b0, F]) +
    c.poly('a1', [a0, b0, F], [a1, b0, F], [a1, b1, F], [a0, b1, F]) + `</g><path class="nf out" d="M${open}Z"/>`
}
G.shell = () => {
  const g = grid(), q = Q(8, 8.5)
  solid(g, boxFaces(q, [0, 0, 0], [7, 7, 4], ['a', '2', '3']))
  fill(g, [q(1.6, 1.6, 4), q(5.4, 1.6, 4), q(5.4, 5.4, 4), q(1.6, 5.4, 4)], 'h')
  return g
}
V['hole-fit'] = (c) => {
  const Z = 2.6, rg = c.disc(3.5, 3.5, Z, 2.4), d = c.disc(3.5, 3.5, Z, 1.3)
  return c.box([0, 0, 0], [7, 7, Z]) + c.ell(rg, 'a1') + `<clipPath id="ti-hole-${c.sz}">${c.ell(d, '')}</clipPath>` + c.ell(d, 't3 nos') +
    `<g clip-path="url(#ti-hole-${c.sz})">${c.ell({ ...d, cy: r2(d.cy + d.ry * 0.9) }, 'hl')}</g>` + c.ell(d, 'nf out')
}
G['hole-fit'] = () => {
  const g = grid()
  solid(g, boxFaces(Q(8, 8.5), [0, 0, 0], [7, 7, 3]))
  stamp(g, 3, 7, ['   cccc   ', ' ccaaaacc ', 'ccaahhaacc', ' ccaaaacc ', '   cccc   '])
  return g
}
V['thread-bolt'] = (c) => {
  let s = cyl(c, 3, 3, 0, 6, 2)
  for (const z of [1.1, 2.4, 3.7, 5]) {
    const d = c.disc(3, 3, z, 2)
    s += `<path class="ln" d="M${r2(d.cx - d.rx)} ${r2(d.cy - 1.2 * c.k)}A${d.rx} ${d.ry} 0 0 0 ${r2(d.cx + d.rx)} ${r2(d.cy + 1.2 * c.k)}"/>`
  }
  return s
}
G['thread-bolt'] = () => {
  // a wide standoff, the thread as three accent turns across its front
  const g = grid()
  cyl16(g, 7.5, 2.5, 11.5, 5)
  for (const y0 of [4, 7, 10]) for (let x = 3; x <= 10; x++) put(g, [[x, y0 + Math.floor((x - 3) / 4)]], 'l')
  return g
}
V['subtract-shape'] = (c) => {
  const Y = 6, cx = 3, cz = 2.5, R = 1.5
  const circ = (y) => Array.from({ length: 20 }, (_, i) => { const a = (i / 20) * 2 * Math.PI; return [cx + R * Math.cos(a), y, cz + R * Math.sin(a)] })
  return cube(c, 5) + c.poly('hl', ...circ(Y)) + c.poly('a1', ...circ(Y + 2.4))
}
G['subtract-shape'] = () => {
  // the block with a round hole through its left face, the cut wall in the accent
  const g = grid(), q = Q(8, 8.5)
  solid(g, boxFaces(q, [0, 0, 0], [6, 6, 6]))
  stamp(g, 3, 7, ['  bbb ', ' bhhhb', 'bhhhhb', 'bhhhhb', 'bhhhb ', ' bbb  '])
  return g
}
V.cut = (c) => c.box([0, 0, 0], [6, 6, 2.4]) + c.poly('a1 faint2', [-1.4, -1.4, 2.4], [7.4, -1.4, 2.4], [7.4, 7.4, 2.4], [-1.4, 7.4, 2.4]) + c.box([0, 0, 3.6], [6, 6, 5.8])
G.cut = () => {
  // the shared cut mark: a thin accent plane through the middle of the body, a pixel wider on each side
  const g = grid()
  solid(g, boxFaces(Q(8, 8.5), [0, 0, 0], [6, 6, 6]))
  cutBand(g, 8)
  return g
}
V['array-linear'] = (c) => {
  let s = c.box([0, 0, 0], [11, 4, 0.8]) + cyl(c, 2, 2, 0.8, 4.4, 1.2)
  for (const x of [5.5, 9]) s += cyl(c, x, 2, 0.8, 4.4, 1.2, true)
  return s
}
G['array-linear'] = () => {
  // one block and its two copies along a row, the copies in the accent
  const g = grid(), q = Q(4, 8)
  solid(g, boxFaces(q, [0, 0, 0], [3, 3, 3]))
  solid(g, boxFaces(q, [4, 0, 0], [7, 3, 3], ACC), 'd')
  solid(g, boxFaces(q, [8, 0, 0], [11, 3, 3], ACC), 'd')
  return g
}
V.merge = (c) => c.box([0, 0, 0], [4, 4, 4.5]) + c.abox([2.6, 2.6, 0], [6.6, 6.6, 3.2])
G.merge = () => {
  const g = grid(), q = Q(8, 8)
  solid(g, boxFaces(q, [0, 2, 0], [4, 6.5, 5]))
  solid(g, boxFaces(q, [2.5, 0, 0], [6.5, 4, 4], ACC), 'd')
  return g
}
V.split = (c) => {
  // the block cut down its front corner; the right half moved off in the accent
  const d = 0.9
  return c.poly('t2', [0, 6, 0], [6, 6, 0], [6, 6, 4.5], [0, 6, 4.5]) + c.poly('t1', [0, 0, 4.5], [6, 6, 4.5], [0, 6, 4.5]) +
    c.poly('a3', [6 + d, -d, 0], [6 + d, 6 - d, 0], [6 + d, 6 - d, 4.5], [6 + d, -d, 4.5]) + c.poly('a1', [d, -d, 4.5], [6 + d, -d, 4.5], [6 + d, 6 - d, 4.5])
}
G.split = () => { const m = grid(); solid(m, boxFaces(Q(7, 8), [0, 0, 0], [6, 6, 6])); return halve(m, 7, 2) }

// ---------- Solid · Inspect and output ----------
V.measure = (c) => { const s = cube(c, 4.4); const [x, y] = c.P(0, -1.7, 4.4); return s + measure(c, x, y) }
G.measure = () => {
  const g = grid()
  solid(g, boxFaces(Q(7, 8.5), [0, 0, 0], [6, 6, 4]))
  put(g, [[7, 1], [7, 2], [7, 3], [7, 4], [12, 3], [12, 4], [12, 5], [12, 6], [8, 2], [9, 2], [10, 3], [11, 3]], 'l')
  return g
}
V['named-values'] = (c) => {
  const k = c.k, s = c.box([0, 0, 0], [5, 5, 4])
  const [bx, by] = c.P(5, 0, 4)
  const t = [[14, 4], [27, 4], [27, 13], [14, 13], [10, 8.5]].map(([x, y]) => [r2(x * k + bx - 4 * k), r2(y * k + by - 14 * k)])
  return s + c.spoly('a1', t) + `<path class="hl" d="M${r2(t[4][0] + 3.2 * k)} ${r2(t[4][1] - 1.2 * k)}h${r2(2.4 * k)}v${r2(2.4 * k)}h${r2(-2.4 * k)}z"/>` +
    `<path class="po nos" d="M${r2(t[0][0] + 3 * k)} ${r2(t[0][1] + 3 * k)}h${r2(7 * k)}v${r2(1.4 * k)}h${r2(-7 * k)}zM${r2(t[0][0] + 3 * k)} ${r2(t[0][1] + 5.6 * k)}h${r2(7 * k)}v${r2(1.4 * k)}h${r2(-7 * k)}z"/>`
}
G['named-values'] = () => {
  const g = grid()
  solid(g, boxFaces(Q(6, 9.5), [0, 0, 0], [5, 5, 4]))
  glyph(g, 7, 1, ['  aaaaa', ' aaaaaa', 'ahahhha', ' aaaaaa', '  aaaaa'])
  return g
}
V.export = (c) => { const s = cube(c, 4.5); const [x, y] = c.P(3, 3, 4.5); return s + exporter(c, x, y) }
G.export = () => {
  const g = grid()
  solid(g, boxFaces(Q(6, 9.5), [0, 0, 0], [5, 5, 4]))
  exporter16(g, 7, 7)
  return g
}
V['export-selection'] = (c) => {
  const s = c.box([0, 3.5, 0], [3, 6.5, 3]) + c.abox([3.5, 0, 0], [6.5, 3, 3])
  const [x, y] = c.P(5, 1.5, 3)
  return s + exporter(c, x, y)
}
G['export-selection'] = () => {
  const g = grid()
  solid(g, boxFaces(Q(6, 9.5), [0, 0, 0], [5, 5, 4], ACC), 'd')
  exporter16(g, 7, 7)
  return g
}
V['project-file'] = (c) => {
  const k = c.k, x0 = 7 * k, y0 = 4 * k, x1 = 23 * k, y1 = 28 * k, f = 6 * k
  c.mark(x0, y0); c.mark(x1, y1)
  const page = `<path class="t1" d="M${x0} ${y0}H${x1 - f}L${x1} ${y0 + f}V${y1}H${x0}Z"/><path class="t3" d="M${x1 - f} ${y0}V${y0 + f}H${x1}Z"/>`
  const sub = ctx(c.sz)
  return page + `<g transform="translate(${r2((x0 + x1) / 2)} ${r2(y0 + 15 * k)})">${sub.abox([0, 0, 0], [3, 3, 2.6])}</g>`
}
G['project-file'] = () => {
  const g = grid()
  stamp(g, 3, 1, ['ooooooo   ', 'o11111oo  ', 'o11111o3o ', 'o11111ooo ', 'o1111111o ', 'o1111111o ', 'o1111111o ', 'o1111111o ', 'o1111111o ', 'o1111111o ', 'o1111111o ', 'o1111111o ', 'o1111111o ', 'ooooooooo '])
  solid(g, boxFaces(Q(7.5, 9), [0, 0, 0], [3, 3, 3], ACC), 'd')
  return g
}

// ---------- Mesh ----------
V['repair-mesh'] = (c) => {
  const m = moundPts()
  const tri = [lerp(m.R, m.TR, 0.08), lerp(m.R, m.TR, 1), lerp(lerp(m.R, m.F, 0.55), lerp(m.TR, m.TF, 0.55), 0.5)]
  const d = c.k * 4.5
  return mound(c) + c.poly('hl', ...tri) + c.spoly('a1', tri.map((p) => { const [x, y] = c.P(...p); return [x + d, y - d] }))
}
G['repair-mesh'] = () => {
  const g = grid(), q = Q(7, 8.5)
  solid(g, moundFaces(q))
  const e0 = [MB, 0, 0], e1 = [MT1, MT0, MH]
  const hole = mask([lerp(e0, e1, 0.15), lerp(e0, e1, 0.95), [MB - 0.6, 3.2, 1.6]].map((p) => q(...p)))
  const patch = []
  for (let j = 0; j < 16; j++) for (let i = 0; i < 16; i++) if (hole[j][i] === '#') { g[j][i] = 'h'; patch.push([i + 2, j - 2]) }
  const on = new Set(patch.map(([i, j]) => i + ',' + j))
  for (const [i, j] of patch) for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (!on.has(i + a + ',' + (j + b)) && g[j + b]?.[i + a] !== undefined) g[j + b][i + a] = 'd'
  put(g, patch, 'a')
  return g
}
V['simplify-mesh'] = (c) => {
  const m = moundPts()
  const [TB, TR, R, F, L] = [m.TB, m.TR, m.R, m.F, m.L].map((p) => c.P(...p))
  const n = 4
  const out = Array.from({ length: n + 1 }, (_, i) => {
    const t = i / n, bump = Math.sin(t * Math.PI) * 3 * c.k
    return [TB[0] + (L[0] - TB[0]) * t - bump, TB[1] + (L[1] - TB[1]) * t - bump * 0.4].map(r2)
  })
  const base = Array.from({ length: n + 1 }, (_, i) => [TB[0] + (F[0] - TB[0]) * (i / n), TB[1] + (F[1] - TB[1]) * (i / n)].map(r2))
  let s = c.spoly('t2', [...out, F])
  for (let i = 1; i < n; i++) s += `<path class="mesh" d="M${out[i].join(' ')}L${base[i].join(' ')}"/>`
  for (let i = 0; i < n; i++) s += `<path class="mesh" d="M${out[i].join(' ')}L${base[i + 1].join(' ')}"/>`
  return s + c.spoly('a1', [TB, TR, F]) + c.spoly('a3', [TR, R, F])
}
G['simplify-mesh'] = () => {
  const g = grid(), q = Q(8, 8.5)
  const L = q(0, MB, 0), F = q(MB, MB, 0), R = q(MB, 0, 0), TR = q(MT1, MT0, MH), TB = q(MT0, MT0, MH), TL = q(MT0, MT1, MH)
  const ctl = [TL[0] - 1.6, TL[1] - 0.6]
  const arc = Array.from({ length: 9 }, (_, i) => { const t = i / 8; return [(1 - t) ** 2 * TB[0] + 2 * t * (1 - t) * ctl[0] + t * t * L[0], (1 - t) ** 2 * TB[1] + 2 * t * (1 - t) * ctl[1] + t * t * L[1]] })
  solid(g, [[[...arc, F], '2'], [[TB, TR, F], 'a'], [[TR, R, F], 'c']])
  return g
}
V.hollow = (c) => {
  const o = { t0: 1.1, t1: 5.4 }, w = 0.55, h = M.h
  return mound(c, o, 'a1') + c.poly('hl', [o.t0 + w, o.t0 + w, h], [o.t1 - w, o.t0 + w, h], [o.t1 - w, o.t1 - w, h], [o.t0 + w, o.t1 - w, h])
}
G.hollow = () => {
  const g = grid(), q = Q(8, 8.5), B = 7, T0 = 1, T1 = 6, H = 4
  solid(g, moundFaces(q, ['a', '2', '3'], { B, T0, T1, H }))
  fill(g, [q(T0 + 1, T0 + 1, H), q(T1 - 1, T0 + 1, H), q(T1 - 1, T1 - 1, H), q(T0 + 1, T1 - 1, H)], 'h')
  return g
}
V.orient = (c) => {
  const k = c.k, [x0, y0] = c.P(0.3, 4, 4.4), [x1, y1] = c.P(5, -0.5, 4.4)
  c.mark(x0, y0 - 6 * k); c.mark(x1, y1)
  return mound(c) + `<path class="sk" d="M${x0} ${y0}Q${r2((x0 + x1) / 2)} ${r2(Math.min(y0, y1) - 9 * k)} ${x1} ${r2(y1 - 1 * k)}"/>` +
    `<path class="a1" d="M${r2(x1 + 3 * k)} ${r2(y1 - 4 * k)}L${r2(x1 + 1.5 * k)} ${r2(y1 + 3.5 * k)}L${r2(x1 - 4 * k)} ${r2(y1 - 1.5 * k)}Z"/>`
}
G.orient = () => {
  const g = grid()
  solid(g, moundFaces(Q(8, 9.5), undefined, { H: 4 }))
  put(g, [[2, 5], [2, 4], [3, 3], [4, 2], [5, 2], [6, 1], [7, 1], [8, 1], [9, 1], [10, 2]], 'l')
  glyph(g, 10, 2, ['aaa', ' aa', '  a'])
  return g
}
V['mesh-cut'] = (c) => moundSlab(c, 0, 1.4) + c.poly('a1 faint2', [-1.2, -1.2, 1.4], [7.7, -1.2, 1.4], [7.7, 7.7, 1.4], [-1.2, 7.7, 1.4]) + moundSlab(c, 1.4, 3, 1.2)
G['mesh-cut'] = () => {
  // the shared cut mark through the mound
  const g = grid()
  solid(g, moundFaces(Q(8, 8.5)))
  cutBand(g, 9)
  return g
}
V['mesh-split'] = (c) => {
  const { b, t0, t1, h } = M, m = 3.25, dx = 1.5
  const f = (p) => [p[0] + dx, p[1], p[2]]
  return c.poly('t2', [0, b, 0], [m, b, 0], [m, t1, h], [t0, t1, h]) + c.poly('t3', [m, 0, 0], [m, b, 0], [m, t1, h], [m, t0, h]) + c.poly('t1', [t0, t0, h], [m, t0, h], [m, t1, h], [t0, t1, h]) +
    c.poly('a2', ...[[m, b, 0], [b, b, 0], [t1, t1, h], [m, t1, h]].map(f)) + c.poly('a3', ...[[b, 0, 0], [b, b, 0], [t1, t1, h], [t1, t0, h]].map(f)) + c.poly('a1', ...[[m, t0, h], [t1, t0, h], [t1, t1, h], [m, t1, h]].map(f))
}
G['mesh-split'] = () => { const m = grid(); solid(m, moundFaces(Q(7, 8.5), undefined, { B: 6, T0: 1, T1: 5, H: 4 })); return halve(m, 7, 2) }
V['mesh-measure'] = (c) => { const s = mound(c); const [x, y] = c.P(M.t0, M.t0 - 1.7, M.h); return s + measure(c, x, y) }
G['mesh-measure'] = () => { const g = grid(); solid(g, moundFaces(Q(7, 10.5), undefined, { H: 4 })); measure16(g, 6, 2); return g }
V['mesh-export'] = (c) => { const s = mound(c); const [x, y] = c.P(3.25, 3.25, M.h); return s + exporter(c, x, y) }
G['mesh-export'] = () => { const g = grid(); solid(g, moundFaces(Q(7, 10.5), undefined, { H: 4 })); exporter16(g, 7, 7); return g }

// ---------- Sketch ----------
const POINTER = 'M0 0v15.5l4.2-3.8 2.8 6.4 2.7-1.2-2.8-6.3 5.7-.4Z'
V['select-object'] = (c) => {
  const k = c.k
  c.mark(5 * k, 5 * k); c.mark(27 * k, 29 * k)
  return `<path class="sk dash2" d="M${5 * k} ${5 * k}h${16 * k}v${12 * k}h${-16 * k}z"/>` +
    `<path class="nd" transform="translate(${r2(14 * k)} ${r2(11 * k)}) scale(${r2(k * 1.05)})" d="${POINTER}"/>`
}
G['select-object'] = () => {
  const g = grid()
  for (let i = 1; i <= 10; i += 3) put(g, [[i, 2], [i + 1, 2], [i, 9], [i + 1, 9]], 'l')
  for (let j = 2; j <= 9; j += 3) put(g, [[1, j], [1, j + 1], [11, j], [11, j + 1]], 'l')
  stamp(g, 7, 4, ['o      ', 'oo     ', 'owo    ', 'owwo   ', 'owwwo  ', 'owwwwo ', 'owwwwwo', 'owwoooo', 'oo owo ', 'o  owo ', '    o  '])
  return g
}
V['sk-line'] = (c) => {
  const k = c.k, a = [7 * k, 25 * k], b = [25 * k, 7 * k]
  c.mark(...a, 2); c.mark(...b, 2)
  return `<path class="sk" d="M${a.join(' ')}L${b.join(' ')}"/>` + node(c, ...a) + node(c, ...b)
}
G['sk-line'] = () => {
  const g = grid()
  for (let i = 4; i <= 11; i++) put(g, [[i - 1, 15 - i], [i, 15 - i], [i + 1, 15 - i]], 'l')
  nodeAt(g, 2, 12); nodeAt(g, 12, 2)
  return g
}
V['sk-rect'] = (c) => {
  const k = c.k, x0 = 6 * k, y0 = 9 * k, x1 = 26 * k, y1 = 23 * k
  c.mark(x0, y0, 2); c.mark(x1, y1, 2)
  return `<path class="sk" d="M${x0} ${y0}H${x1}V${y1}H${x0}Z"/>` + node(c, x0, y0) + node(c, x1, y1)
}
G['sk-rect'] = () => {
  const g = grid()
  stamp(g, 2, 3, ['llllllllllll', 'llllllllllll', 'll        ll', 'll        ll', 'll        ll', 'll        ll', 'll        ll', 'll        ll', 'llllllllllll', 'llllllllllll'])
  nodeAt(g, 2, 3); nodeAt(g, 12, 11)
  return g
}
V['sk-circle'] = (c) => {
  const k = c.k, R = 10 * k
  c.mark(16 * k - R, 16 * k - R, 2); c.mark(16 * k + R, 16 * k + R, 2)
  return `<ellipse class="sk" cx="${16 * k}" cy="${16 * k}" rx="${R}" ry="${R}"/>` + node(c, 16 * k, 16 * k) + node(c, 16 * k + R, 16 * k)
}
const CIRCLE16 = ['    llllll    ', '  llllllllll  ', ' lll      lll ', ' ll        ll ', 'll          ll', 'll          ll', 'll          ll', 'll          ll', 'll          ll', 'll          ll', ' ll        ll ', ' lll      lll ', '  llllllllll  ', '    llllll    ']
G['sk-circle'] = () => { const g = grid(); stamp(g, 1, 1, CIRCLE16); nodeAt(g, 7, 7); nodeAt(g, 13, 7); return g }
V['sk-arc'] = (c) => {
  const k = c.k, R = 10 * k, cx = 16 * k, cy = 21 * k
  c.mark(cx - R, cy - R, 2); c.mark(cx + R, cy, 2)
  return `<path class="sk" d="M${cx - R} ${cy}A${R} ${R} 0 0 1 ${cx + R} ${cy}"/>` + node(c, cx - R, cy) + node(c, cx + R, cy) + node(c, cx, cy)
}
G['sk-arc'] = () => { const g = grid(); stamp(g, 1, 3, CIRCLE16.slice(0, 8)); nodeAt(g, 1, 10); nodeAt(g, 13, 10); nodeAt(g, 7, 10); return g }
V['sk-polygon'] = (c) => {
  const k = c.k, R = 11 * k, cx = 16 * k, cy = 16 * k
  const v = Array.from({ length: 6 }, (_, i) => [r2(cx + R * Math.cos(Math.PI / 6 + (i * Math.PI) / 3)), r2(cy + R * Math.sin(Math.PI / 6 + (i * Math.PI) / 3))])
  v.forEach((p) => c.mark(...p, 2))
  return `<path class="sk" d="M${v.map((p) => p.join(' ')).join('L')}Z"/>` + node(c, cx, cy) + node(c, ...v[4])
}
G['sk-polygon'] = () => {
  const g = grid()
  stamp(g, 1, 1, ['      ll      ', '    llllll    ', '  llll  llll  ', 'llll      llll', 'll          ll', 'll          ll', 'll          ll', 'll          ll', 'll          ll', 'll          ll', 'llll      llll', '  llll  llll  ', '    llllll    ', '      ll      '])
  nodeAt(g, 7, 7); nodeAt(g, 7, 1)
  return g
}
V['sk-slot'] = (c) => {
  const k = c.k, R = 6 * k, x0 = 10 * k, x1 = 22 * k, cy = 16 * k
  c.mark(x0 - R, cy - R, 2); c.mark(x1 + R, cy + R, 2)
  return `<path class="sk" d="M${x0} ${cy - R}H${x1}A${R} ${R} 0 0 1 ${x1} ${cy + R}H${x0}A${R} ${R} 0 0 1 ${x0} ${cy - R}Z"/>` + node(c, x0, cy) + node(c, x1, cy)
}
G['sk-slot'] = () => {
  const g = grid()
  stamp(g, 1, 3, ['   llllllll   ', ' llllllllllll ', 'lll        lll', 'll          ll', 'll          ll', 'll          ll', 'll          ll', 'lll        lll', ' llllllllllll ', '   llllllll   '])
  nodeAt(g, 4, 7); nodeAt(g, 11, 7)
  return g
}
V['sk-spline'] = (c) => {
  const k = c.k, a = [5 * k, 22 * k], b = [27 * k, 10 * k], m = [16 * k, 16 * k]
  c.mark(...a, 2); c.mark(...b, 2); c.mark(10 * k, 10 * k); c.mark(22 * k, 22 * k)
  return `<path class="sk" style="stroke-linecap:round" d="M${a.join(' ')}C${10 * k} ${6 * k} ${22 * k} ${26 * k} ${b.join(' ')}"/>` + node(c, ...a) + node(c, ...m) + node(c, ...b)
}
G['sk-spline'] = () => {
  const g = grid()
  for (let i = 0; i <= 40; i++) {
    const t = i / 40, x = 2 + t * 12, y = 8 - 4.2 * Math.sin(t * 2 * Math.PI)
    put(g, [[Math.round(x), Math.round(y)], [Math.round(x), Math.round(y) + 1]], 'l')
  }
  nodeAt(g, 2, 7); nodeAt(g, 8, 7); nodeAt(g, 13, 7)
  return g
}
V.trim = (c) => {
  const k = c.k, x = 19 * k, y = 16 * k
  c.mark(4 * k, 6 * k, 1); c.mark(29 * k, 26 * k, 1)
  return `<path class="lg" d="M${x} ${6 * k}V${26 * k}"/><path class="sk" d="M${4 * k} ${y}H${x}"/><path class="sk dash2 faint" d="M${x + 5 * k} ${y}H${29 * k}"/>` + node(c, x, y)
}
G.trim = () => {
  const g = grid()
  for (let j = 2; j <= 13; j++) put(g, [[9, j]], 's')
  for (let i = 1; i <= 8; i++) put(g, [[i, 7], [i, 8]], 'l')
  nodeAt(g, 9, 7)
  put(g, [[13, 7], [14, 7], [13, 8], [14, 8]], 'm')
  return g
}
V.dimension = (c) => {
  const k = c.k, x0 = 6 * k, x1 = 26 * k, yl = 23 * k, yd = 12 * k, h = 3 * k
  c.mark(x0, 8 * k, 2); c.mark(x1, yl, 2)
  return `<path class="lg" d="M${x0} ${yl}H${x1}"/>` + node(c, x0, yl) + node(c, x1, yl) +
    `<path class="ln" d="M${x0} ${8 * k}V${r2(yd + 5 * k)}M${x1} ${8 * k}V${r2(yd + 5 * k)}M${x0} ${yd}H${x1}"/>` +
    `<path class="a1 nos" d="M${x0} ${yd}l${r2(h * 1.6)} ${-h}v${2 * h}zM${x1} ${yd}l${r2(-h * 1.6)} ${-h}v${2 * h}z"/>`
}
G.dimension = () => {
  const g = grid()
  for (let j = 2; j <= 7; j++) put(g, [[2, j], [13, j]], 'l')
  for (let i = 3; i <= 12; i++) put(g, [[i, 4]], 'l')
  put(g, [[3, 3], [3, 5], [12, 3], [12, 5]], 'l')
  for (let i = 3; i <= 12; i++) put(g, [[i, 12]], 's')
  nodeAt(g, 2, 12); nodeAt(g, 13, 12)
  return g
}
V.mirror = (c) => {
  const k = c.k
  c.mark(3 * k, 5 * k); c.mark(29 * k, 27 * k)
  return `<path class="lg dash" d="M${16 * k} ${4 * k}V${28 * k}"/><path class="lg" style="stroke-width:1.5px" d="M${13 * k} ${8 * k}L${4 * k} ${24 * k}H${13 * k}Z"/><path class="sk" d="M${19 * k} ${8 * k}L${28 * k} ${24 * k}H${19 * k}Z"/>`
}
G.mirror = () => {
  const g = grid()
  for (let j = 1; j <= 14; j += 2) put(g, [[7, j]], 's')
  stamp(g, 1, 3, ['    s', '   ss', '   ss', '  s s', '  s s', ' s  s', ' s  s', 's   s', 'sssss'])
  stamp(g, 9, 3, ['ll    ', 'lll   ', 'llll  ', 'll ll ', 'll  ll', 'll  ll', 'll   l', 'llllll', 'llllll'])
  return g
}
V['look-at'] = (c) => {
  const k = c.k, p = (u, v) => c.P(u, v, 0)
  const tile = [p(0, 0), p(7, 0), p(7, 7), p(0, 7)]
  const [cx, cy] = p(3.5, 3.5)
  const s = 8 * k
  c.mark(cx - s, cy - s - 4 * k); c.mark(cx + s, cy + s - 4 * k)
  return `<path class="lg" d="M${tile.map((q) => q.join(' ')).join('L')}Z"/><path class="sk" d="M${r2(cx - s)} ${r2(cy - s - 4 * k)}h${2 * s}v${2 * s}h${-2 * s}z"/>` + node(c, cx, cy - 4 * k)
}
G['look-at'] = () => {
  const g = grid(), q = Q(8, 7)
  put(g, edge(mask([q(0, 0, 0), q(7, 0, 0), q(7, 7, 0), q(0, 7, 0)])), 's')
  stamp(g, 3, 2, ['llllllllll', 'llllllllll', 'll      ll', 'll      ll', 'll      ll', 'll      ll', 'll      ll', 'll      ll', 'llllllllll', 'llllllllll'])
  nodeAt(g, 8, 6)
  return g
}

// ---------- the set ----------
function draw(n, S) {
  if (S === 16) return pixels(G[n]())
  const c = ctx(S)
  return wrap(c, V[n](c))
}
/** each icon's drawing for a size: inner svg markup on a size by size grid (16 px is whole pixels) */
export const ICONS = Object.fromEntries(Object.keys(V).map((n) => [n, (S) => draw(n, S)]))
/** the 16 px grids, for checks and sheets */
export const GRIDS = G

/** each icon's name in the app, the tab and group the ribbon puts it in */
export const SET = [
  ['Solid · Create', ['sketch', 'extrude', 'revolve', 'box-shape', 'cube', 'cylinder', 'sphere', 'cone', 'on-face', 'shape-face', 'text-face', 'svg-face']],
  ['Solid · Modify', ['push', 'fillet', 'chamfer', 'shell', 'hole-fit', 'thread-bolt', 'subtract-shape', 'cut', 'array-linear', 'merge', 'split']],
  ['Solid · Inspect and output', ['measure', 'named-values', 'export', 'export-selection', 'project-file']],
  ['Mesh', ['repair-mesh', 'simplify-mesh', 'hollow', 'orient', 'mesh-cut', 'mesh-split', 'mesh-measure', 'mesh-export']],
  ['Sketch', ['select-object', 'sk-line', 'sk-rect', 'sk-circle', 'sk-arc', 'sk-polygon', 'sk-slot', 'sk-spline', 'trim', 'dimension', 'mirror', 'look-at', 'sketch-finish']],
]
