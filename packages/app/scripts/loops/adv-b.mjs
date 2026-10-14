// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Advanced settings, second half: pressure advance to Z offset, and the stills for structure and limits. Each drawing
// is a function returning its loop; the batches share the helpers below. Loop ids start with "b".
import { accentBox, box, cyl, disc, ellipse, hud, iso, kf, pts, r1, rowFrames, run, tr } from './stage.mjs'

const op = (v) => `opacity:${v}`
const num = (v) => String(r1(v)).replace(/^(-?)0\./, '$1.')
const join = (ns) => ns.map(num).reduce((s, n, i) => s + (i && !n.startsWith('-') ? ' ' : '') + n, '')
/** A relative path through mm points: one absolute move, then deltas. */
function rel(ps, close = true) {
  const q = ps.map((p) => iso(...p))
  const d = []
  for (let i = 1; i < q.length; i++) d.push(r1(q[i][0] - q[i - 1][0]), r1(q[i][1] - q[i - 1][1]))
  return `M${join(q[0])}l${join(d)}${close ? 'z' : ''}`
}
/** Screen-space relative path through px points. */
function relpx(q, close = false) {
  const d = []
  for (let i = 1; i < q.length; i++) d.push(r1(q[i][0] - q[i - 1][0]), r1(q[i][1] - q[i - 1][1]))
  return `M${join(q[0])}l${join(d)}${close ? 'z' : ''}`
}
/** Stepped visibility: on over [a, b), plus from `again` to the end when given. */
const vis = (name, a, b, again) => {
  const f = [[0, op(a <= 0 ? 1 : 0)]]
  if (a > 0) f.push([a, op(1)])
  f.push([b, op(0)])
  if (again !== undefined) f.push([again, op(1)])
  return `.${name}{animation-name:${name};animation-timing-function:steps(1,end)}` + kf(name, f)
}
/** Line drawn in over [a, b], held, faded at `out`. Needs pathLength="100" and dasharray 100. */
// dashoffset 101 puts the one dash wholly before the path start, so nothing shows (no round-cap dot)
const draw = (name, a, b, out = 3.2) => `.${name}{animation-name:${name}}` + kf(name, [[a, 'stroke-dashoffset:101'], [b, 'stroke-dashoffset:0'], [out, op(1)], [out + 0.15, op(0)]])
const fade = (name, a, b, f = 0.2) => `.${name}{animation-name:${name}}` + kf(name, [[a - f, op(0)], [a, op(1)], [b, op(1)], [b + f, op(0)]])
const st = (c, w, extra = '') => ` style="stroke:var(${c});stroke-width:${w}${extra}"`
const A1 = '--stage-a1,#c9a6fb', A2 = '--stage-a2,#a57ae8', T1 = '--stage-t1,#d6d8e4', T2 = '--stage-t2,#9da1b6', T3 = '--stage-t3,#6c7086', CUT = '--stage-cut,#ff5555', OL = '--stage-ol,#1a1b24'
/** A stroked open path in mm, drawn in when `cls` runs draw(). */
const line = (cls, ps, c, w, drawn = true) => `<path class="${cls ? cls + ' s-a ' : ''}s-n"${drawn ? ' pathLength="100"' : ''}${st(c, w, drawn ? ';stroke-dasharray:100 102' : '')} d="${rel(ps, false)}"/>`
/** Readout rows stepping at the given [seconds, row] pairs. */
const rows = (id, at) => `.${id}-h{animation-name:${id}-h;animation-timing-function:steps(1,end)}` + rowFrames(`${id}-h`, at)
/** The readout pill placed at screen (x, y), its rows sliding by `${id}-h`. */
const pill = (id, x, y, w) => hud(id, x, y, { w }, `${id}-h`, '')
/** The time bar: a pill with a clock and a bar whose fill steps to each [seconds, share] pair. */
function timebar(id, x, y, at) {
  const css = `.sxs .${id}-t{transform-box:fill-box;transform-origin:left;animation-name:${id}-t;animation-timing-function:cubic-bezier(.65,0,.35,1)}` + kf(`${id}-t`, at.map(([t, s]) => [t, `scale:${s} 1`]))
  const svg = `<g transform="translate(${x} ${y})"><rect class="sxs-pill" x="0" y="-7" width="64" height="14" rx="7"/><circle cx="9" cy="0" r="3.6" style="fill:none;stroke:var(--stage-pill-text,#f8f8f2);stroke-width:1.2"/><path d="M9 -1.8V0h1.6" style="fill:none;stroke:var(--stage-pill-text,#f8f8f2);stroke-width:1.1"/><rect x="17" y="-2" width="40" height="4" rx="2" style="fill:rgb(255 255 255/.18)"/><rect class="${id}-t s-a" x="17" y="-2" width="40" height="4" rx="2" style="fill:var(${A1})"/></g>`
  return { css, svg }
}
/** The nozzle with its tip at (x, y, z) mm: a cone under a small heater block. */
const nozzle = (x, y, z, accent = true) => {
  const c = accent ? { l: 's-g2', r: 's-g3', t: 's-g1', ol: 's-aol' } : {}
  const tip = `<polygon class="${accent ? 's-g2 s-aol' : 's-f2 s-ol'}" points="${[[x, y, z], [x - 1.2, y + 1.2, z + 2.6], [x + 1.2, y - 1.2, z + 2.6]].map((p) => iso(...p).join(',')).join(' ')}"/>`
  return box([x - 2, y - 2, z + 2.6], [x + 2, y + 2, z + 5.6], c) + tip
}
/** Keyframes that move a group through mm offsets [seconds, dx, dy, dz], with opacity when given as a fifth value. */
const tpx = (dx, dy, dz) => { const [a, b] = iso(0, 0, 0), [c, d] = iso(dx, dy, dz); return `${r1(c - a)}px ${r1(d - b)}px`.replace(/^0px 0px$/, '0 0') }
const moveFrames = (name, at) => `.${name}{animation-name:${name}}` + kf(name, at.map(([t, dx, dy, dz, o]) => [t, `translate:${tpx(dx, dy, dz)}${o === undefined ? '' : ';' + op(o)}`]))
/** Points along a polyline at shares of its length: returns [x, y, z] for share s. */
function along(ps, s) {
  const seg = []
  let L = 0
  for (let i = 1; i < ps.length; i++) { const d = Math.hypot(...ps[i].map((v, k) => v - ps[i - 1][k])); seg.push(d); L += d }
  let r = s * L
  for (let i = 0; i < seg.length; i++) {
    if (r <= seg[i] || i === seg.length - 1) { const u = seg[i] ? Math.min(1, r / seg[i]) : 0; return ps[i].map((v, k) => v + (ps[i + 1][k] - v) * u) }
    r -= seg[i]
  }
}
/** Corner times of a polyline drawn over [a, b] at even speed: [t, point] for each vertex. */
function vertexTimes(ps, a, b) {
  const seg = [0]
  for (let i = 1; i < ps.length; i++) seg.push(seg[i - 1] + Math.hypot(...ps[i].map((v, k) => v - ps[i - 1][k])))
  const L = seg[seg.length - 1]
  return ps.map((p, i) => [a + (seg[i] / L) * (b - a), p])
}
/** A thin plate slab (first layer) as a box. */
const slab = (lo, hi, c) => box(lo, hi, c)

