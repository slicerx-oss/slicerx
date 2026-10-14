// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Stills for the Slice settings whose lesson is structure or location: line widths, shells, the first layer, surface
// and infill patterns, skirt and brim, raft, support gaps and style, one wall, ironing and painted depth. Nothing
// moves; values sit in pills. Siblings share one drawing and each variant picks out its own part.
import { accentBox, box, iso, r1, S } from './stage.mjs'
import { A1, num, rel, st, T2, T3 } from './kit.mjs'

const C30 = Math.cos(Math.PI / 6)
const CY = '--cyan,#8be9fd'
const still = (id, about, body) => ({ id, about, css: '', body })

/** A section drawn on the front face (the plane y = Y), in mm with z up, from the face's corner at x = X0. */
const face = (Y, inner, X0 = 0) => {
  const [ox, oy] = iso(X0, Y, 0)
  return `<g transform="matrix(${r1(C30 * S * 100) / 100} ${r1(0.5 * S * 100) / 100} 0 ${-S} ${ox} ${oy})">${inner}</g>`
}
/** A pill holding a value, its left edge at x and its middle at y (px). */
const tag = (x, y, text) => {
  const w = Math.round(text.length * 6.1 + 18)
  return `<rect class="sxs-pill" x="${r1(x)}" y="${r1(y - 9)}" width="${w}" height="18" rx="9"/><text x="${r1(x + 9)}" y="${r1(y + 3.7)}">${text}</text>`
}
/** A thin leader in the accent from a point on the drawing (mm) to a pill's edge (px). */
const lead = (p, x, y) => `<path class="s-n"${st(A1, 1.2)} d="M${iso(...p).join(' ')}L${r1(x)} ${r1(y)}"/>`
/** Rows of printed lines seen end on in a section on the plane y = D (or the plane `P` maps (u, z) onto), each line a stadium: a round-capped stroke
 *  dashed once per line. A row is [x, z, n, pitch, width, height] in mm, its first line's left edge at x; `on` lights
 *  the rows in the accent, else they take the part's gray. Each row is its own subpath, so its dashes start on it. */
function beads(rows, D, on, P = (u, z) => iso(u, D, z)) {
  const [ol, fill] = on === 'paint' ? [T3, CY] : on ? ['--stage-aol', A1] : [T3, T2]
  const by = {}
  for (const r of rows) (by[r.slice(3).join()] ??= []).push(r)
  let out = ''
  for (const list of Object.values(by)) {
    const [, , , pitch, w, h] = list[0]
    // the stroke's width across the slanted row, and the dash that with its caps spans one line
    const sw = h * S * C30 - 1.4, dash = w * S - sw, cap = sw / 2 / S
    const d = list.map(([x, z, n]) => `M${P(x + cap, z + h / 2).join(' ')}L${P(x + (n - 1) * pitch + w - cap, z + h / 2).join(' ')}`).join('')
    const da = n1(list) ? '' : `;stroke-dasharray:${num(dash)} ${num(pitch * S - dash)}`
    // drawn to scale, so the lines keep their size wherever the stage is drawn
    out += `<path class="s-n" style="vector-effect:none;stroke:var(${ol});stroke-width:${num(sw + 1.4)}${da}" d="${d}"/><path class="s-n" style="vector-effect:none;stroke:var(${fill});stroke-width:${num(sw)}${da}" d="${d}"/>`
  }
  return out
}
const n1 = (list) => list.every((r) => r[2] === 1)

/** A part cut open along its front face: the box from x X0 to X0 + X, y -D to D, its section dark behind the lines. */
const cutPart = (X0, X, D, Z, inner = '') => `${box([X0, -D, 0], [X0 + X, D, Z], { l: 's-f3' })}${face(D, `<rect class="s-hole" x="0" y="0" width="${X}" height="${Z}"/>${inner}`, X0)}`

