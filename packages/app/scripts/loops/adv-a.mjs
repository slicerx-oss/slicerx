// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Advanced settings, first half (acceleration to precise Z height). Settings change by themselves, so no pointer;
// the bad result is red at one end and a time bar shows where a value costs print time. Shared drawings are exported
// as functions that take an id and the part to pick out, for the second half to import.
import { box, cyl, hud, iso, kf, r1, rowFrames, run, S } from './stage.mjs'
import { A1, CUT, draw, rel, st, steps, T3, timebar, vis } from './kit.mjs'

const EASE = 'animation-timing-function:cubic-bezier(.65,0,.35,1)'
const C30 = Math.cos(Math.PI / 6)
/** Two states: A over [0, t), B over [t, 3.3), back to A. */
const TWO = [0, 1.6, 3.3]
const rows2 = (id, t = TWO) => `.sxs .${id}-h{animation-name:${id}-h}` + rowFrames(`${id}-h`, [[0, 0], [t[1], 1], [t[2], 0]])
/** The readout and time bar stacked at (x, y). */
function readout(id, x, y, w, time) {
  const tb = time && timebar(id, 0, 0, time)
  return { css: tb ? tb.css : '', svg: hud(id, x, y, { w }, `${id}-h ${id}-s`, '') + (tb ? tb.svg.replace('translate(0 0)', `translate(${x} ${r1(y + 18)})`) : '') }
}
const timeTwo = (a, b, t = TWO) => [[0, a], [t[1] - 0.05, a], [t[1] + 0.3, b], [t[2] - 0.05, b], [t[2] + 0.15, a]]
const bead = (cls, d, c = A1, w = 2.6, extra = '') => `<path class="${cls}${cls ? ' s-a ' : ''}s-n" style="stroke:var(${c});stroke-width:${w}${extra}" d="${d}"/>`

// ---------- acceleration: a serpentine path, ringing after each corner; less acceleration, less ringing, more time ----------
export function accelerationLoop(id = 'aac', about = 'Acceleration: a printed path that rings after each corner; lower acceleration rings less and takes longer.') {
  const rowsY = [1, 7, 13], X0 = 2, X1 = 24, RIP = 6
  // straight runs with the first RIP mm after each corner left out; the ripple path fills those gaps
  const runs = [], zones = []
  rowsY.forEach((y, i) => {
    const fwd = i % 2 === 0, a = fwd ? X0 : X1, dir = fwd ? 1 : -1
    zones.push({ y, a, dir })
    runs.push([[a + dir * RIP, y, 0], [fwd ? X1 : X0, y, 0], ...(i < 2 ? [[fwd ? X1 : X0, rowsY[i + 1], 0]] : [])])
  })
  const ripple = (amp) => zones.map(({ y, a, dir }) => rel(Array.from({ length: 13 }, (_, k) => {
    const u = k / 12
    return [a + dir * u * RIP, y + amp * Math.sin(u * Math.PI * 5) * (1 - u), 0]
  }), false)).join('')
  const css = [steps(id), rows2(id), vis(`${id}-a`, 0, TWO[1], TWO[2]), vis(`${id}-b`, TWO[1], TWO[2])]
  const [hx, hy] = iso(X1, 0, 0)
  const ro = readout(id, r1(hx + 10), r1(hy + 6), 96, timeTwo(0.45, 0.8))
  css.push(ro.css)
  const body = `${box([0, -1, -1.2], [26, 15, 0])}${bead('', runs.map((r) => rel(r, false)).join(''))}<g class="${id}-a ${id}-s s-a">${bead('', ripple(1.4), CUT)}</g><g class="${id}-b ${id}-s s-a">${bead('', ripple(0.25))}</g>${ro.svg}`
  return { id, about, css: css.join(''), body, readout: { rows: ['10000 mm/s²', '2000 mm/s²'], w: 96 } }
}