/** Zigzag points over a rectangle at height z: lines along x, `sp` apart in y. */
function zig(x0, x1, y0, y1, sp, z) {
  const ps = []
  let k = 0
  for (let y = y0; y <= y1 + 1e-6; y += sp, k++) ps.push(...(k % 2 ? [[x1, y, z], [x0, y, z]] : [[x0, y, z], [x1, y, z]]))
  return ps
}
/** Separate parallel lines along x as one path d. */
function hatch(x0, x1, y0, y1, sp, z, connect = true) {
  const l = []
  for (let y = y0, k = 0; y <= y1 + 1e-6; y += sp, k++) l.push(k % 2 ? [[x1, y, z], [x0, y, z]] : [[x0, y, z], [x1, y, z]])
  return segs(l, connect)
}
/** A rectangle loop on a plane at height z, inset i. */
const rect = (x0, y0, x1, y1, z, i = 0) => rel([[x0 + i, y0 + i, z], [x1 - i, y0 + i, z], [x1 - i, y1 - i, z], [x0 + i, y1 - i, z]])
/** A path element from a d string. */
const pd = (cls, d, c, w, drawn = false) => `<path class="${cls ? cls + ' s-a ' : ''}s-n"${drawn ? ' pathLength="100"' : ''}${st(c, w, drawn ? ';stroke-dasharray:100 102' : '')} d="${d}"/>`
/** A group that runs a class. */
const g = (cls, inner) => `<g class="${cls} s-a">${inner}</g>`
/** Steps a group of states: state i shows over [T[i], T[i+1]), the first again from the last T. */
const states = (id, T) => T.slice(0, -1).map((a, i) => vis(`${id}${i}`, a, T[i + 1], i ? undefined : T.at(-1))).join('')

/** Parallel lines at `deg` in the plate plane, `sp` apart, clipped to a rectangle, as one path d at height z. */
function hatchAt(x0, y0, x1, y1, deg, sp, z) {
  const a = (deg * Math.PI) / 180, dx = Math.cos(a), dy = Math.sin(a), nx = -dy, ny = dx
  const cs = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([x, y]) => x * nx + y * ny)
  const l = []
  let k = 0
  for (let o = Math.min(...cs) + sp / 2; o < Math.max(...cs); o += sp) {
    // the line p = o*n + t*d, clipped to the box
    let t0 = -1e9, t1 = 1e9
    const px = o * nx, py = o * ny
    for (const [p, v, lo, hi] of [[px, dx, x0, x1], [py, dy, y0, y1]]) {
      if (Math.abs(v) < 1e-9) { if (p < lo || p > hi) { t0 = 1; t1 = 0 } continue }
      const u0 = (lo - p) / v, u1 = (hi - p) / v
      t0 = Math.max(t0, Math.min(u0, u1)); t1 = Math.min(t1, Math.max(u0, u1))
    }
    if (t1 - t0 > 0.3) { const a = [px + t0 * dx, py + t0 * dy, z], b = [px + t1 * dx, py + t1 * dy, z]; l.push(k++ % 2 ? [b, a] : [a, b]) }
  }
  return segs(l)
}
/** A circle on the plate plane as a path (n points). */
const circ = (x, y, z, r, n = 24) => rel(Array.from({ length: n }, (_, i) => [x + r * Math.cos((i / n) * 2 * Math.PI), y + r * Math.sin((i / n) * 2 * Math.PI), z]))

/** Segments [[p0, p1], ...] in mm as one compact path: relative moves between them. */
function segs(list, connect = true) {
  let d = '', cur = null
  for (const [a, b] of list) {
    const p = iso(...a), q = iso(...b)
    d += cur ? `${connect ? 'l' : 'm'}${join([r1(p[0] - cur[0]), r1(p[1] - cur[1])])}` : `M${join(p)}`
    d += `l${join([r1(q[0] - p[0]), r1(q[1] - p[1])])}`
    cur = [p[0] + r1(q[0] - p[0]), p[1] + r1(q[1] - p[1])]
  }
  return d
}

// ========== Advanced loops, second half, batch A: pressure advance to skin infill ==========
const Z = 0.3
/** Nozzle riding a polyline drawn over [a, b], shown from a - 0.15 to `out`. */
function rider(name, ps, a, b, out) {
  const p0 = ps[0], vt = vertexTimes(ps, a, b)
  const at = [[a - 0.2, 0, 0, 0, 0], [a - 0.05, 0, 0, 0, 1], ...vt.map(([t, p]) => [t, p[0] - p0[0], p[1] - p0[1], p[2] - p0[2], 1]), [out, ...ps.at(-1).map((v, k) => v - p0[k]), 1], [out + 0.15, ...ps.at(-1).map((v, k) => v - p0[k]), 0]]
  return { css: moveFrames(name, at), svg: `<g class="${name} s-a">${nozzle(...p0)}</g>` }
}