// ---------- line widths: a part cut open, every line end on, the tip's role lit, one of its lines bracketed ----------
// 7 mm of drawing per mm of print: 0.42 mm is 2.94, a 0.2 mm layer is 1.4
const LW = { outer: 0.42, inner: 0.45, sparse: 0.45, solid: 0.42, top: 0.42, first: 0.5 }
function lineWidths(id, role, about) {
  const k = 7, H = 1.6, X = 36, X0 = -8, D = 4, n = 8, gap = 0.2
  const w = (r) => LW[r] * k
  const rows = { outer: [], inner: [], sparse: [], solid: [], top: [], first: [] }
  // a row of c lines of width wr spread evenly over [a, b], closed up so no gap in the cut reads as a pattern
  const fill = (r, a, b, z) => { const c = Math.round((b - a + gap) / (w(r) + gap)); rows[r].push([X0 + a, z, c, (b - a - w(r)) / (c - 1), w(r), H]) }
  fill('first', 0, X, 0)
  const lo = w('outer') + 2 * (w('inner') + gap) + gap, hi = X - lo
  for (let L = 1; L < n; L++) {
    const z = L * H
    // the walls, both sides: the outer, then two inner; the infill between them
    rows.outer.push([X0, z, 2, X - w('outer'), w('outer'), H])
    rows.inner.push([X0 + w('outer') + gap, z, 2, w('inner') + gap, w('inner'), H], [X0 + hi, z, 2, w('inner') + gap, w('inner'), H])
    fill(L === n - 1 ? 'top' : L === n - 2 ? 'solid' : 'sparse', lo, hi, z)
  }
  const inner = Object.entries(rows).map(([r, list]) => beads(list, D, role === 'all' || r === role)).join('')
  // the one line the leader picks out: [row, line index from the right] in its role's rows
  const r = role === 'all' ? 'top' : role, [ri, li] = { outer: [n - 2, 0], inner: [2 * n - 3, 0], top: [0, 2], solid: [0, 2], sparse: [n - 4, 2], first: [0, 2] }[r]
  const [x, z, c, pitch, wl] = rows[r][ri], xa = x + (c - 1 - li) * pitch
  const Z = n * H, below = r === 'first', py = below ? 140 : 50
  return still(id, about, cutPart(X0, X, D, Z) + inner + xBracket(xa, xa + wl, D, below ? z : z + H, below) + lead([xa + wl / 2, D, below ? z - 0.6 : z + H + 0.6], 222, py) + tag(222, py, `${(role === 'all' ? 0.42 : LW[role]).toFixed(2)} mm`))
}
/** A bracket on the plane y = D along x from xa to xb at height z, its ticks reaching into the line below it (or
 *  above, `up`), over a dark halo so it reads on lit and plain lines alike. */
const xBracket = (xa, xb, D, z, up) => {
  const o = up ? -0.6 : 0.6, t = up ? 0.9 : -0.9
  const d = `M${iso(xa, D, z + t).join(' ')}L${iso(xa, D, z + o).join(' ')}L${iso(xb, D, z + o).join(' ')}L${iso(xb, D, z + t).join(' ')}`
  return `<path class="s-n"${st('--stage-ol', 3.4)} d="${d}"/><path class="s-n"${st(A1, 1.4)} d="${d}"/>`
}

// ---------- shells: a part cut open, its solid top and bottom layers counted, their thickness bracketed ----------
function shells(id, side, about) {
  const X = 36, X0 = -8, D = 4, H = 1.4, n = 10, top = 4, bot = 3, bw = 3, gap = 0.2
  const walls = [], solid = []
  const c = Math.floor((X - 2 * bw - gap) / (bw + gap)), pitch = (X - 2 * (bw + gap) - bw) / (c - 1)
  for (let L = 0; L < n; L++) {
    walls.push([X0, L * H, 2, X - bw, bw, H])
    if (L >= n - top || L < bot) solid.push([X0 + bw + gap, L * H, c, pitch, bw, H])
  }
  // sparse infill between, as crossing lines
  const z0 = bot * H, z1 = (n - top) * H
  let sp = ''
  for (let x = bw + 1; x < X - bw - 6; x += 6) sp += `M${x} ${z0}L${x + 6} ${z1}M${x + 6} ${z0}L${x} ${z1}`
  const Z = n * H, isTop = side === 'top'
  const mine = solid.filter((r) => (r[1] >= z1) === isTop), other = solid.filter((r) => (r[1] >= z1) !== isTop)
  const inner = beads(walls, D, false) + beads(other, D, false) + beads(mine, D, true)
  // the bracket just past the front corner, level with the lit layers
  const [za, zb] = isTop ? [z1, Z] : [0, z0], bx = X0 + X + 2.6
  const count = isTop ? top : bot, py = isTop ? 52 : 92
  const pills = lead([bx, D, (za + zb) / 2], 222, py + 11) + tag(222, py, `${count} layers`) + tag(222, py + 22, `${r1(count * 0.2).toFixed(1)} mm`)
  return still(id, about, cutPart(X0, X, D, Z, `<path style="fill:none;stroke:var(${T3});stroke-width:1" d="${sp}"/>`) + inner + zBracket(bx, D, za, zb) + pills)
}

