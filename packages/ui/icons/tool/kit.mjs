// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// drawing kit for the tool icons, in the tooltip loops' look: three grays, one accent on the tool's action, a dark
// contour, the 2:1 pixel iso camera. 32 and 24 are vector, drawn in iso units; 16 is a pixel grid placed by hand.
export const ZF = 1.25
const r = (v) => Math.round(v * 100) / 100

// ---------- vector ----------
/** a drawing context for one size: s px per iso unit, bounds tracked so the icon can be centered */
export function ctx(sz) {
  const s = sz === 32 ? 2 : 1.5
  const k = sz / 32
  const b = { x0: 1e9, y0: 1e9, x1: -1e9, y1: -1e9 }
  const mark = (x, y, pad = 0.5) => {
    b.x0 = Math.min(b.x0, x - pad); b.y0 = Math.min(b.y0, y - pad)
    b.x1 = Math.max(b.x1, x + pad); b.y1 = Math.max(b.y1, y + pad)
  }
  const P = (x, y, z) => {
    const p = [r((x - y) * s), r(((x + y) * s) / 2 - z * s * ZF)]
    mark(...p)
    return p
  }
  const pts = (...ps) => ps.map((p) => P(...p).join(' ')).join('L')
  const poly = (cls, ...ps) => `<path class="${cls}" d="M${pts(...ps)}Z"/>`
  /** a polygon from screen points already placed */
  const spoly = (cls, ps) => { ps.forEach((p) => mark(...p)); return `<path class="${cls}" d="M${ps.map((p) => p.map(r).join(' ')).join('L')}Z"/>` }
  const box = ([x0, y0, z0], [x1, y1, z1], c = {}) =>
    poly(c.r ?? 't3', [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]) +
    poly(c.l ?? 't2', [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]) +
    poly(c.t ?? 't1', [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1])
  const abox = (lo, hi) => box(lo, hi, { l: 'a2', r: 'a3', t: 'a1' })
  const disc = (x, y, z, rad) => {
    const [cx, cy] = P(x, y, z)
    const rx = r(rad * s * Math.SQRT2), ry = r((rad * s * Math.SQRT2) / 2)
    mark(cx - rx, cy - ry); mark(cx + rx, cy + ry)
    return { cx, cy, rx, ry }
  }
  const ell = (d, cls, extra = '') => `<ellipse class="${cls}" cx="${d.cx}" cy="${d.cy}" rx="${d.rx}" ry="${d.ry}"${extra}/>`
  const line = (cls, ps, extra = '') => `<path class="${cls}" d="M${pts(...ps)}"${extra}/>`
  return { sz, s, k, b, mark, P, pts, poly, spoly, box, abox, disc, ell, line }
}

/** an upright cylinder on (x, y) from z0 to z1, radius rad; accent or gray */
export function cyl(c, x, y, z0, z1, rad, accent = false, top) {
  const bt = c.disc(x, y, z0, rad), tp = c.disc(x, y, z1, rad)
  const side = `<path class="${accent ? 'cya out ao' : 'cyg out'}" style="fill:url(#ti-${accent ? 'cya' : 'cyg'})" d="M${r(tp.cx - tp.rx)} ${tp.cy}V${bt.cy}A${bt.rx} ${bt.ry} 0 0 0 ${r(bt.cx + bt.rx)} ${bt.cy}V${tp.cy}A${tp.rx} ${tp.ry} 0 0 1 ${r(tp.cx - tp.rx)} ${tp.cy}Z"/>`
  return side + c.ell(tp, top ?? (accent ? 'a1' : 't1'))
}

/** the loop's bold arrow in px: tip at (x, y), pointing along `deg` (0 is up), shaft length L */
export function arrow(c, x, y, deg = 0, L = 12) {
  const k = c.k
  const hw = r(4.5 * k + 0.5), hh = r(5 * k + 0.5), sw = r(1.6 * k + 0.4)
  const a = (deg * Math.PI) / 180
  for (const [px, py] of [[0, 0], [hw, hh], [-hw, hh], [sw, L], [-sw, L]]) c.mark(x + px * Math.cos(a) - py * Math.sin(a), y + px * Math.sin(a) + py * Math.cos(a))
  return `<path class="a1" transform="translate(${r(x)} ${r(y)})${deg ? ` rotate(${deg})` : ''}" d="M0 0L${hw} ${hh}H${sw}V${L}H${-sw}V${hh}H${-hw}Z"/>`
}

/** a sketch vertex: white square in a contour ring, centered on (x, y) */
export function node(c, x, y) {
  const h = c.sz === 32 ? 1.5 : 1
  c.mark(x, y, h + 1)
  return `<path class="nd" d="M${r(x - h)} ${r(y - h)}h${2 * h}v${2 * h}h${-2 * h}z"/>`
}

/** the shared measure mark: two ticks and the span between them, along the iso x edge, left tick at (x, y) */
export function measure(c, x, y) {
  const L = c.sz === 32 ? 14 : 10, t = c.sz === 32 ? 3.5 : 3
  const x1 = x + L, y1 = y + L / 2
  c.mark(x, y - t); c.mark(x1, y1 + t)
  return `<path class="ln" d="M${r(x)} ${r(y - t)}V${r(y + t)}M${r(x1)} ${r(y1 - t)}V${r(y1 + t)}M${r(x)} ${r(y)}L${r(x1)} ${r(y1)}"/>`
}

/** the shared export mark: the bold arrow leaving up and to the right from (x, y) */
export function exporter(c, x, y) {
  const L = c.sz === 32 ? 11 : 8
  const d = L * Math.SQRT1_2
  return arrow(c, x + d, y - d, 45, L)
}