// ---------- pressure advance: an L line; without it a bulge at the corner and a thin start after it ----------
function pressureAdvance() {
  const P = [[-2, -2, Z], [24, -2, Z], [24, 18, Z]], A = [0.2, 1.1], B = [1.85, 2.85]
  const vt = vertexTimes(P, A[0], A[1]), vu = vertexTimes(P, B[0], B[1])
  const d = (p) => p.map((v, k) => v - P[0][k])
  const nz = moveFrames('bqpa-m', [[0.05, 0, 0, 0, 0], [0.2, 0, 0, 0, 1], ...vt.map(([t, p]) => [t, ...d(p)]), [1.2, ...d(P[2]), 1], [1.3, ...d(P[2]), 0], [1.68, 0, 0, 0, 0], [1.8, 0, 0, 0, 1], ...vu.map(([t, p]) => [t, ...d(p)]), [3.2, ...d(P[2]), 1], [3.35, ...d(P[2]), 0]])
  const tc = vt[1][0], tg = tc + (A[1] - tc) * 0.4
  const css = [draw('bqpa-o', A[0], tc, 1.55), draw('bqpa-s', tc, tg, 1.55), draw('bqpa-r', tg, A[1], 1.55), fade('bqpa-b', tc, 1.55, 0.06), draw('bqpa-g', B[0], B[1]), nz, rows('bqpa', [[0, 0], [1.75, 1], [3.35, 0]])].join('')
  // off: grey line, a blob where it stops to turn, then a starved, broken stretch
  const body = line('bqpa-o', P.slice(0, 2), T3, 5) + line('bqpa-s', [[24, 0.6, Z], [24, 6, Z]], CUT, 1.8) + line('bqpa-r', [[24, 6, Z], P[2]], T3, 5) +
    `<g class="bqpa-b s-a">${ellipse(disc(24, -2, Z, 2.6), 's-f3 s-cl')}</g>` +
    line('bqpa-g', P, A1, 5) + `<g class="bqpa-m s-a">${nozzle(...P[0])}</g>` + pill('bqpa', 200, 44, 70)
  return { id: 'bqpa', about: 'Pressure advance: off, the line bulges where the nozzle slows for the corner and runs thin after it; on, the line stays even.', css, body, readout: { rows: ['PA off', 'PA 0.04'], w: 70 } }
}

const H2 = [[0, 0], [1.75, 1], [3.45, 0]], H3 = [[0, 0], [1.15, 1], [2.3, 2], [3.45, 0]]
const T2S = [0, 1.75, 3.45], T3S = [0, 1.15, 2.3, 3.45]

// ---------- prime tower: a part changing color, the old color purged into a tower beside it ----------
const PART = (streak) => box([0, 4, 0], [10, 14, 6]) + accentBox([0, 4, 6], [10, 14, 10]) + (streak ? g(streak, pd('', rel([[1, 14, 8.6], [7, 14, 7.4]], false) + rel([[10, 12, 8.4], [10, 6, 7]], false) + rel([[3, 14, 7], [9, 14, 6.6]], false) + rel([[3, 6, 10], [8, 9, 10]], false), T1, 2.4)) : '')
function tower(id, { x0 = 15, x1 = 23, y0 = -1, y1 = 7, h = 10, sp = 1.4, n } = {}, cls) {
  const ps = zig(x0 + 0.7, x1 - 0.7, y0 + 0.7, y1 - 0.7, sp, h)
  return box([x0, y0, 0], [x1, y1, h]) + line(cls, n ? ps.slice(0, n) : ps, A2, 1.6)
}
function primeTower(id, mode) {
  let css = '', body = '', rowsT = ['Off', 'On'], about = '', tb
  const S = (i) => `${id}${i}`
  if (mode === 'enable') {
    css = states(id, T2S) + draw(`${id}-z`, 2, 2.9)
    body = PART(S(0)) + g(S(1), tower(id, {}, `${id}-z`))
    about = 'Prime tower: off, the old color streaks the part after a change; on, it purges into a tower beside the part.'
  } else if (mode === 'width') {
    rowsT = ['35 mm', '60 mm']
    css = states(id, T2S) + draw(`${id}-y`, 0.3, 1.1, 1.6) + draw(`${id}-z`, 2, 2.8) + `.${id}-w{animation-name:${id}-w;transform-box:fill-box;transform-origin:50% 100%}` + kf(`${id}-w`, [[0.5, 'rotate:0deg'], [0.75, 'rotate:-6deg'], [1, 'rotate:6deg'], [1.25, 'rotate:-8deg'], [1.5, 'rotate:7deg'], [1.7, 'rotate:0deg']])
    body = PART() + g(S(0), g(`${id}-w`, tower(id, { x0: 17.5, x1: 20.5, y0: 1.5, y1: 4.5, h: 14, sp: 1 }, `${id}-y`))) + g(S(1), tower(id, { h: 14 }, `${id}-z`))
    about = 'Prime tower width: a narrow tall tower wobbles; a wider one stands steady.'
  } else if (mode === 'gap') {
    rowsT = ['100 %', '200 %']
    tb = timebar(id, 0, 0, [[0, 0.8], [1.7, 0.8], [2, 0.45], [3.3, 0.45], [3.45, 0.8]])
    css = states(id, T2S) + draw(`${id}-y`, 0.3, 1.3, 1.6) + draw(`${id}-z`, 2, 2.8) + tb.css
    body = PART() + g(S(0), tower(id, { sp: 1.1 }, `${id}-y`)) + g(S(1), tower(id, { sp: 2.2 }, `${id}-z`))
    about = 'Prime tower infill gap: the purge lines inside the tower spread apart, which saves filament and time.'
  } else if (mode === 'volume') {
    rowsT = ['15 mm³', '45 mm³']
    tb = timebar(id, 0, 0, [[0, 0.35], [1.7, 0.35], [2.4, 0.9], [3.3, 0.9], [3.45, 0.35]])
    css = states(id, T2S) + draw(`${id}-y`, 0.3, 0.8, 1.6) + draw(`${id}-z`, 2, 2.9) + tb.css
    body = PART(S(0)) + g(S(0), tower(id, { n: 3 }, `${id}-y`)) + g(S(1), tower(id, {}, `${id}-z`))
    about = 'Purge volume: too little and the old color streaks the part; enough, and it comes out clean but takes longer.'
  } else if (mode === 'brim') {
    rowsT = ['0 mm', '3 mm']
    css = states(id, T2S) + draw(`${id}-r`, 1.9, 2.5)
    let d = ''
    for (let i = 1; i <= 4; i++) d += rect(15 - i * 0.8, -1 - i * 0.8, 23 + i * 0.8, 7 + i * 0.8, 0)
    css += `.${id}-w{animation-name:${id}-w;transform-box:fill-box;transform-origin:0 100%}` + kf(`${id}-w`, [[0.3, 'rotate:0deg'], [1, 'rotate:-5deg'], [1.6, 'rotate:-5deg'], [1.7, 'rotate:0deg']])
    body = PART() + g(S(1), pd(`${id}-r`, d, A1, 1.4, true)) + g(S(0), pd('', rel([[15, 7, 0], [23, 7, 0], [23, -1, 0]], false), CUT, 1.4).replace('s-n', 's-n s-ghost')) + g(`${id}-w`, tower(id, {}, ''))
    about = 'Prime tower brim: rings around the tower\'s base hold it down so it cannot tip or lift.'
  }
  body += pill(id, 212, 40, 64) + (tb ? tb.svg.replace('translate(0 0)', 'translate(212 58)') : '')
  return { id, about, css: css + rows(id, H2), body, readout: { rows: rowsT, w: 64 } }
}
const primeTowerOn = () => primeTower('bqpt', 'enable')
const primeTowerWidth = () => primeTower('bqpw', 'width')
const primeTowerGap = () => primeTower('bqpg', 'gap')
const primeVolume = () => primeTower('bqpv', 'volume')
const primeTowerBrim = () => primeTower('bqpb', 'brim')