// ---------- first layer height: a section of a few layers, the first one thicker, both heights given ----------
function firstLayer(id, about) {
  const X = 36, X0 = -8, D = 4, h0 = 3, h = 2, n = 6
  const rest = []
  for (let L = 1; L < n; L++) rest.push([X0, h0 + (L - 1) * h, 12, (X - 2.8) / 11, 2.8, h])
  const Z = h0 + (n - 1) * h
  // each leader ends on a bracket spanning exactly one layer: the first, and the fourth above it
  const bx = X0 + X + 1.6, z1 = h0 + 3 * h
  return still(id, about, cutPart(X0, X, D, Z) + beads([[X0, 0, 11, (X - 3.2) / 10, 3.2, h0]], D, true) + beads(rest, D, false) + zBracket(bx, D, 0, h0) + zBracket(bx, D, z1, z1 + h) + lead([bx, D, h0 / 2], 226, 140) + tag(226, 140, '0.3 mm') + lead([bx, D, z1 + h / 2], 226, 70) + tag(226, 70, '0.2 mm'))
}

/** A bracket on the plane y = D from (x, za) to (x, zb), its ticks pointing back toward -x. */
const zBracket = (x, D, za, zb) => `<path class="s-n"${st(A1, 1.4)} d="M${iso(x - 0.7, D, za).join(' ')}L${iso(x, D, za).join(' ')}L${iso(x, D, zb).join(' ')}L${iso(x - 0.7, D, zb).join(' ')}"/>`
/** A dimension in the accent between two points (mm), with end ticks along `t` (a mm offset). */
const dim = (a, b, t = [0, 0, 1.2]) => {
  const tk = (p) => `M${iso(p[0] - t[0] / 2, p[1] - t[1] / 2, p[2] - t[2] / 2).join(' ')}L${iso(p[0] + t[0] / 2, p[1] + t[1] / 2, p[2] + t[2] / 2).join(' ')}`
  return `<path class="s-n"${st(A1, 1.4)} d="M${iso(...a).join(' ')}L${iso(...b).join(' ')}${tk(a)}${tk(b)}"/>`
}
/** Accent strokes over a top view, as one path; thin lines keep their width in px like the rest of the stage. */
const strokes = (d, c = A1, w = 1.2) => `<path class="s-n"${st(c, w)} d="${d}"/>`
/** Printed lines lying on the plate or a top: an outline under the line, so they read on light and dark grounds. */
const printed = (d, on, w = 1.8) => `<path class="s-n"${st(on ? '--stage-aol' : '--stage-ol', w + 1.6)} d="${d}"/><path class="s-n"${st(on ? A1 : T2, w)} d="${d}"/>`
/** Mm polylines on the plane z, as path data. */
const lines = (ls, z) => ls.map((l) => rel(l.map(([x, y]) => [x, y, z]), false)).join('')
/** Parallel lines at `deg` through the rectangle [0, T] x [0, V] less a margin m, spaced sp, as [x, y] polylines. */
function hatch(T, deg, sp, m = 0.5, V = T) {
  const a = (deg * Math.PI) / 180, dx = Math.cos(a), dy = Math.sin(a), out = []
  const cs = [[m, m], [T - m, m], [T - m, V - m], [m, V - m]].map(([x, y]) => -x * dy + y * dx)
  for (let o = Math.min(...cs) + sp / 2; o < Math.max(...cs); o += sp) {
    let t0 = -1e9, t1 = 1e9
    for (const [p, v, lo, hi] of [[-o * dy, dx, m, T - m], [o * dx, dy, m, V - m]]) {
      if (Math.abs(v) < 1e-9) { if (p < lo || p > hi) t0 = 1, t1 = 0; continue }
      const u0 = (lo - p) / v, u1 = (hi - p) / v
      t0 = Math.max(t0, Math.min(u0, u1)), t1 = Math.min(t1, Math.max(u0, u1))
    }
    if (t1 > t0 + 0.2) out.push([[-o * dy + t0 * dx, o * dx + t0 * dy], [-o * dy + t1 * dx, o * dx + t1 * dy]])
  }
  return out
}
const at = (ls, ox, oy) => ls.map((l) => l.map(([x, y]) => [x + ox, y + oy]))
const square = (T, i) => [[i, i], [T - i, i], [T - i, T - i], [i, T - i], [i, i]]
/** Tiles in one screen row, left to right: tile i's corner (mm) for tiles of side T, `step` px apart, row at x + y = s. */
const rowAt = (n, T, step, s = 4) => Array.from({ length: n }, (_, i) => {
  const d = (i - (n - 1) / 2) * step / (C30 * S) + 7.9
  return [(s + d) / 2 - T / 2, (s - d) / 2 - T / 2]
})