// ---------- jerk: one corner taken with a hard speed jump (it shakes) and then with a soft one ----------
export function jerkLoop(id = 'ajk', about = 'Jerk: a corner taken with a hard speed jump shakes; a soft one is clean and takes a little longer.') {
  const A = [2, 14, 0], B = [22, 14, 0], C = [22, 1, 0]
  const shake = Array.from({ length: 9 }, (_, k) => [22 + 0.9 * Math.sin(k * 2.4) * (1 - k / 9), 14 - k * 0.8, 0])
  const hard = rel([A, B, ...shake, C], false), soft = rel([A, [20, 14, 0], [22, 12, 0], C], false)
  const p = (q) => iso(...q), o = p(A)
  const to = (q) => `translate:${r1(p(q)[0] - o[0])}px ${r1(p(q)[1] - o[1])}px`
  const css = [steps(id), rows2(id), vis(`${id}-a`, 0, TWO[1]), vis(`${id}-b`, TWO[1], TWO[2]), draw(`${id}-d`, 0.2, 1.3, 1.45), draw(`${id}-e`, 1.75, 3.1),
    run(`${id}-n`) + kf(`${id}-n`, [[0.2, to(A)], [0.75, to(B)], [1.3, to(C)], [1.45, to(C)], [1.6, to(A)], [1.75, `${to(A)};${EASE}`], [2.5, `${to(B)};${EASE}`], [3.1, to(C)], [3.3, to(C)], [3.45, to(A)]])]
  const [hx, hy] = iso(22, 0, 0)
  const ro = readout(id, r1(hx + 12), r1(hy + 4), 70, timeTwo(0.45, 0.7))
  css.push(ro.css)
  const line = (cls, d, c) => `<path class="${cls} s-a s-n" pathLength="100" style="stroke:var(${c});stroke-width:2.6;stroke-dasharray:100" d="${d}"/>`
  const [nx, ny] = o
  const body = `${box([0, -1, -1.2], [24, 16, 0])}<g class="${id}-a ${id}-s s-a">${line(`${id}-d`, hard, CUT)}</g><g class="${id}-b ${id}-s s-a">${line(`${id}-e`, soft, A1)}</g><g class="${id}-n s-a"><polygon class="s-g2 s-aol" points="${nx},${ny} ${r1(nx - 5)},${r1(ny - 11)} ${r1(nx + 5)},${r1(ny - 11)}"/></g>${ro.svg}`
  return { id, about, css: css.join(''), body, readout: { rows: ['20 mm/s', '5 mm/s'], w: 70 } }
}