// ---------- print sequence: btwo parts by layer, then one after the other ----------
function printSequence() {
  const id = 'bqps', H = 12, L = 4
  const parts = { a: [[-4, 6], [4, 14]], b: [[14, -2], [22, 6]] }
  // [time, part, height]: by layer, then by object
  const seq = [[0.3, 'a', 4], [0.5, 'b', 4], [0.7, 'a', 8], [0.9, 'b', 8], [1.1, 'a', 12], [1.3, 'b', 12], [1.95, 'a', 4], [2.15, 'a', 8], [2.35, 'a', 12], [2.6, 'b', 4], [2.8, 'b', 8], [3.0, 'b', 12]]
  let css = '', body = '', defs = ''
  for (const [k, [[x0, y0], [x1, y1]]] of Object.entries(parts)) {
    const f = [[0, `translate:${tpx(0, 0, -H)};${op(0)}`]]
    for (const [t, p, h] of seq) if (p === k) f.push([t, `translate:${tpx(0, 0, h - H)};${op(1)}`])
    f.push([1.7, `translate:${tpx(0, 0, -H)};${op(0)}`], [3.4, op(0)])
    f.sort((u, v) => u[0] - v[0])
    css += `.${id}-${k}{animation-name:${id}-${k};animation-timing-function:steps(1,end)}` + kf(`${id}-${k}`, f)
    const c = [iso(x0, y1, 0), iso(x1, y1, 0), iso(x1, y0, 0)]
    defs += `<clipPath id="${id}-c${k}"><polygon points="${c[0][0]},0 ${c.map((q) => q.join(',')).join(' ')} ${c[2][0]},0"/></clipPath>`
    body += `<g clip-path="url(#${id}-c${k})">${g(`${id}-${k}`, box([x0, y0, 0], [x1, y1, H]))}</g>`
  }
  // the nozzle hops to the layer being printed
  const cen = { a: [0, 10], b: [18, 2] }, n0 = [0, 10, 0]
  const nf = [[0, `translate:${tpx(0, 0, L)}`]]
  for (const [t, p, h] of seq) nf.push([t - 0.08, null], [t, `translate:${tpx(cen[p][0] - n0[0], cen[p][1] - n0[1], h)}`])
  const nfs = []
  let last = nf[0][1]
  for (const [t, v] of nf) { nfs.push([t, v ?? last]); if (v) last = v }
  nfs.push([1.55, last + ';' + op(1)], [1.6, op(0)], [1.8, `translate:${tpx(0, 0, L)};${op(1)}`], [3.3, op(1)], [3.4, op(0)])
  css += `.${id}-n{animation-name:${id}-n}` + kf(`${id}-n`, nfs)
  body = defs + body + g(`${id}-n`, nozzle(...n0)) + pill(id, 206, 40, 74)
  return { id, about: 'Print sequence: by layer, the nozzle hops between the parts every layer; by object, it finishes one part, then prints the other.', css: css + rows(id, [[0, 0], [1.75, 1], [3.45, 0]]), body, readout: { rows: ['By layer', 'By object'], w: 74 } }
}

/** Two or three states with their rows; `parts[i]` is drawn in state i. */
function staged(id, parts, rowsT, about, { css = '', extra = '', after = '', w = 64, x = 212, y = 40 } = {}) {
  const T = parts.length === 2 ? T2S : T3S
  return { id, about, css: states(id, T) + rows(id, parts.length === 2 ? H2 : H3) + css, body: extra.replace(/\{(\d)\}/g, '') + parts.map((b, i) => g(`${id}${i}`, b)).join('') + after + pill(id, x, y, w), readout: { rows: rowsT, w } }
}
const ghost = (d) => `<path class="s-ghost" d="${d}"/>`
const dots = (ps, cls, r = 0.7) => ps.map(([x, y, z]) => ellipse(disc(x, y, z, r), cls)).join('')

// ---------- raft ----------
const RAFT = (e = 0, z = 1.8) => box([-3 - e, -1 - e, 0], [19 + e, 15 + e, z])
function raftContact() {
  const id = 'bqrc', P = (gap) => box([1, 3, 1.8 + gap], [15, 11, 9.8 + gap])
  const fused = pd('', rel([[1, 11, 1.8], [15, 11, 1.8], [15, 3, 1.8]], false), CUT, 2.2)
  const sag = `<path class="s-n"${st(CUT, 2.2)} d="M${iso(1, 11, 3.6).join(' ')}Q${iso(8, 11, 1.4).join(' ')} ${iso(15, 11, 3.6).join(' ')}"/>`
  return staged(id, [P(0) + fused, P(0.6), P(1.8) + sag], ['0 mm', '0.1 mm', '0.3 mm'], 'Raft contact distance: no gap and the part fuses to the raft; a small gap peels clean; too much and the bottom droops.', { extra: RAFT() })
}
function raftExpansion() {
  const P = box([1, 3, 1.8], [15, 11, 9.8])
  return staged('bqre', [RAFT(0) + P, RAFT(1.5) + P, RAFT(3) + P], ['0 mm', '1.5 mm', '3 mm'], 'Raft expansion: the raft reaches further past the part on every side.')
}
function raftFirstDensity() {
  const id = 'bqrd', top = box([3, 5, 0.5], [13, 11, 1.8])
  const L = (sp, c) => pd(`${id}-l${c}`, hatch(-3, 19, -1, 15, sp, 0.25, false), A1, 1.6, true)
  return staged(id, [L(3, 0) + top, L(1.2, 1) + top], ['50 %', '90 %'], 'Raft first layer density: the lines laid on the bed spread out or close up; denser grips the bed better.', { css: draw(`${id}-l0`, 0.2, 0.9, 1.6) + draw(`${id}-l1`, 1.9, 2.6) })
}
function raftFirstExpansion() {
  const id = 'bqrx', top = box([-1, 1, 0.5], [17, 13, 1.8])
  const L = (e, c) => pd(`${id}-l${c}`, hatch(-1 - e, 17 + e, 1 - e, 13 + e, 1.4, 0.25, false), A1, 1.4, true)
  return staged(id, [L(0, 0) + top, L(3, 1) + top], ['0 mm', '3 mm'], 'Raft first layer expansion: the first raft layer reaches past the rest of the raft, a wider footing on the bed.', { css: draw(`${id}-l0`, 0.2, 0.9, 1.6) + draw(`${id}-l1`, 1.9, 2.6) })
}

