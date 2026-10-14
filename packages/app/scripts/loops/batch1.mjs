// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Batch 1 tooltip loops: the Simple slice settings, as five shared drawings (layer height, strength, speed, supports,
// brim). Sibling tips reuse their drawing and pick out their own value. Same stage, look and 3.5 s cycle as loops.mjs;
// numbers only in the readout, cost shown on a time bar.
import { box, disc, hud, iso, kf, morph, pointer, r1, rowFrames, run, tr } from './stage.mjs'
import { A1, CUT, draw, fade, join, op, rel, rows3, st, steps, T2, T3, T3S, timebar, vis } from './kit.mjs'

// ---------- layer height (detail, layer_height): a rounded edge in coarse layers, then fine ones ----------
// the outer stair of a quarter round: layer k reaches out to where the curve still stands that high
function stairs(X, Y, H, n, cls) {
  const h = H / n, xs = Array.from({ length: n + 1 }, (_, k) => X * Math.sqrt(Math.max(0, 1 - ((k * h) / H) ** 2)))
  const front = [[0, Y, 0], [X, Y, 0]]
  for (let k = 0; k < n; k++) front.push([xs[k], Y, (k + 1) * h], [xs[k + 1], Y, (k + 1) * h])
  front.push([0, Y, H])
  let ris = '', tre = ''
  for (let k = 0; k < n; k++) {
    ris += rel([[xs[k], Y, k * h], [xs[k], 0, k * h], [xs[k], 0, (k + 1) * h], [xs[k], Y, (k + 1) * h]])
    tre += rel([[xs[k + 1], 0, (k + 1) * h], [xs[k], 0, (k + 1) * h], [xs[k], Y, (k + 1) * h], [xs[k + 1], Y, (k + 1) * h]])
  }
  return `<g class="${cls} s-a"><path class="s-f2 s-ol" d="${rel(front)}"/><path class="s-f3 s-ol" d="${ris}"/><path class="s-f1 s-ol" d="${tre}"/></g>`
}
export function layerHeight() {
  const X = 24, Y = 12, H = 13, T = [0, 1.5, 3.3]
  const tb = timebar('lh', 0, 0, [[0, 0.3], [T[1] - 0.05, 0.3], [T[1] + 0.35, 1], [T[2] - 0.05, 1], [T[2] + 0.15, 0.3]])
  const css = [steps('lh'), vis('lh-a', 0, T[1], T[2]), vis('lh-b', T[1], T[2]), '.sxs .lh-h{animation-name:lh-h}', rowFrames('lh-h', [[0, 0], [T[1], 1], [T[2], 0]]), tb.css].join('')
  const [hx, hy] = iso(X, Y, 3)
  const x = r1(hx + 24), y = r1(hy - 8)
  const body = `${stairs(X, Y, H, 4, 'lh-a lh-s')}${stairs(X, Y, H, 14, 'lh-b lh-s')}${hud('lh', x, y, { w: 70 }, 'lh-h lh-s', '')}${tb.svg.replace('translate(0 0)', `translate(${x} ${r1(y + 18)})`)}`
  return { id: 'lh', about: 'Layer height: a rounded edge in 0.28 mm layers, then 0.08 mm ones that follow the curve; the print time grows.', css, body, readout: { rows: ['0.28 mm', '0.08 mm'], w: 70 } }
}