// ---------- top and bottom surface patterns: four tiles, left to right, each pattern on one square ----------
function hilbert(T, order = 3) {
  const n = 2 ** order, ps = []
  for (let i = 0; i < n * n; i++) {
    let x = 0, y = 0, t = i
    for (let s = 1; s < n; s *= 2) {
      const rx = 1 & (t / 2), ry = 1 & (t ^ rx)
      if (!ry) { if (rx) x = s - 1 - x, y = s - 1 - y; [x, y] = [y, x] }
      x += s * rx, y += s * ry, t = Math.floor(t / 4)
    }
    ps.push([((x + 0.5) * T) / n, ((y + 0.5) * T) / n])
  }
  return [ps]
}
const spiral = (T, turns = 4.3, n = 64) => [Array.from({ length: n + 1 }, (_, k) => {
  const a = (k / n) * turns * 2 * Math.PI, r = ((k / n) * (T / 2 - 0.6))
  return [T / 2 + r * Math.cos(a), T / 2 + r * Math.sin(a)]
})]
function surfacePatterns(id, side, about) {
  const T = 9.5, h = side === 'top' ? 4 : 0.6, pos = rowAt(4, T, 54)
  const pats = [hatch(T, 45, 1.15), [1, 2, 3, 4].map((i) => square(T, i * 0.95 - 0.4)), hilbert(T), spiral(T)]
  let body = ''
  pats.forEach((ls, i) => {
    const [x, y] = pos[i]
    body += box([x, y, 0], [x + T, y + T, h], { t: 's-hole' }) + strokes(lines(at(ls, x, y), h), A1, 1.1)
  })
  return still(id, about, body)
}

// ---------- sparse infill pattern: four tiles at one density, left to right ----------
function sparsePatterns(id, about) {
  const T = 9.5, h = 2.4, pos = rowAt(4, T, 54), m = 0.9
  const grid = [...hatch(T, 45, 2.6, m), ...hatch(T, -45, 2.6, m)]
  const gyroid = Array.from({ length: 4 }, (_, k) => Array.from({ length: 17 }, (_, i) => [m + (i / 16) * (T - 2 * m), 1.6 + k * 2.1 + 0.7 * Math.sin((i / 16) * 3 * Math.PI + k * Math.PI)]))
  // honeycomb: rows of flats and slants, mirrored in pairs so the flats meet and close hexagons
  const L = 1.25, hy = 1.08
  const hc = (y, up) => { const ps = []; let x = m; for (let i = 0; x < T - m; i++) { const hi = (i % 2 === 0) === up; ps.push([x, y + (hi ? hy : 0)]); x = Math.min(T - m, x + L); ps.push([x, y + (hi ? hy : 0)]); x = Math.min(T - m, x + L / 2) } return ps }
  const honey = [hc(m + 0.3, true), hc(m + 0.3 + hy, false), hc(m + 0.3 + 2 * hy + 1.1, true), hc(m + 0.3 + 3 * hy + 1.1, false)]
  // lightning: a few branches that reach only up to where the top needs holding
  const light = [[[1.2, 8.3], [3.4, 6], [4.6, 3.4], [7.8, 1.4]], [[3.4, 6], [6.6, 6.8], [8.4, 8.4]], [[4.6, 3.4], [2, 1.6]]]
  let body = ''
  ;[grid, gyroid, honey, light].forEach((ls, i) => {
    const [x, y] = pos[i]
    body += box([x, y, 0], [x + T, y + T, h], { t: 's-hole' }) + strokes(lines(at([square(T, 0.5)], x, y), h), T2, 1.1) + strokes(lines(at(ls, x, y), h), A1, 1.2)
  })
  return still(id, about, body)
}