// ---------- extrusion rate smoothing: flow over distance on a standing graph ----------
const GY = 6.6, gp = (x, z) => [x, GY, z]
const curve = (ps) => rel(ps.map(([x, z]) => gp(x, z)), false)
const AX = box([-6, 6, 0], [30, 6.6, 13]) + pd('', curve([[-4, 1], [28, 1]]), T3, 1.2)
const STEP = [[-4, 3], [8, 3], [8, 11], [9, 6.5], [12, 10], [20, 10], [20, 1.5], [21.5, 4.5], [22, 3], [28, 3]]
const RAMP = [[-4, 3], [6, 3], [12, 10], [18, 10], [24, 3], [28, 3]]
const bad = dots([[8.2, 6.6, 10.6], [20.4, 6.6, 2]], 's-cf s-cl', 1.4)
function rateSmoothing() {
  const id = 'bqrs'
  return staged(id, [pd(`${id}-a`, curve(STEP), T3, 2.4, true) + bad, pd(`${id}-b`, curve(RAMP), A2, 2.6, true)], ['Off', '300 mm³/s²'], 'Extrusion rate smoothing: off, flow jumps when the speed changes and leaves a gap and a bulge; on, it ramps.', { w: 92, x: 192, css: draw(`${id}-a`, 0.2, 1, 1.6) + draw(`${id}-b`, 1.9, 2.7), extra: AX })
}
function rateSegment() {
  const id = 'bqrg'
  const stairs = (n) => { const p = [[-4, 3], [6, 3]]; for (let k = 1; k <= n; k++) p.push([6 + (6 * k) / n - 6 / n, 3 + (7 * k) / n], [6 + (6 * k) / n, 3 + (7 * k) / n]); p.push([18, 10]); for (let k = 1; k <= n; k++) p.push([18 + (6 * k) / n - 6 / n, 10 - (7 * k) / n], [18 + (6 * k) / n, 10 - (7 * k) / n]); p.push([28, 3]); return p }
  return staged(id, [pd(`${id}-a`, curve(stairs(2)), A2, 2.4, true), pd(`${id}-b`, curve(stairs(6)), A2, 2.4, true)], ['3 mm', '1 mm'], 'Smoothing segment length: the ramp is cut into steps this long; shorter steps follow it more closely.', { css: draw(`${id}-a`, 0.2, 1, 1.6) + draw(`${id}-b`, 1.9, 2.7), extra: AX })
}
function rateOuter() {
  const id = 'bqro', up = (ps) => ps.map(([x, z]) => [x, z + 1.5])
  // the outer wall (accent) and an inner wall (grey): all lines smoothed, then only the outer wall
  return staged(id, [pd('', curve(up(RAMP)), A2, 2.4) + pd('', curve(RAMP.map(([x, z]) => [x, z - 1.5])), T3, 2), pd('', curve(up(RAMP)), A2, 2.4) + pd('', curve(STEP.map(([x, z]) => [x, z - 1.5])), T3, 2)], ['All lines', 'Outer wall'], 'Smoothing on the outer wall only: the outer wall keeps its ramp; inner lines change flow at once.', { w: 82, x: 200, extra: AX })
}

// ---------- retraction: btwo posts, the nozzle travels between their tops ----------
const PH = 12, POSTS = box([-2, 4, 0], [4, 10, PH]) + box([16, -2, 0], [22, 4, PH])
const TA = [1, 7, PH], TB = [19, 1, PH]
const strings = (n, c = CUT, w = 1.2) => { let d = ''; for (let k = 0; k < n; k++) { const a = iso(1 + k * 0.8, 6 + k * 0.6, PH), b = iso(18.4 + k * 0.6, 1 + k * 0.6, PH), m = iso(10, 4, PH - 4 - k * 1.5); d += `M${a.join(' ')}Q${m.join(' ')} ${b.join(' ')}` } return `<path class="s-n"${st(c, w)} d="${d}"/>` }
function travel(id, a, b) {
  const d = TB.map((v, k) => v - TA[k])
  return moveFrames(`${id}-n`, [[a - 0.25, 0, 0, 0, 0], [a - 0.1, 0, 0, 0, 1], [a + 0.4, ...d, 1], [1.55, ...d, 1], [1.62, ...d, 0], [b - 0.25, 0, 0, 0, 0], [b - 0.1, 0, 0, 0, 1], [b + 0.4, ...d, 1], [3.3, ...d, 1], [3.4, ...d, 0]]) + `.${id}-s{animation-name:${id}-s}` + kf(`${id}-s`, [[a + 0.1, op(0)], [a + 0.4, op(1)], [1.6, op(1)], [1.7, op(0)]])
}
function retraction(id, rowsT, about, s0, s1, extra = '') {
  return staged(id, [g(`${id}-s`, s0), s1], rowsT, about, { css: travel(id, 0.4, 2.15), extra: POSTS + extra, after: g(`${id}-n`, nozzle(...TA)) })
}
const retractionLength = () => retraction('bqrl', ['0 mm', '0.8 mm'], 'Retraction length: with none, plastic oozes and strings between the posts; pulled back 0.8 mm, the travel is clean.', strings(3), '')
const retractionSpeed = () => retraction('bqrv', ['10 mm/s', '40 mm/s'], 'Retraction speed: pulled back too slowly, the nozzle still oozes a string; fast enough, it travels clean.', strings(1), '')
function deretractionSpeed() {
  const id = 'bqdr', st0 = line('', [[16.6, 3.4, PH], [19, 1, PH]], CUT, 1.2, false).replace('s-n"', 's-n" stroke-dasharray="1.5 2"') + line('', [[19, 1, PH], [21.4, -1.4, PH]], A2, 3.2, false), st1 = line('', [[16.6, 3.4, PH], [21.4, -1.4, PH]], A2, 3.2, false)
  const r = retraction(id, ['10 mm/s', '40 mm/s'], 'Deretraction speed: pushed back too slowly, the next line starts thin; at speed it starts full.', st0, g(`${id}-k`, st1))
  r.css += `.${id}-k{animation-name:${id}-k}` + kf(`${id}-k`, [[2.5, op(0)], [2.7, op(1)]])
  return r
}
function retractionMinTravel() {
  const id = 'bqrm', mark = (p) => ellipse(disc(...p, 1.2), 's-af s-al')
  const tb = timebar(id, 0, 0, [[0, 0.8], [1.7, 0.8], [2, 0.55], [3.3, 0.55], [3.45, 0.8]])
  const hop = line('', [[-1, 5, PH], [3, 9, PH]], T3, 1.2, false).replace('s-n"', 's-n" stroke-dasharray="2 2"')
  const r = retraction(id, ['1 mm', '4 mm'], 'Minimum travel for retraction: short hops inside a part skip the retraction, which saves time; long travels still retract.', mark([-1, 5, PH]) + mark(TA), mark(TA), hop)
  r.css += tb.css
  r.body += tb.svg.replace('translate(0 0)', 'translate(212 58)')
  return r
}
function retractWhen() {
  const id = 'bqrw', B = box([2, 2, 0], [18, 12, 10]), c = [18, 12, 10]
  const blob = ellipse(disc(...c, 1.6), 's-cf s-cl') + `<path class="s-n"${st(CUT, 1.4)} d="M${iso(...c).join(' ')}q5 -7 -1 -12"/>`
  const up = (a) => [[a, 0, 0, 0], [a + 0.3, 0, 0, 3]]
  const css = moveFrames(`${id}-n`, [...up(0.3), [1.6, 0, 0, 3], [1.75, 0, 0, 0], ...up(2.05)]) + `.${id}-b{animation-name:${id}-b}` + kf(`${id}-b`, [[0.45, op(0)], [0.6, op(1)], [1.6, op(1)], [1.7, op(0)]])
  return staged(id, [g(`${id}-b`, blob), ''], ['Off', 'On'], 'Retract when changing layer: without it the nozzle oozes a blob and a string where it steps up a layer; with it, the step is clean.', { css, extra: B, after: g(`${id}-n`, nozzle(...c)) })
}