// ---------- flow ratio: a cut through a wall's lines, under, right and over; one role's lines picked out ----------
const ROLES = ['first', 'outer', 'inner', 'infill', 'top']
/** hi: the role whose lines change, or 'all'. */
export function flowRatioLoop(id = 'afr', hi = 'all', about = 'Flow ratio: a cut through the lines of a wall; too little flow leaves gaps, too much makes them bulge.') {
  const W = 3.2, H = 2, X = 26, Y = 10, Z = 8
  const beads = []
  for (let l = 0; l < 4; l++) {
    if (l === 0 || l === 3) for (let i = 0; i < 8; i++) beads.push([i * W + W / 2, l, l ? 'top' : 'first'])
    else beads.push([W / 2, l, 'outer'], [W * 1.5, l, 'inner'], [W * 4, l, 'infill'], [W * 6.5, l, 'infill'])
  }
  const T = [0, 1.1, 2.2, 3.3]
  const on = (r) => hi === 'all' || hi === r
  // the changing lines: under (shrunk, gaps), right, over (swollen, bulging), stepped with the readout
  const sc = (s) => `scale:${s}`
  const css = [steps(id), `.sxs .${id}-h{animation-name:${id}-h}` + rowFrames(`${id}-h`, [[0, 1], [0.3, 0], [T[1], 1], [T[2], 2], [T[3], 1]]),
    `.sxs .${id}-x ellipse,.sxs [transform] ellipse{stroke-width:1;vector-effect:non-scaling-stroke}.sxs .${id}-b{transform-box:fill-box;transform-origin:center;animation-name:${id}-b}` + kf(`${id}-b`, [[0, sc(1)], [0.25, sc(1)], [0.35, `${sc(0.72)};stroke:var(${CUT})`], [T[1] - 0.05, `${sc(0.72)};stroke:var(${CUT})`], [T[1] + 0.05, `${sc(1)};stroke:var(--stage-aol,#2c1d4a)`], [T[2] - 0.05, sc(1)], [T[2] + 0.05, `${sc(1.22)};stroke:var(${CUT})`], [T[3] - 0.05, `${sc(1.22)};stroke:var(${CUT})`], [T[3] + 0.05, `${sc(1)};stroke:var(--stage-aol,#2c1d4a)`]])].join('')
  const [ox, oy] = iso(0, Y, 0)
  const m = `matrix(${r1(C30 * S * 100) / 100} ${r1(0.5 * S * 100) / 100} 0 ${-S} ${ox} ${oy})`
  const el = ([u, l, r]) => `<ellipse class="${on(r) ? `${id}-b ${id}-s s-a s-g1` : 's-f1'}" cx="${r1(u)}" cy="${l * H + 1}" rx="1.6" ry="1"/>`
  const [hx, hy] = iso(X, 0, Z / 2)
  const body = `${box([0, 0, 0], [X, Y, Z], { l: 's-f3' })}<g transform="${m}" style="stroke:var(--stage-ol,#1a1b24)">${beads.map(el).join('')}</g>${hud(id, r1(hx + 14), r1(hy), { w: 52 }, `${id}-h ${id}-s`, '')}`
  return { id, about, css, body, readout: { rows: ['0.85', '1.00', '1.15'], w: 52 } }
}

// ---------- fuzzy skin: a round part's outer wall roughened; thickness or point spacing picked out ----------
function noise(i) {
  const s = Math.sin(i * 12.9898 + 78.233) * 43758.5453
  return (s - Math.floor(s)) * 2 - 1
}
/** mode: 'thickness' (smooth to rough) or 'distance' (coarse to fine roughness). */
export function fuzzySkinLoop(id = 'afz', mode = 'thickness', about = 'Fuzzy skin: a round part\'s outer wall jittered into a rough, grippy texture.') {
  const cx = 11, cy = 8, R = 9, Z = 12
  const ring = (z, amp, n) => rel(Array.from({ length: n + 1 }, (_, k) => {
    const a = (k / n) * Math.PI * 2, r = R + amp * noise(k % n + z)
    return [cx + r * Math.cos(a), cy + r * Math.sin(a), z]
  }))
  // a front arc of the wall at one layer, for the side's texture
  const arc = (z, amp, n) => rel(Array.from({ length: n / 2 + 1 }, (_, k) => {
    const a = Math.PI * 1.75 - (k / n) * Math.PI * 2, r = R + amp * noise(k + z * 3)
    return [cx + r * Math.cos(a), cy + r * Math.sin(a), z]
  }), false)
  const shape = (amp, n) => ring(Z, amp, n)
  const sides = (amp, n) => [4, 8].map((z) => arc(z, amp, n)).join('')
  const [A, B] = mode === 'thickness' ? [[0, 28], [0.8, 28]] : [[0.8, 16], [0.8, 32]]
  const css = [steps(id), rows2(id), vis(`${id}-a`, 0, TWO[1], TWO[2]), vis(`${id}-b`, TWO[1], TWO[2])].join('')
  const state = (cls, [amp, n]) => `<g class="${cls} ${id}-s s-a"><path class="s-f1 s-ol" d="${shape(amp, n)}"/><path class="s-n"${st(T3, 1.2)} d="${sides(amp, n)}"/></g>`
  const [hx, hy] = iso(cx + R, cy - R, Z / 2)
  const rows = mode === 'thickness' ? ['0.00 mm', '0.30 mm'] : ['0.8 mm', '0.3 mm']
  const body = `${cyl(cx, cy, 0, Z, R)}${state(`${id}-a`, A)}${state(`${id}-b`, B)}${hud(id, r1(hx + 16), r1(hy), { w: 70 }, `${id}-h ${id}-s`, '')}`
  return { id, about, css, body, readout: { rows, w: 70 } }
}