/** centers an icon's markup on whole pixels; the cylinder gradients come along when the drawing uses them */
export function wrap(c, inner) {
  const { b, sz } = c
  const dx = Math.round(sz / 2 - (b.x0 + b.x1) / 2)
  const dy = Math.round(sz / 2 - (b.y0 + b.y1) / 2)
  const defs = /cya|cyg/.test(inner)
    ? '<defs><linearGradient id="ti-cya"><stop offset="0" style="stop-color:var(--ti-a2)"/><stop offset=".3" style="stop-color:var(--ti-a1)"/><stop offset=".7" style="stop-color:var(--ti-a2)"/><stop offset="1" style="stop-color:var(--ti-a3)"/></linearGradient><linearGradient id="ti-cyg"><stop offset="0" style="stop-color:var(--ti-t2)"/><stop offset=".3" style="stop-color:var(--ti-t1)"/><stop offset=".7" style="stop-color:var(--ti-t2)"/><stop offset="1" style="stop-color:var(--ti-t3)"/></linearGradient></defs>'
    : ''
  return `${defs}<g transform="translate(${dx} ${dy})">${inner}</g>`
}

// ---------- pixels ----------
/** a 16 x 16 grid of letters: . empty, o contour, 1 2 3 body tones, a b c accent tones, d accent contour, w white node,
 *  h cavity, s sketch gray, l sketch accent line, m the faint sketch line */
export const grid = () => Array.from({ length: 16 }, () => Array(16).fill('.'))
function inside(x, y, ps) {
  let c = false
  for (let i = 0, j = ps.length - 1; i < ps.length; j = i++) {
    const [xi, yi] = ps[i], [xj, yj] = ps[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c
  }
  return c
}
export function fill(g, ps, ch) {
  const ys = ps.map((p) => p[1])
  for (let j = Math.max(0, Math.floor(Math.min(...ys))); j < Math.min(16, Math.ceil(Math.max(...ys))); j++)
    for (let i = 0; i < 16; i++) if (inside(i + 0.5 + 1e-3, j + 0.5 + 2e-3, ps)) g[j][i] = ch
}
/** iso point at 16: one px per unit across, z in px */
export const Q = (ox, oy) => (x, y, z) => [ox + (x - y), oy + (x + y) / 2 - z]
/** paint a solid of faces, then its 1 px silhouette in `ol`; returns its mask */
export function solid(g, faces, ol = 'o') {
  const m = grid()
  for (const [ps, ch] of faces) { fill(g, ps, ch); fill(m, ps, '#') }
  for (let j = 0; j < 16; j++)
    for (let i = 0; i < 16; i++) {
      if (m[j][i] !== '#') continue
      if ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([a, b]) => m[j + b]?.[i + a] !== '#')) g[j][i] = ol
    }
  return m
}
export const boxFaces = (q, [x0, y0, z0], [x1, y1, z1], t = ['1', '2', '3']) => [
  [[q(x0, y1, z0), q(x1, y1, z0), q(x1, y1, z1), q(x0, y1, z1)], t[1]],
  [[q(x1, y0, z0), q(x1, y1, z0), q(x1, y1, z1), q(x1, y0, z1)], t[2]],
  [[q(x0, y0, z1), q(x1, y0, z1), q(x1, y1, z1), q(x0, y1, z1)], t[0]],
]
export const ACC = ['a', 'b', 'c']
/** stamp rows of letters at (x, y); spaces leave pixels alone */
export function stamp(g, x, y, rows) {
  rows.forEach((row, j) => [...row].forEach((ch, i) => { if (ch !== ' ' && g[y + j]?.[x + i] !== undefined) g[y + j][x + i] = ch }))
}
export const put = (g, list, ch) => { for (const [x, y] of list) if (g[y]?.[x] !== undefined) g[y][x] = ch }
/** stamp a glyph in one letter, then ring it outside with `ol` */
export function glyph(g, x, y, rows, ol = 'd') {
  stamp(g, x, y, rows)
  const on = (i, j) => rows[j - y]?.[i - x] !== undefined && rows[j - y][i - x] !== ' '
  for (let j = y - 1; j <= y + rows.length; j++)
    for (let i = x - 1; i <= x + Math.max(...rows.map((row) => row.length)); i++) {
      if (on(i, j) || g[j]?.[i] === undefined) continue
      if ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([a, b]) => on(i + a, j + b))) g[j][i] = ol
    }
}
export const nodeAt = (g, x, y) => stamp(g, x - 1, y - 1, ['oooo', 'owwo', 'owwo', 'oooo'])
export const mask = (ps) => { const m = grid(); fill(m, ps, '#'); return m }
export const text = (g) => g.map((row) => row.join('')).join('\n')
const CLS = { o: 'po', 1: 't1', 2: 't2', 3: 't3', a: 'a1', b: 'a2', c: 'a3', d: 'pa', w: 'nd', h: 'hl', s: 'sgf', l: 'skf', m: 'skcf' }
/** the grid as whole-pixel runs, one path per color class */
export function pixels(g) {
  const runs = {}
  for (let j = 0; j < 16; j++) {
    let i = 0
    while (i < 16) {
      const ch = g[j][i]
      let n = 1
      while (i + n < 16 && g[j][i + n] === ch) n++
      if (ch !== '.') (runs[ch] ??= []).push(`M${i} ${j}h${n}v1h-${n}z`)
      i += n
    }
  }
  return Object.entries(runs).map(([ch, d]) => `<path class="${CLS[ch]} nos px" d="${d.join('')}"/>`).join('')
}