// ---------- z hop band: btwo posts grow; the travel between their tops hops only inside the band ----------
function zband(id, lo, hi, rowsT, about) {
  const H = 15, lvl = [4, 9, 14], inBand = (z) => z >= lo && z <= hi
  const posts = [[[-2, 4], [4, 10]], [[16, -2], [22, 4]]]
  const clip = `<clipPath id="${id}-c">${posts.map(([[x0, y0], [x1, y1]]) => { const c = [iso(x0, y1, 0), iso(x1, y1, 0), iso(x1, y0, 0)]; return `<polygon points="${c[0][0]},0 ${c.map((q) => q.join(',')).join(' ')} ${c[2][0]},0"/>` }).join('')}</clipPath>`
  const T = [0.25, 0.75, 1.25, 1.95, 2.45, 2.95]
  const f = [[0, `translate:${tpx(0, 0, lvl[0] - H)}`]]
  T.forEach((t, i) => f.push([t, `translate:${tpx(0, 0, lvl[i % 3] - H)}`]))
  let css = `.${id}-p{animation-name:${id}-p;animation-timing-function:steps(1,end)}` + kf(`${id}-p`, f)
  const hopD = (z, hop) => { const a = [1, 7, z], b = [19, 1, z]; return hop ? `M${iso(...a).join(' ')}Q${iso(10, 4, z + 7).join(' ')} ${iso(...b).join(' ')}` : rel([a, b], false) }
  // one draw-in, shifted per travel by its delay
  css += draw(`${id}-t`, T[0] + 0.1, T[0] + 0.4, T[0] + 0.45)
  let t0 = '', t1 = ''
  const dl = (i) => (i ? `<g style="animation-delay:${r1((T[i] - T[0]) * 100) / 100}s" class="${id}-t s-a">` : `<g class="${id}-t s-a">`)
  lvl.forEach((z, i) => {
    t0 += dl(i) + pd('', hopD(z, true), A1, 1.8, true) + '</g>'
    t1 += dl(i + 3) + pd('', hopD(z, inBand(z)), inBand(z) ? A1 : T2, 1.8, true) + '</g>'
  })
  const band = pd('', rel([[-5, 10, Math.max(lo, 0)], [-5, 10, Math.min(hi, 16)]], false), A1, 4) + pd('', rel([[-7, 10, rowsT[1].startsWith('Above') ? lo : hi], [-3, 10, rowsT[1].startsWith('Above') ? lo : hi]], false), A2, 2.6)
  const body = clip + `<g clip-path="url(#${id}-c)">${g(`${id}-p`, posts.map(([[x0, y0], [x1, y1]]) => box([x0, y0, 0], [x1, y1, H])).join(''))}</g>`
  return staged(id, [t0, band + t1], rowsT, about, { css, w: 92, x: 192, extra: body })
}
const liftAbove = () => zband('bqza', 6, 99, ['Always', 'Above 6 mm'], 'Lift Z above: travels lift only from this height up; the low travel stays flat.')
const liftBelow = () => zband('bqzb', 0, 12, ['Always', 'Below 12 mm'], 'Lift Z below: travels lift only under this height; the high travel stays flat.')
function liftEnforce() {
  const id = 'bqze', B = box([0, 0, 0], [22, 14, 6]), a = [2, 7, 6.6], b = [20, 7, 6.6]
  const flat = pd('', rel([a, b], false), T2, 1.4) + pd('', rel([[5, 7.4, 6], [17, 7.4, 6]], false), CUT, 1.6)
  const hop = pd('', `M${iso(...a).join(' ')}Q${iso(11, 7, 12).join(' ')} ${iso(...b).join(' ')}`, A1, 1.6)
  return staged(id, [hop, flat, hop], ['All surfaces', 'Bottom only', 'Top only'], 'Enforce lift on: lifting over top surfaces keeps the nozzle from scratching them; bottom only drags across the top.', { w: 96, x: 186, extra: B })
}
function liftToolchange() {
  const id = 'bqzt', B = box([0, 0, 0], [22, 14, 6]), a = [2, 7, 6.6], b = [20, 7, 6.6]
  const flat = pd('', rel([a, b], false), T2, 1.4) + pd('', rel([[5, 7.4, 6], [17, 7.4, 6]], false), CUT, 1.6)
  const hop = pd('', `M${iso(...a).join(' ')}Q${iso(11, 7, 12).join(' ')} ${iso(...b).join(' ')}`, A1, 1.6)
  // the tool swaps, grey for accent, at the start of each state
  const sw = (n, v) => `.${n}{animation-name:${n};animation-timing-function:steps(1,end)}` + kf(n, [[0, op(v)], [0.35, op(1 - v)], [1.75, op(v)], [2.1, op(1 - v)]])
  const css = sw(`${id}-x`, 1) + sw(`${id}-y`, 0)
  return staged(id, [flat, hop], ['Off', 'On'], 'Lift Z after a tool change: the new nozzle lifts before it travels over the part instead of dragging across it.', { css, extra: B, after: g(`${id}-x`, nozzle(...a, false)) + g(`${id}-y`, nozzle(...a)) })
}