// ---------- avoid crossing: a travel cutting across a wall (and stringing), then detouring around it ----------
export function avoidCrossing() {
  const id = 'ava', Z = 2.5
  const a = [4, 4, Z], b = [22, 12, Z]
  const straight = rel([a, b], false), around = rel([a, [4, 15.5, Z], [22, 15.5, Z], b], false)
  const css = [steps(id), vis(`${id}-a`, 0, TWO[1]), vis(`${id}-b`, TWO[1], TWO[2]), draw(`${id}-d`, 0.2, 0.9, 1.45), draw(`${id}-e`, 1.8, 2.9, 3.1)].join('')
  const ro = timebar(id, 0, 0, timeTwo(0.35, 0.55))
  // the walls: two islands' outlines on the slab; the straight travel crosses the second island's wall
  const wall = (x0, y0, x1, y1) => rel([[x0, y0, Z], [x1, y0, Z], [x1, y1, Z], [x0, y1, Z]])
  const line = (cls, d, c, dash) => `<path class="${cls} s-a s-n" pathLength="100" style="stroke:var(${c});stroke-width:1.8;stroke-dasharray:${dash}" d="${d}"/>`
  const [bx, by] = iso(13, 8, Z)
  const [hx, hy] = iso(26, 0, Z)
  const body = `${box([0, 0, 0], [26, 17, Z])}<path class="s-n" style="stroke:var(${T3});stroke-width:2" d="${wall(1.5, 1.5, 7, 7)}${wall(10, 3, 17, 13)}${wall(19.5, 9.5, 24.5, 14.5)}"/>
<g class="${id}-a ${id}-s s-a">${line(`${id}-d`, straight, CUT, '3 2')}<path class="s-n" style="stroke:var(${CUT});stroke-width:1" d="M${bx} ${by}q2 5 0 9"/></g>
<g class="${id}-b ${id}-s s-a">${line(`${id}-e`, around, A1, '3 2')}</g>${ro.svg.replace('translate(0 0)', `translate(${r1(hx + 10)} ${r1(hy + 8)})`)}`
  return { id, about: 'Avoid crossing walls: a travel that cuts across a wall and strings, then one that detours around it at a little more time.', css: css + ro.css, body }
}

/** Advanced, first half, by the file name the export uses. */
export const LOOPS = {
  'adv-acceleration': () => accelerationLoop(),
  'adv-jerk': () => jerkLoop(),
  'adv-flow-ratio': () => flowRatioLoop(),
  'adv-flow-ratio-outer': () => flowRatioLoop('afo', 'outer', 'Flow ratio, outer wall: the same cut, only the outer wall lines change.'),
  'adv-flow-ratio-inner': () => flowRatioLoop('afi', 'inner', 'Flow ratio, inner wall: the same cut, only the inner wall lines change.'),
  'adv-flow-ratio-infill': () => flowRatioLoop('afn', 'infill', 'Flow ratio, sparse infill: the same cut, only the infill lines change.'),
  'adv-flow-ratio-top': () => flowRatioLoop('aft', 'top', 'Flow ratio, top surface: the same cut, only the top layer changes.'),
  'adv-flow-ratio-first': () => flowRatioLoop('afb', 'first', 'Flow ratio, first layer: the same cut, only the first layer changes.'),
  'adv-fuzzy-skin': () => fuzzySkinLoop(),
  'adv-fuzzy-skin-distance': () => fuzzySkinLoop('afd', 'distance', 'Fuzzy skin point distance: the same wall, its roughness going from coarse to fine.'),
  'adv-avoid-crossing': avoidCrossing,
}