// ---------- skirt and brim: a part on the plate with its brim, the gap, and the skirt loops around ----------
function skirtBrim(id, pick, about) {
  const x0 = -4, y0 = -8, x1 = 14, y1 = 5, gap = 1.4, bl = 3, bp = 1.1, sd = 4, sl = 2, z = 0.05
  const ring = (e) => rel([[x0 - e, y0 - e, z], [x1 + e, y0 - e, z], [x1 + e, y1 + e, z], [x0 - e, y1 + e, z]])
  let brim = '', skirt = ''
  for (let k = 0; k < bl; k++) brim += ring(gap + 0.5 + k * bp)
  const be = gap + (bl - 1) * bp + 1
  for (let k = 0; k < sl; k++) skirt += ring(be + sd + 0.5 + k * 1.1)
  const loops = pick === 'loops' || pick === 'length'
  let body = printed(brim, false) + printed(skirt, loops) + box([x0, y0, 0], [x1, y1, 6])
  // the gap the tip sets, as a band along the part's right side, and its dimension across it
  const band = (a, b) => `<polygon class="s-af" points="${[[x1 + a, y0 - a, z], [x1 + b, y0 - b, z], [x1 + b, y1 + b, z], [x1 + a, y1 + a, z]].map((q) => iso(...q).join(',')).join(' ')}"/>`
  const ym = 1
  if (pick === 'distance') body = band(be, be + sd) + body + dim([x1 + be, ym, z], [x1 + be + sd, ym, z], [0, 2, 0])
  if (pick === 'gap') body = band(0, gap) + body + dim([x1, ym, z], [x1 + gap, ym, z], [0, 2, 0])
  const [px, py] = iso(x1 + be + sd + 3, ym + 1, z)
  const text = { distance: '2 mm', gap: '0.1 mm', loops: '2 loops', length: '100 mm' }[pick]
  return still(id, about, body + tag(px + 4, py, text))
}

// ---------- raft: the part sits on a few raft layers, a small gap between them ----------
function raft(id, about) {
  const n = 3, h = 1.2, e = 2.4
  let body = ''
  for (let k = 0; k < n; k++) body += accentBox([-e, -4 - e, k * h], [22 + e, 6 + e, (k + 1) * h])
  // the top raft layer's lines, and the part above the contact gap
  const zt = n * h
  body += strokes(lines(at(hatch(22 + 2 * e, 90, 1.3, 0.5, 10 + 2 * e), -e, -4 - e), zt), '--stage-aol', 1)
  body += box([0, -4, zt + 0.6], [22, 6, zt + 9])
  const bx = 22 + e + 1.6
  return still(id, about, body + zBracket(bx, 6 + e, 0, zt) + tag(iso(bx, 6 + e, zt / 2)[0] + 8, iso(bx, 6 + e, zt / 2)[1], `${n} layers`))
}