// ---------- scarf seam: a wall face with its layer lines; the seam is a zit or a ramp ----------
const WF = (n = 6) => { const B = box([0, 0, 0], [26, 12, n * 2]); let d = ''; for (let k = 1; k < n; k++) d += rel([[0, 12, k * 2], [26, 12, k * 2]], false); return B + pd('', d, T3, 1) }
const zits = (x) => dots(Array.from({ length: 6 }, (_, k) => [x, 12, k * 2 + 1.6]), 's-cf s-cl', 0.8)
/** ramps on the front face: each layer's start rises from `f` of a layer over `L` mm at x0, in `n` steps (0 = smooth). */
function ramps(x0, L, { f = 0, n = 0, layers = 6 } = {}) {
  let d = ''
  for (let k = 0; k < layers; k++) {
    const z0 = k * 2 + f * 2, z1 = k * 2 + 2
    if (!n) { d += rel([[x0, 12, z0], [x0 + L, 12, z1]], false); continue }
    const ps = [[x0, 12, z0]]
    for (let i = 1; i <= n; i++) ps.push([x0 + (L * (i - 1)) / n + L / n, 12, z0 + ((z1 - z0) * (i - 1)) / n], [x0 + (L * i) / n, 12, z0 + ((z1 - z0) * i) / n])
    d += rel(ps.map((p, i) => i % 2 ? p : p), false)
  }
  return d
}
const scarf = (id, d, w = 2.2, c = A2) => pd(`${id}-r`, d, c, w, true)
function scarfLoop(id, a, b, rowsT, about, opts = {}) {
  return staged(id, [a, b], rowsT, about, { extra: WF(), css: draw(`${id}-r`, 0.3, 1, 1.6).replace(`.${id}-r{`, `.${id}0 .${id}-r{`) + draw(`${id}-q`, 2, 2.7).replace(`.${id}-q{`, `.${id}1 .${id}-r{`).replace(`@keyframes ${id}-q`, `@keyframes ${id}-q`).replace(`animation-name:${id}-q`, `animation-name:${id}-q`), ...opts })
}
const scarfType = () => scarfLoop('bqsc', zits(12), scarf('bqsc', ramps(8, 10)), ['None', 'Contour'], 'Scarf joint seam: a plain seam leaves a bump on every layer; a scarf ramps each layer\'s start under its end, so the seam almost disappears.')
const scarfLength = () => scarfLoop('bqsl', scarf('bqsl', ramps(10, 5)), scarf('bqsl', ramps(6, 13)), ['10 mm', '20 mm'], 'Scarf length: the ramp stretches over a longer run of the wall, which hides the seam better.')
const scarfSteps = () => scarfLoop('bqss', scarf('bqss', ramps(8, 10, { n: 2 })), scarf('bqss', ramps(8, 10, { n: 8 })), ['2 steps', '8 steps'], 'Scarf steps: the ramp is printed in this many height steps; more steps make it smoother.')
const scarfStart = () => scarfLoop('bqsh', scarf('bqsh', ramps(8, 10)), scarf('bqsh', ramps(8, 10, { f: 0.5 })), ['0 %', '50 %'], 'Scarf start height: the ramp starts this far up the layer instead of at its bottom.')
const scarfEntire = () => scarfLoop('bqsx', scarf('bqsx', ramps(8, 10)), scarf('bqsx', ramps(0, 26)), ['Off', 'On'], 'Scarf over the entire loop: the ramp runs around the whole wall instead of a short stretch.')
const scarfFlow = () => scarfLoop('bqsf', scarf('bqsf', ramps(8, 10), 3.2) + dots([[18, 12, 2], [18, 12, 6], [18, 12, 10]], 's-cf s-cl', 0.9), scarf('bqsf', ramps(8, 10), 1.8), ['100 %', '90 %'], 'Scarf flow and speed: the ramp prints where the layer overlaps itself, so a little less flow or a slower pass keeps that spot from bulging.')
function scarfThreshold() {
  // no sharp corner: the loop gets a ramp; with a sharp corner the plain seam hides in it
  const id = 'bqsa'
  return staged(id, [scarf(id, ramps(8, 10)), dots(Array.from({ length: 6 }, (_, k) => [26, 12, k * 2 + 1.6]), 's-af s-al', 0.8)], ['Smooth', 'Corner'], 'Scarf angle threshold: a loop with no corner sharper than this gets a scarf; a loop with a sharp corner hides a plain seam in it.', { extra: WF(), css: draw(`${id}-r`, 0.3, 1, 1.6) })
}