// ---------- strength (strength, sparse_infill_density, wall_loops): a slab's top layer as toolpaths ----------
const ZS = 2.5, SX = 28, SY = 18
const ring = (i) => rel([[i, i, ZS], [SX - i, i, ZS], [SX - i, SY - i, ZS], [i, SY - i, ZS]])
function grid(inset, sp) {
  const [x0, y0, x1, y1] = [inset, inset, SX - inset, SY - inset]
  let d = ''
  for (let x = x0 + sp / 2; x < x1; x += sp) d += rel([[x, y0, ZS], [x, y1, ZS]], false)
  for (let y = y0 + sp / 2; y < y1; y += sp) d += rel([[x0, y, ZS], [x1, y, ZS]], false)
  return d
}
const wallPath = (cls, d, accent) => `<path class="${cls}${cls ? ' s-a ' : ''}s-n"${accent ? ' pathLength="100"' : ''} style="stroke:var(${accent ? A1 : T3});stroke-width:1.8${accent ? ';stroke-dasharray:100' : ''}" d="${d}"/>`
/** walls: wall count per state; sp: infill spacing per state (mm, smaller is denser); time: bar share per state. */
function strengthLoop(id, walls, sp, time, rows, about, snap = false) {
  const css = [steps(id), rows3(id)]
  let body = box([0, 0, 0], [SX, SY, ZS]) + wallPath('', ring(0.5) + ring(1.5), false)
  for (let s = 1; s < 3; s++) {
    if (walls[s] === walls[s - 1]) continue
    let d = ''
    for (let i = walls[s - 1]; i < walls[s]; i++) d += ring(0.5 + i)
    // snap: the new walls step in with the infill (keeps the loop in budget); otherwise they draw in
    css.push(snap ? vis(`${id}-w${s}`, T3S[s], T3S[3]) : draw(`${id}-w${s}`, T3S[s], T3S[s] + 0.45, T3S[3] - 0.2))
    body += snap ? `<path class="${id}-w${s} ${id}-s s-a s-n"${st(A1, 1.8)} d="${d}"/>` : wallPath(`${id}-w${s}`, d, true)
  }
  const fixed = sp.every((v) => v === sp[0])
  sp.forEach((v, s) => {
    if (fixed && s) return
    if (!fixed) css.push(vis(`${id}-g${s}`, T3S[s], T3S[s + 1], s ? undefined : T3S[3]))
    body += `<path class="${fixed ? '' : `${id}-g${s} ${id}-s s-a `}s-n"${st(s && !fixed ? A1 : T2, 1)} d="${grid(walls[s] + 0.3, v)}"/>`
  })
  const tb = timebar(id, 0, 0, [[0, time[0]], [T3S[1] - 0.05, time[0]], [T3S[1] + 0.3, time[1]], [T3S[2] - 0.05, time[1]], [T3S[2] + 0.3, time[2]], [T3S[3] - 0.05, time[2]], [T3S[3] + 0.15, time[0]]])
  css.push(tb.css)
  const [hx, hy] = iso(SX, 0, ZS)
  const x = r1(hx + 18), y = r1(hy + 6)
  body += hud(id, x, y, { w: 64 }, `${id}-h ${id}-s`, '') + tb.svg.replace('translate(0 0)', `translate(${x} ${r1(y + 18)})`)
  return { id, about, css: css.join(''), body, readout: { rows, w: 64 } }
}
export const strength = () => strengthLoop('st', [2, 4, 6], [8, 4, 3.4], [0.3, 0.6, 1], ['2 walls', '4 walls', '6 walls'], 'Strength: a slab\'s top layer; walls go 2 to 4 to 6 and the infill fills in, so the print takes longer.', true)
export const infill = () => strengthLoop('in', [2, 2, 2], [8, 4, 2], [0.3, 0.5, 0.9], ['10 %', '20 %', '40 %'], 'Infill density: the same slab, its infill grid going from 10 to 20 to 40 percent; the print takes longer.')
export const wallLoops = () => strengthLoop('wl', [2, 3, 4], [8, 8, 8], [0.3, 0.45, 0.6], ['2 walls', '3 walls', '4 walls'], 'Wall loops: the same slab, walls going from 2 to 3 to 4; the print takes longer.')

// ---------- speed (speed and its four choices): four nozzles lay the same line at the four speeds ----------
const FACT = [0.5, 1, 1.24, 1.66]
function speedLoop(id, hi, about) {
  const L0 = 1, L1 = 27, ys = [-2, 3, 8, 13], t0 = 0.3, base = 1.4, z = 0.4
  let css = '', body = ''
  ys.forEach((y, i) => {
    const t1 = t0 + base / FACT[i], on = hi === undefined || hi === i
    css += draw(`${id}-b${i}`, t0, t1) + run(`${id}-n${i}`) + kf(`${id}-n${i}`, [[0, `translate:0 0;${op(0)}`], [0.15, `translate:0 0;${op(1)}`], [t0, 'translate:0 0'], [t1, `translate:${tr(L1 - L0, 0, 0)}`], [3.2, `translate:${tr(L1 - L0, 0, 0)};${op(1)}`], [3.4, `translate:0 0;${op(0)}`]])
    const nz = `<polygon class="${on ? 's-g2 s-aol' : 's-f2 s-ol'}" points="${[[L0, y, z], [L0 - 1.3, y + 1.3, 4], [L0 + 1.3, y - 1.3, 4]].map((p) => iso(...p).join(',')).join(' ')}"/>`
    // the fastest line rings: its bead wobbles at the start of the run and the corner it leaves
    const pts = i === 3 ? [[L0, y, z], ...Array.from({ length: 7 }, (_, k) => [L0 + 1.4 + k * 1.4, y + (k % 2 ? 0.7 : -0.7) * (1 - k / 7), z]), [L1, y, z]] : [[L0, y, z], [L1, y, z]]
    body += `<path class="${id}-b${i} s-a s-n" pathLength="100" style="stroke:var(${on ? A1 : T3});stroke-width:3.2;stroke-dasharray:100" d="${rel(pts, false)}"/><g class="${id}-n${i} s-a">${nz}</g>`
  })
  return { id, about, css, body }
}
export const speed = () => speedLoop('sp', undefined, 'Speed: four nozzles lay the same line at 50, 100, 124 and 166 percent of the preset speeds; the fastest line rings.')
export const speedQuality = () => speedLoop('sq', 0, 'Speed, Quality: the slowest of the four lines picked out.')
export const speedBalanced = () => speedLoop('sd', 1, 'Speed, Balanced: the preset speed picked out of the four.')
export const speedFast = () => speedLoop('sf', 2, 'Speed, Fast: the 124 percent line picked out of the four.')
export const speedFastest = () => speedLoop('sx', 3, 'Speed, Fastest: the 166 percent line picked out of the four; it rings.')