// ---------- support gaps: a section through support under a ledge, standing on the part's lower step ----------
function supportGaps(id, pick, about) {
  const X0 = -10, X = 38, D = 4, wall = 5, fl = 2.4, Z = 16, ledge = 2.4, gz = 1.8, gxy = 2.6, h = 1
  // the part: a lower step, a wall on the left and a ledge over the support
  const part = box([X0, -D, 0], [X0 + X, D, fl]) + box([X0, -D, 0], [X0 + wall, D, Z]) + box([X0, -D, Z - ledge], [X0 + X, D, Z])
  const sec = `<path style="fill:var(--stage-t1);stroke:var(--stage-ol);stroke-width:1.4" d="M0 0H${X}V${fl}H${wall}V${Z - ledge}H${X}V${Z}H0Z"/>`
  const sx = X0 + wall + gxy, sw = X - wall - gxy - 2, zb = fl + gz, zt = Z - ledge - gz
  // the support body: sparse lines, then the interface layers right under the part, dense
  const base = [], face3 = []
  for (let z = zb; z < zt - 3 * h - 0.01; z += h) base.push([sx, z, 7, (sw - 1.6) / 6, 1.6, h])
  const ip = pick === 'spacing' ? 2.6 : 2
  for (let k = 0; k < 3; k++) face3.push([sx, zt - (k + 1) * h, Math.floor((sw - 1.6) / ip) + 1, ip, 1.6, h])
  const iface = pick === 'layers' || pick === 'spacing'
  let body = part + `<g>${face(D, sec, X0)}</g>` + `<polygon class="s-hole" points="${[[sx, D, zb], [sx + sw, D, zb], [sx + sw, D, zt], [sx, D, zt]].map((q) => iso(...q).join(',')).join(' ')}"/>` + beads(base, D, false) + beads(face3, D, iface)
  // the gap the tip sets, lit as a band, with its pill
  const band = (a, b) => `<polygon class="s-af s-al" style="stroke-width:1.2" points="${[a, [b[0], D, a[2]], b, [a[0], D, b[2]]].map((q) => iso(...q).join(',')).join(' ')}"/>`
  const ux = X0 + X - 6
  let p
  if (pick === 'top') body += band([sx, D, zt], [sx + sw, D, zt + gz]), p = [ux, D, zt + gz / 2]
  if (pick === 'bottom') body += band([sx, D, fl], [sx + sw, D, zb]), p = [ux, D, fl + gz / 2]
  if (pick === 'xy') body += band([X0 + wall, D, zb], [sx, D, zt]), p = [sx - gxy / 2, D, zb + 1.5]
  if (iface) p = [ux, D, zt - 1.5 * h]
  const text = { top: '0.2 mm', bottom: '0.2 mm', xy: '0.35 mm', layers: '3 layers', spacing: '0.5 mm' }[pick]
  const py = pick === 'bottom' ? 140 : pick === 'xy' ? 120 : 44, px = pick === 'xy' ? 24 : 224
  return still(id, about, body + lead(p, pick === 'xy' ? px + 60 : px, py) + tag(px, py, text))
}

// ---------- support style: one overhang held up by each style, left to right ----------
function supportStyles(id, about) {
  const pos = rowAt(4, 0, 62, 6), R = 4.2, zc = 7, hc = 1.8
  let body = ''
  pos.forEach(([x, y], i) => {
    const stem = box([x - 1.2, y - 1.2, 0], [x + 1.2, y + 1.2, zc])
    const cap = box([x - R, y - R, zc], [x + R, y + R, zc + hc])
    const legs = (pts, curve, w) => strokes(pts.map(([px, py]) => curve ? `M${iso(x + 1.8, y + 1.8, 0).join(' ')}C${iso(x + 1.8, y + 1.8, 3.5).join(' ')} ${iso(px, py, zc - 3).join(' ')} ${iso(px, py, zc).join(' ')}` : `M${iso(x + 1.8, y + 1.8, 0).join(' ')}L${iso(x + 1.8, y + 1.8, 2).join(' ')}L${iso(px, py, zc).join(' ')}`).join(''), A1, w)
    let sup = ''
    if (i === 0) {
      // grid: a block of support under the whole cap, its lines on a grid
      const G = R + 0.8
      let d = ''
      for (let k = -G + 1.3; k < G; k += 1.6) d += rel([[x + k, y + G, 0], [x + k, y + G, zc]], false) + rel([[x + G, y + k, 0], [x + G, y + k, zc]], false)
      sup = box([x - G, y - G, 0], [x + G, y + G, zc], { l: 's-af', r: 's-af', t: 's-af', ol: 's-al' }) + strokes(d, A1, 1)
    } else if (i === 1) {
      // snug: support that hugs the cap's outline and steps in around the stem
      sup = box([x - R, y - R, 0], [x + R, y + R, zc], { l: 's-af', r: 's-af', t: 's-af', ol: 's-al' })
    } else if (i === 2) sup = legs([[x + R - 1, y + R - 1], [x - R + 1, y + R - 1], [x + R - 1, y - R + 1]], true, 2.4)
    else sup = legs([[x + R - 1, y + R - 1], [x - R + 1, y + R - 1], [x + R - 1, y - R + 1], [x, y + R - 0.6]], false, 1.2)
    body += stem + sup + cap
  })
  return still(id, about, body)
}

// ---------- one wall on top: the same top with all its walls, and with one, the top lines reaching further ----------
function oneWall(id, where, about) {
  const T = 15, h = where === 'top' ? 6 : 0.6, pos = rowAt(2, T, 96, 6)
  let body = ''
  ;[3, 1].forEach((n, i) => {
    const [x, y] = pos[i]
    let walls = ''
    for (let k = 0; k < n; k++) walls += rel(square(T, 0.7 + k * 1.1).slice(0, 4).map(([a, b]) => [x + a, y + b, h]))
    const m = 0.7 + n * 1.1 - 0.2
    body += box([x, y, 0], [x + T, y + T, h], { t: 's-hole' }) + strokes(walls, T2, 1.6) + strokes(lines(at(hatch(T, 45, 1.1, m), x, y), h), A1, 1.2)
    const [px, py] = iso(x + T, y + T, 0)
    body += tag(px - 30, py + 16, n === 1 ? '1 wall' : `${n} walls`)
  })
  return still(id, about, body)
}