// ---------- seam: top view of wall loops on a slab ----------
const SL = box([0, 0, 0], [24, 16, 2])
const loopFrom = (i, z = 2.1) => (i = i < 2 ? 2.5 : i, 0) || [[12, 16 - i, z], [i, 16 - i, z], [i, i, z], [24 - i, i, z], [24 - i, 16 - i, z]]
function seamPosition() {
  const id = 'bqsp', col = (x, y, ok) => dots(Array.from({ length: 6 }, (_, k) => [x, y, k * 2 + 1.6]), ok ? 's-af s-al' : 's-cf s-cl', 0.8)
  const rnd = dots([[3, 12, 1.6], [17, 12, 3.6], [8, 12, 5.6], [26, 4, 7.6], [22, 12, 9.6], [26, 9, 11.6]], 's-af s-al', 0.8)
  return staged(id, [col(12, 12, 1), col(0.6, 12, 1), rnd], ['Aligned', 'Back', 'Random'], 'Seam position: where each layer starts and ends; aligned stacks the marks in one line, back hides them at the back, random scatters them.', { extra: WF(), w: 72, x: 204 })
}
function seamGap() {
  const id = 'bqsg', L = loopFrom(1)
  const full = [...L, [12, 13.5, 2.1]], short = [...L, [16, 13.5, 2.1]]
  return staged(id, [pd(`${id}-a`, rel(full, false), A2, 2.4, true) + ellipse(disc(12, 13.5, 2.1, 1.4), 's-cf s-cl'), pd(`${id}-b`, rel(short, false), A2, 2.4, true)], ['0 %', '15 %'], 'Seam gap: the loop stops a little short of its start, so the ends meet without a blob.', { extra: SL, css: draw(`${id}-a`, 0.2, 1.1, 1.6) + draw(`${id}-b`, 1.9, 2.8) })
}
function seamStagger() {
  const id = 'bqsi', loops = [1, 2.6, 4.2].map((i) => pd('', rect(i, i, 24 - i, 16 - i, 2.1), T3, 1.6)).join('')
  const al = dots([[12, 15, 2.1], [12, 13.4, 2.1], [12, 11.8, 2.1]], 's-cf s-cl', 0.8), sg = dots([[12, 15, 2.1], [2.6, 7, 2.1], [19.8, 4.2, 2.1]], 's-af s-al', 0.8)
  return staged(id, [al, sg], ['Off', 'On'], 'Staggered inner seams: the inner walls start at different spots, so their seams do not line up into one weak line.', { extra: SL + loops })
}
function wipeOnLoops() {
  const id = 'bqwl', L = loopFrom(1)
  const wipe = pd(`${id}-w`, rel([[12, 13.5, 2.1], [6, 13.5, 2.1], [4, 8, 2.1]], false), A2, 2.4, true)
  return staged(id, [ellipse(disc(12, 13.5, 2.1, 1.4), 's-cf s-cl'), wipe], ['Off', 'On'], 'Wipe on loops: after closing a loop the nozzle moves a little inward along the part, which hides the seam\'s blob.', { extra: SL + pd('', rel([...L, [12, 13.5, 2.1]], false), T3, 2.4), css: draw(`${id}-w`, 2, 2.5) })
}
function wipeBefore() {
  const id = 'bqwb', L = loopFrom(1)
  const into = pd(`${id}-w`, rel([[6, 8, 2.1], [9, 13.5, 2.1], [12, 13.5, 2.1]], false), A2, 2.4, true)
  return staged(id, [ellipse(disc(12, 13.5, 2.1, 1.4), 's-cf s-cl'), into], ['Off', 'On'], 'Wipe before the outer wall: the nozzle starts the outer loop with a short move from inside the part, so the start does not leave a blob on the surface.', { extra: SL + pd('', rel([...L, [12, 13.5, 2.1]], false), T3, 2.4), css: draw(`${id}-w`, 1.95, 2.4) })
}

// ---------- locked zag: a slab top, skin along the walls and skeleton inside ----------
const ZT = 2.1, ZW = 26, ZH = 18
function zag(id, s0, s1, rowsT, about) {
  // s: { skin: spacing, depth, sw (skin width px), core: spacing, cw }
  const part = (s) => {
    const d = s.depth
    let skin = hatch(0.6, ZW - 0.6, 0.6, d, s.skin, ZT, false) + hatch(0.6, ZW - 0.6, ZH - d, ZH - 0.6, s.skin, ZT, false)
    for (let y = d + s.skin / 2; y < ZH - d; y += s.skin) skin += rel([[0.6, y, ZT], [d, y, ZT]], false) + rel([[ZW - d, y, ZT], [ZW - 0.6, y, ZT]], false)
    return pd('', skin, s.hiSkin ? A2 : T3, s.sw) + pd('', hatch(d + 0.8, ZW - d - 0.8, d + 0.8, ZH - d - 0.8, s.core, ZT, false), s.hiSkin ? T3 : A2, s.cw)
  }
  return staged(id, [part(s0), part(s1)], rowsT, about, { extra: box([0, 0, 0], [ZW, ZH, 2]) })
}
const Z0 = { skin: 1, depth: 4, sw: 1.2, core: 3, cw: 1.7 }
const skeletonDensity = () => zag('bqkd', { ...Z0, core: 4 }, { ...Z0, core: 2 }, ['15 %', '30 %'], 'Skeleton infill density: the lines in the core of a locked zag fill sit further apart or closer together.')
const skeletonWidth = () => zag('bqkw', { ...Z0, cw: 1 }, { ...Z0, cw: 2.4 }, ['0.4 mm', '0.8 mm'], 'Skeleton line width: the core lines of a locked zag fill print thinner or wider.')
const skinDensity = () => zag('bqnd', { ...Z0, hiSkin: 1, skin: 2 }, { ...Z0, hiSkin: 1, skin: 1 }, ['50 %', '100 %'], 'Skin infill density: the lines along the walls of a locked zag fill sit further apart or close up.')
const skinDepth = () => zag('bqnp', { ...Z0, hiSkin: 1, depth: 2.6 }, { ...Z0, hiSkin: 1, depth: 6 }, ['2 mm', '5 mm'], 'Skin infill depth: how far the dense skin reaches in from the walls before the core starts.')
const skinWidth = () => zag('bqnw', { ...Z0, hiSkin: 1, sw: 1 }, { ...Z0, hiSkin: 1, sw: 2 }, ['0.4 mm', '0.6 mm'], 'Skin line width: the lines along the walls of a locked zag fill print thinner or wider.')

/** Advanced, second half, by the file name the export uses. */
export const LOOPS = {
  'adv-pressure-advance': pressureAdvance,
  'adv-prime-tower': primeTowerOn,
  'adv-prime-tower-width': primeTowerWidth,
  'adv-prime-tower-infill-gap': primeTowerGap,
  'adv-prime-volume': primeVolume,
  'adv-prime-tower-brim-width': primeTowerBrim,
  'adv-raft-contact-distance': raftContact,
  'adv-raft-expansion': raftExpansion,
  'adv-raft-first-layer-density': raftFirstDensity,
  'adv-raft-first-layer-expansion': raftFirstExpansion,
  'adv-extrusion-rate-smoothing': rateSmoothing,
  'adv-rate-smoothing-segment-length': rateSegment,
  'adv-rate-smoothing-outer-wall': rateOuter,
  'adv-retraction-length': retractionLength,
  'adv-retraction-speed': retractionSpeed,
  'adv-deretraction-speed': deretractionSpeed,
  'adv-retraction-minimum-travel': retractionMinTravel,
  'adv-retract-when-changing-layer': retractWhen,
  'adv-retract-lift-above': liftAbove,
  'adv-retract-lift-below': liftBelow,
  'adv-retract-lift-enforce': liftEnforce,
  'adv-retract-lift-toolchange': liftToolchange,
  'adv-seam-slope-type': scarfType,
  'adv-seam-slope-min-length': scarfLength,
  'adv-seam-slope-steps': scarfSteps,
  'adv-seam-slope-start-height': scarfStart,
  'adv-seam-slope-entire-loop': scarfEntire,
  'adv-scarf-joint-flow-ratio': scarfFlow,
  'adv-scarf-angle-threshold': scarfThreshold,
  'adv-seam-position': seamPosition,
}