// ---------- supports (supports, its three choices, enable_support): a ledge sticking out from a post ----------
const POST = [[0, 4, 0], [7, 12, 16]], LEDGE = [[7, 4, 12], [24, 12, 16]], UZ = 12
const part = (under = '', over = '') => `${box(...POST)}${under}${box(...LEDGE)}${over}`
// strands of the ledge's first layer: flat under it, then sagging into the air
const strand = (y, sag) => {
  const [a, m, b] = [iso(8, y, UZ), iso(16, y, UZ - sag), iso(24, y, UZ)]
  return `M${join(a)}Q${join(m)} ${join(b)}`
}
function sagging(cls, a, b) {
  const f = (s) => [8.5, 10.2, 11.9].map((y) => strand(y, s)).join('')
  return `<g class="${cls} s-a">${morph('s-n', [[a, f(0)], [b, f(6)]], f(6), st(CUT, 2))}</g>`
}
/** A tree from the plate at x0 to the ledge's underside at each tip x, drawn in over [a, b] and gone at `out`. */
function tree(cls, x0, tips, a, b, out) {
  const y = 10, fork = [x0, y, 5]
  let d = rel([[x0, y, 0], fork], false)
  for (const t of tips) d += `M${join(iso(...fork))}Q${join(iso((x0 + t) / 2, y, 8.5))} ${join(iso(t, y, UZ))}`
  return { css: draw(cls, a, b, out), svg: `<path class="${cls} s-a s-n" pathLength="100"${st('--stage-a2,#a57ae8', 3.2).replace('"', '"stroke-dasharray:100;')} d="${d}"/>` }
}
// the brush along the ledge's lower front edge over its outer half, with the pointer that paints it
function painted(id, a, b, out) {
  const [p0, p1] = [iso(15, 12, 12.8), iso(23, 12, 12.8)]
  const d = `${r1(p1[0] - p0[0])}px ${r1(p1[1] - p0[1])}px`
  const css = draw(`${id}-p`, a, b, out) + run(`${id}-m`) + kf(`${id}-m`, [[a - 0.25, `translate:0 0;${op(0)}`], [a, `translate:0 0;${op(1)}`], [b, `translate:${d};${op(1)}`], [b + 0.1, `translate:${d};${op(1)}`], [b + 0.3, `translate:${d};${op(0)}`]])
  const svg = `<path class="${id}-p s-a s-n" pathLength="100" style="stroke:var(--stage-a2,#a57ae8);stroke-width:4.5;stroke-dasharray:100" d="M${join(p0)}L${join(p1)}"/><g class="${id}-m s-a">${pointer(r1(p0[0] + 2), r1(p0[1] + 2), a - 0.5)}</g>`
  return { css, svg }
}
const FULL = [10.5, 16, 21.5]
export function supportsOff() {
  return { id: 'so', about: 'Supports, Off: the ledge\'s first layer prints into the air and sags.', css: fade('so-s', 0.4, 3.2), body: part(sagging('so-s', 0.5, 1.6)) }
}
export function supportsAuto() {
  const t = tree('sa-t', 16, FULL, 0.4, 1.4)
  return { id: 'sa', about: 'Supports, Auto: a tree grows from the plate to hold the whole ledge.', css: t.css, body: part(t.svg) }
}
export function supportsPainted() {
  const p = painted('sn', 0.5, 1.4), t = tree('sn-t', 19, [16, 22], 1.6, 2.4)
  return { id: 'sn', about: 'Supports, Painted: support painted on the outer half of the ledge, and a tree grows only there.', css: p.css + t.css, body: part(t.svg, p.svg) }
}
export function supports() {
  // the three choices in turn: off sags, auto holds the whole ledge, painted holds only the painted half
  const a = tree('su-a', 16, FULL, 1.2, 1.7, 2.1), p = painted('su', 2.35, 2.75), b = tree('su-b', 19, [16, 22], 2.8, 3.1)
  const css = fade('su-s', 0.3, 1.05, 0.15) + a.css + p.css + b.css
  return { id: 'su', about: 'Supports: off, the ledge sags; auto, a tree holds all of it; painted, a tree holds only the painted half.', css, body: part(sagging('su-s', 0.3, 0.9) + a.svg + b.svg, p.svg) }
}
export function enableSupport() {
  const t = tree('es-t', 16, FULL, 1.45, 2.3)
  return { id: 'es', about: 'Enable support: the ledge sags into the air, then a tree grows under it and holds it flat.', css: fade('es-s', 0.4, 1.4) + t.css, body: part(sagging('es-s', 0.4, 1.2) + t.svg) }
}