// ---------- ironing angle: a top surface, its top lines, and the ironing pass at its own fixed angle ----------
function ironing(id, about) {
  const T = 22, h = 6, [x, y] = rowAt(1, T, 0, 6)[0]
  // the top lines run at 45 degrees; the front half is ironed at the fixed 0 degrees
  const body = box([x, y, 0], [x + T, y + T, h], { t: 's-hole' }) + strokes(lines(at(hatch(T, 45, 1.6, 0.6), x, y), h), T2, 1.1) + strokes(lines(at(hatch(T, 0, 0.8, 0.6).filter(([[, b]]) => b > T / 2), x, y), h), A1, 1)
  const [px, py] = iso(x + T, y + T, 0)
  return still(id, about, body + tag(px + 18, py - 24, '0°'))
}

// ---------- painted color depth: a section of a painted part, the paint reaching a few layers in ----------
function paintDepth(id, side, about) {
  const X = 36, X0 = -8, D = 4, H = 1.4, n = 10, k = 3, bw = 3
  const rows = { paint: [], plain: [] }
  const isTop = side === 'top'
  for (let L = 0; L < n; L++) {
    const p = isTop ? L >= n - k : L < k
    rows[p ? 'paint' : 'plain'].push([X0, L * H, 12, (X - bw) / 11, bw, H])
  }
  const Z = n * H, [za, zb] = isTop ? [(n - k) * H, Z] : [0, k * H], bx = X0 + X + 2.6
  const top = isTop ? `<polygon style="fill:var(${CY});stroke:var(--stage-ol);stroke-width:1.4" points="${[[X0, -D, Z], [X0 + X, -D, Z], [X0 + X, D, Z], [X0, D, Z]].map((q) => iso(...q).join(',')).join(' ')}"/>` : ''
  const [mx, my] = iso(bx, D, (za + zb) / 2)
  return still(id, about, cutPart(X0, X, D, Z) + top + beads(rows.plain, D, false) + beads(rows.paint, D, 'paint') + zBracket(bx, D, za, zb) + tag(mx + 8, my, `${k} layers`))
}