// ---------- brim (brim, brim_type): a block on the plate, its corner lifting without one ----------
const FOOT = [[4, 3, 0], [20, 13, 9]]
const brimRing = (o) => rel([[4 - o, 3 - o, 0], [20 + o, 3 - o, 0], [20 + o, 13 + o, 0], [4 - o, 13 + o, 0]])
/** The block with its front corner curled up `L` mm off the plate: that corner's edge rises, the far ones stay. */
const lifted = (L) => ({
  l: rel([[4, 13, 0], [20, 13, L], [20, 13, 9 + L], [4, 13, 9]]),
  r: rel([[20, 3, 0], [20, 13, L], [20, 13, 9 + L], [20, 3, 9]]),
  t: rel([[4, 3, 9], [20, 3, 9], [20, 13, 9 + L], [4, 13, 9]]),
})
export function brim() {
  // off: the corner lifts off the plate; on: the rings go down first and the block stays flat
  const up = [0.3, 1.1], down = [1.3, 1.45]
  const fr = (k) => [[up[0], lifted(0)[k]], [up[1], lifted(2.6)[k]], [down[0], lifted(2.6)[k]], [down[1], lifted(0)[k]]]
  // one keyframe for the rings, each starting 0.12 s after the one inside it
  let css = fade('br-g', 0.45, 1.3, 0.15) + draw('br-r', 1.5, 1.9, 2.8), rings = ''
  for (let i = 0; i < 5; i++) rings += `<path class="br-r s-a s-n" pathLength="100" style="stroke:var(${A1});stroke-width:1.6;stroke-dasharray:100${i ? `;animation-delay:${r1(i * 0.12 * 100) / 100}s` : ''}" d="${brimRing(0.8 + i)}"/>`
  const ghost = `<path class="br-g s-a s-ghost" d="${rel([[4, 13, 0], [20, 13, 0], [20, 3, 0]], false)}"/>`
  const body = `${rings}${ghost}${morph('s-f2 s-ol', fr('l'), lifted(0).l)}${morph('s-f3 s-ol', fr('r'), lifted(0).r)}${morph('s-f1 s-ol', fr('t'), lifted(0).t)}`
  return { id: 'br', about: 'Brim: without one the block\'s corner lifts off the plate; with one, five rings go down first and it stays flat.', css, body }
}
export function brimType() {
  const css = [fade('bt-r', 0.35, 1.55), run('bt-e'), kf('bt-e', [[1.7, `${op(0)};scale:.3`], [2.0, `${op(1)};scale:1`], [3.2, op(1)], [3.4, op(0)]]), '.sxs .bt-e{transform-box:fill-box;transform-origin:center}'].join('')
  let rings = ''
  for (let i = 0; i < 5; i++) rings += brimRing(0.8 + i)
  const ears = [[4, 3], [20, 3], [20, 13], [4, 13]].map(([x, y]) => {
    const d = disc(x, y, 0, 3.5)
    return `<ellipse class="bt-e s-a s-af" cx="${d.cx}" cy="${d.cy}" rx="${d.rx}" ry="${d.ry}"${st(A1, 1.6)}/>`
  }).join('')
  return { id: 'bt', about: 'Brim type: the same block, an all-around brim, then mouse ears: small discs under the corners only.', css, body: `<path class="bt-r s-a s-n"${st(A1, 1.6)} d="${rings}"/>${ears}${box(...FOOT)}` }
}

/** Batch 1, by the file name the export uses, grouped by shared drawing. */
export const LOOPS = {
  'layer-height': layerHeight,
  strength, 'infill-density': infill, 'wall-loops': wallLoops,
  speed, 'speed-quality': speedQuality, 'speed-balanced': speedBalanced, 'speed-fast': speedFast, 'speed-fastest': speedFastest,
  supports, 'supports-off': supportsOff, 'supports-auto': supportsAuto, 'supports-painted': supportsPainted, 'enable-support': enableSupport,
  brim, 'brim-type': brimType,
}