/** The first batch of Slice stills, by the file name the export uses: [name, tip sentence, drawing]. */
export const STILLS = {
  'still-line-width': ['Default line width', 'Every line in a cut part, seen end on. A line with no width of its own prints at the default, here 0.42 mm.', (about) => lineWidths('ulw', 'all', about)],
  'still-line-width-outer': ['Outer wall line width', 'The outer wall lines, picked out in a cut part, print 0.42 mm wide. Narrower gives finer detail.', (about) => lineWidths('ulwo', 'outer', about)],
  'still-line-width-inner': ['Inner wall line width', 'The inner wall lines, picked out in a cut part, print 0.45 mm wide.', (about) => lineWidths('ulwi', 'inner', about)],
  'still-line-width-sparse': ['Sparse infill line width', 'The sparse infill lines, picked out in a cut part, print 0.45 mm wide. Wider lines fill faster and make stronger infill.', (about) => lineWidths('ulws', 'sparse', about)],
  'still-line-width-solid': ['Internal solid infill line width', 'The solid infill under the top, picked out in a cut part, prints 0.42 mm wide.', (about) => lineWidths('ulwd', 'solid', about)],
  'still-line-width-top': ['Top surface line width', 'The top surface lines, picked out in a cut part, print 0.42 mm wide. Narrower lines give a finer top.', (about) => lineWidths('ulwt', 'top', about)],
  'still-line-width-first': ['First layer line width', 'The first layer lines, picked out in a cut part, print 0.50 mm wide. Wider first lines grip the bed better.', (about) => lineWidths('ulwf', 'first', about)],
  'still-shells-top': ['Top shell', 'The solid layers on top of the part: 4 layers of 0.2 mm make a top 0.8 mm thick over the infill.', (about) => shells('usht', 'top', about)],
  'still-shells-bottom': ['Bottom shell', 'The solid layers at the bottom of the part: 3 layers of 0.2 mm make a bottom 0.6 mm thick.', (about) => shells('ushb', 'bottom', about)],
  'still-first-layer-height': ['First layer height', 'The first layer can print thicker than the rest, here 0.3 mm under 0.2 mm layers, which forgives a bed that is not quite level.', (about) => firstLayer('uflh', about)],
  'still-surface-pattern-top': ['Top surface pattern', 'Top surface patterns, left to right: monotonic, concentric, Hilbert curve and Archimedean chords.', (about) => surfacePatterns('uspt', 'top', about)],
  'still-surface-pattern-bottom': ['Bottom surface pattern', 'Bottom surface patterns on the first layer, left to right: monotonic, concentric, Hilbert curve and Archimedean chords.', (about) => surfacePatterns('uspb', 'bottom', about)],
  'still-sparse-pattern': ['Sparse infill pattern', 'Sparse infill patterns at one density, left to right: grid, gyroid, honeycomb and lightning.', (about) => sparsePatterns('uisp', about)],
  'still-skirt-distance': ['Skirt distance', 'The skirt sits this far out from the part or its brim, here 2 mm.', (about) => skirtBrim('usdi', 'distance', about)],
  'still-skirt-loops': ['Skirt loops', 'The loops drawn around the parts before the print starts, here 2. They prime the nozzle and show the first layer is level.', (about) => skirtBrim('uslo', 'loops', about)],
  'still-skirt-length': ['Min skirt length', 'Skirt loops are added until at least this much filament has gone through the nozzle, here 100 mm.', (about) => skirtBrim('usle', 'length', about)],
  'still-brim-gap': ['Brim gap', 'A small gap between the part and its brim, here 0.1 mm, so the brim snaps off cleanly.', (about) => skirtBrim('ubga', 'gap', about)],
  'still-raft-layers': ['Raft layers', 'The part prints on 3 raft layers, which come away after the print.', (about) => raft('ural', about)],
  'still-support-top-gap': ['Top Z distance', 'The gap between the top of the support and the part above it, here 0.2 mm.', (about) => supportGaps('usgt', 'top', about)],
  'still-support-bottom-gap': ['Bottom Z distance', 'The gap where support stands on the part below it, here 0.2 mm.', (about) => supportGaps('usgb', 'bottom', about)],
  'still-support-xy-gap': ['XY distance', 'The sideways gap between support and the wall of the part, here 0.35 mm.', (about) => supportGaps('usgx', 'xy', about)],
  'still-support-interface-layers': ['Interface layers', 'The dense layers at the top of the support, right under the part, here 3.', (about) => supportGaps('usil', 'layers', about)],
  'still-support-interface-spacing': ['Interface spacing', 'The gap between the interface lines under the part, here 0.5 mm. Smaller gives a smoother underside.', (about) => supportGaps('usis', 'spacing', about)],
  'still-support-style': ['Support style', 'The same overhang held up by grid, snug, organic and tree slim support, left to right.', (about) => supportStyles('usst', about)],
  'still-one-wall-top': ['One wall on top', 'The same top with 3 walls and with 1. With one wall the top lines reach almost to the edge.', (about) => oneWall('uowt', 'top', about)],
  'still-one-wall-first': ['One wall on the first layer', 'The first layer with 3 walls and with 1. With one wall the bottom lines reach almost to the edge.', (about) => oneWall('uowf', 'first', about)],
  'still-ironing-angle': ['Ironing angle', 'With a fixed angle, ironing runs at that angle, here 0°, instead of along the top lines.', (about) => ironing('uira', about)],
  'still-paint-depth-top': ['Painted top depth', 'A painted top colors this many layers down from the top surface, here 3.', (about) => paintDepth('upct', 'top', about)],
  'still-paint-depth-bottom': ['Painted bottom depth', 'A painted bottom colors this many layers up from the bottom surface, here 3.', (about) => paintDepth('upcb', 'bottom', about)],
}
export const LOOPS = Object.fromEntries(Object.entries(STILLS).map(([f, [name, tip, make]]) => [f, () => make(`${name}: ${tip[0].toLowerCase()}${tip.slice(1)}`)]))

// shared with the later batches of stills
export { C30, CY, still, face, tag, lead, beads, cutPart, xBracket, zBracket, dim, strokes, printed, lines, hatch, at, square, rowAt }
