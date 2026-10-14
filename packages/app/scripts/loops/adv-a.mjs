// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Advanced settings, first half (acceleration to precise Z height). Settings change by themselves, so no pointer;
// the bad result is red at one end and a time bar shows where a value costs print time. Shared drawings are exported
// as functions that take an id and the part to pick out, for the second half to import.
import { box, cyl, hud, iso, kf, morph, r1, rowFrames, run, S } from './stage.mjs'
import { A1, CUT, draw, join, rel, st, steps, T3, timebar, vis } from './kit.mjs'

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


// ---------- shared pieces for the second set ----------
/** Two still states, A then B, stepped with the readout. */
const twoCss = (id, t = TWO) => [steps(id), vis(`${id}-a`, 0, t[1], t[2]), vis(`${id}-b`, t[1], t[2])].join('')
const stateG = (id, k, inner) => `<g class="${id}-${k} ${id}-s s-a">${inner}</g>`
const poly = (cls, ps, extra = '') => `<polygon class="${cls}" points="${ps.map((q) => iso(...q).join(',')).join(' ')}"${extra}/>`

// ---------- bridge sag: strands between two posts sag into the air, then pull tight ----------
export function bridgeSagLoop(id = 'abg', about = 'Bridge: strands across a gap sag into the air, then print tight and flat with the right density, speed and flow.') {
  const Z = 9, ys = [2.5, 5, 7.5, 10]
  const strands = (sag) => ys.map((y) => {
    const [a, m, b] = [iso(7, y, Z), iso(15, y, Z - sag), iso(23, y, Z)]
    return `M${join(a)}Q${join(m)} ${join(b)}`
  }).join('')
  const body = `${box([0, 0, 0], [7, 13, Z])}${stateG(id, 'a', bead('', strands(5), CUT, 2))}${stateG(id, 'b', bead('', strands(0), A1, 2.2))}${box([23, 0, 0], [30, 13, Z])}`
  return { id, about, css: twoCss(id), body }
}

// ---------- hatch angle: a top surface's lines turning to the set angle (bridge angle, infill direction) ----------
function hatch(x0, y0, x1, y1, z, deg, sp) {
  // lines at `deg` from the x axis, clipped to the rectangle, as one relative path
  const t = (deg * Math.PI) / 180, [c, s] = [Math.cos(t), Math.sin(t)], n = [-s, c]
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, R = Math.hypot(x1 - x0, y1 - y0) / 2
  let d = ''
  for (let k = -R; k <= R; k += sp) {
    const px = cx + n[0] * k, py = cy + n[1] * k
    // clip the line p + u*(c, s) to the box
    let lo = -1e9, hi = 1e9
    for (const [p, dd, a, b] of [[px, c, x0, x1], [py, s, y0, y1]]) {
      if (Math.abs(dd) < 1e-9) { if (p < a || p > b) { lo = 1; hi = 0 } continue }
      const [u1, u2] = [(a - p) / dd, (b - p) / dd]
      lo = Math.max(lo, Math.min(u1, u2)); hi = Math.min(hi, Math.max(u1, u2))
    }
    if (hi - lo > 0.5) d += rel([[px + c * lo, py + s * lo, z], [px + c * hi, py + s * hi, z]], false)
  }
  return d
}
/** gap: the lines span only an opening in the slab (bridge angle) instead of the whole top (infill direction). */
export function hatchAngleLoop(id, rows, degs, about, sp = 2.2, gap = false) {
  const X = 26, Y = 16, Z = 2.5, T = [0, 1.1, 2.2, 3.3]
  const [g0, g1, h0, h1] = gap ? [8, 18, 4, 12] : [1.5, X - 1.5, 1.5, Y - 1.5]
  const css = [steps(id), `.sxs .${id}-h{animation-name:${id}-h}` + rowFrames(`${id}-h`, [[0, 0], [T[1], 1], [T[2], 2], [T[3], 0]]), ...degs.map((_, i) => vis(`${id}-${i}`, T[i], T[i + 1], i ? undefined : T[3]))].join('')
  const [hx, hy] = iso(X, 0, Z)
  const hole = gap ? poly('s-hole', [[g0, h0, Z], [g1, h0, Z], [g1, h1, Z], [g0, h1, Z]]) : ''
  const body = `${box([0, 0, 0], [X, Y, Z])}${hole}${degs.map((d, i) => `<path class="${id}-${i} ${id}-s s-a s-n"${st(i ? A1 : T3, gap ? 1.8 : 1.4)} d="${hatch(g0, h0, g1, h1, Z, d, sp)}"/>`).join('')}${hud(id, r1(hx + 16), r1(hy + 8), { w: 48 }, `${id}-h ${id}-s`, '')}`
  return { id, about, css, body, readout: { rows, w: 48 } }
}

// ---------- draft shield: air blowing past a part chills its side, then a thin wall around it takes the draft ----------
export function draftShieldLoop(id = 'ads', about = 'Draft shield: a draft chills the side of a part; a thin wall printed around it keeps the air off.') {
  // the air comes from the front left (+y) at the part's visible side
  const flow = (stop) => [8, 13, 18].map((x) => [3, 7].map((z) => rel([[x, 26, z], [x, stop, z]], false)).join('')).join('')
  const css = [twoCss(id), `.sxs .${id}-w{animation:${id}-w .6s linear infinite}@keyframes ${id}-w{from{stroke-dashoffset:12}to{stroke-dashoffset:0}}`].join('')
  const air = (stop) => `<path class="${id}-w s-n" style="stroke:var(--cyan,#8be9fd);stroke-width:2;stroke-dasharray:6 6" d="${flow(stop)}"/>`
  const shield = poly('s-af', [[3, 17.5, 0], [23, 17.5, 0], [23, 17.5, 11], [3, 17.5, 11]], ` style="stroke:var(${A1});stroke-width:1.6"`)
  const cold = poly('s-cf', [[6, 14, 0], [20, 14, 0], [20, 14, 10], [6, 14, 10]], ` style="stroke:var(${CUT});stroke-width:1.6"`)
  const body = `${box([6, 4, 0], [20, 14, 10])}${stateG(id, 'a', cold + air(14))}${stateG(id, 'b', shield + air(17.5))}`
  return { id, about, css, body }
}

// ---------- elephant foot: the first layers flare out, then are pulled in so the wall stays true ----------
export function elephantFootLoop(id = 'aef', about = 'Elephant foot compensation: the first layers squash out into a lip; pulled in, the wall stays straight.') {
  const X = 20, Y = 13, Z = 12, F = 1.2, L = 2
  const foot = (o, cls) => box([-o, -o, 0], [X + o, Y + o, L], cls)
  const css = [twoCss(id), rows2(id)].join('')
  const [hx, hy] = iso(X, 0, Z / 2)
  const body = `${stateG(id, 'a', foot(F, { l: 's-cf', r: 's-cf', t: 's-f1', ol: 's-cl' }))}${stateG(id, 'b', foot(0, { l: 's-g2', r: 's-g3', t: 's-g1', ol: 's-aol' }))}${box([0, 0, L], [X, Y, Z])}${hud(id, r1(hx + 16), r1(hy), { w: 70 }, `${id}-h ${id}-s`, '')}`
  return { id, about, css, body, readout: { rows: ['0.00 mm', '0.15 mm'], w: 70 } }
}

// ---------- internal bridge: the first solid layer over sparse infill sags into the gaps, then spans them flat ----------
export function internalBridgeLoop(id = 'aib', about = 'Internal bridge: the first solid layer over sparse infill droops into the gaps; a thick bridge layer spans them flat.') {
  const X = 26, Y = 10, Z = 10, top = 7.5, posts = [3, 9, 15, 21]
  const [ox, oy] = iso(0, Y, 0)
  const m = `matrix(${r1(C30 * S * 100) / 100} ${r1(0.5 * S * 100) / 100} 0 ${-S} ${ox} ${oy})`
  const sk = (sag) => {
    let d = `M0 ${top}`
    for (let i = 0; i < posts.length; i++) {
      const a = posts[i], b = posts[i + 1] ?? X
      d += `L${a + 1} ${top}` + (i < posts.length ? `Q${(a + 1 + b) / 2} ${top - sag} ${b} ${top}` : '')
    }
    return d + `L${X} ${top}`
  }
  const css = twoCss(id)
  const inner = posts.map((x) => `<rect class="s-f2" x="${x}" y="1" width="1" height="${top - 1}"/>`).join('') + stateG(id, 'a', `<path class="s-n"${st(CUT, 1.6)} d="${sk(2.6)}"/>`) + stateG(id, 'b', `<path class="s-n"${st(A1, 2.2)} d="${sk(0)}"/>`)
  const body = `${box([0, 0, 0], [X, Y, Z], { l: 's-f3' })}<g transform="${m}" style="vector-effect:non-scaling-stroke">${inner}</g>`
  return { id, about, css, body }
}

// ---------- ironing: the nozzle passes over a ridged top, leaving it smooth behind; the print takes longer ----------
export function ironingLoop(id = 'air', about = 'Ironing: the hot nozzle passes over the top surface with a little flow and leaves it smooth; the print takes longer.') {
  const X = 26, Y = 14, Z = 4, run0 = [0.3, 3.0]
  const ridges = Array.from({ length: 7 }, (_, k) => rel([[1, 1 + k * 2, Z], [X - 1, 1 + k * 2, Z]], false)).join('')
  const [a, b] = [iso(0, 0, Z), iso(X, 0, Z)]
  const sweep = `translate:${r1(b[0] - a[0])}px ${r1(b[1] - a[1])}px`
  const css = run(`${id}-n`) + kf(`${id}-n`, [[run0[0], 'translate:0 0'], [run0[1], sweep], [3.2, sweep], [3.45, 'translate:0 0']])
  const region = (x) => `M${join(iso(0, 0, Z))}L${join(iso(x, 0, Z))}L${join(iso(x, Y, Z))}L${join(iso(0, Y, Z))}Z`
  const tb = timebar(id, 0, 0, [[0, 0.5], [run0[0], 0.5], [run0[1], 0.85], [3.2, 0.85], [3.45, 0.5]])
  const [nx, ny] = iso(0, Y / 2, Z)
  const [hx, hy] = iso(X, 0, Z)
  const body = `${box([0, 0, 0], [X, Y, Z])}<path class="s-n"${st(T3, 1.2)} d="${ridges}"/>${morph('s-g1', [[run0[0], region(0.01)], [run0[1], region(X)], [3.2, region(X)], [3.45, region(0.01)]], region(X), ' style="fill-opacity:.85"')}<g class="${id}-n s-a"><polygon class="s-g2 s-aol" points="${nx},${ny} ${r1(nx - 5)},${r1(ny - 11)} ${r1(nx + 5)},${r1(ny - 11)}"/></g>${tb.svg.replace('translate(0 0)', `translate(${r1(hx + 12)} ${r1(hy + 6)})`)}`
  return { id, about, css: css + tb.css, body }
}

// ---------- make printable: a ledge's flat underside hangs in the air, then is reshaped into a slope that prints ----------
export function makePrintableLoop(id = 'amp', about = 'Make overhangs printable: a flat underside that would hang in the air is reshaped into a slope that prints without support.') {
  const post = box([0, 2, 0], [7, 12, 14])
  const ledge = box([7, 2, 9], [20, 12, 14])
  const cone = poly('s-g2 s-aol', [[7, 12, 2], [20, 12, 9], [7, 12, 9]]) + poly('s-g3 s-aol', [[20, 2, 9], [20, 12, 9], [7, 12, 2], [7, 2, 2]])
  const air = `<path class="s-n"${st(CUT, 2)} d="${rel([[7, 12, 9], [20, 12, 9], [20, 2, 9]], false)}"/>`
  return { id, about, css: twoCss(id), body: `${post}${stateG(id, 'b', cone)}${ledge}${stateG(id, 'a', air)}` }
}

// ---------- minimum layer time: a small spire's tip melts when its layers come too fast, then stays crisp ----------
export function minLayerTimeLoop(id = 'aml', about = 'Minimum layer time: a small tip printed fast has no time to cool and slumps; slowed down, it stays crisp and takes longer.') {
  const cx = 12, cy = 8, H = 16
  const spire = (droop) => {
    const [b1, b2, t] = [iso(cx - 4, cy + 4, 0), iso(cx + 4, cy - 4, 0), iso(cx + droop, cy, H - droop * 1.4)]
    return `M${join(b1)}L${join(t)}L${join(b2)}Z`
  }
  const css = [twoCss(id), rows2(id)].join('')
  const tb = timebar(id, 0, 0, timeTwo(0.35, 0.75))
  const [hx, hy] = iso(cx + 8, cy - 8, 6)
  const body = `${cyl(cx, cy, 0, 1.5, 6)}${stateG(id, 'a', `<path class="s-cf" style="stroke:var(${CUT});stroke-width:1.4" d="${spire(3)}"/>`)}${stateG(id, 'b', `<path class="s-g1 s-aol" d="${spire(0)}"/>`)}${hud(id, r1(hx + 14), r1(hy), { w: 52 }, `${id}-h ${id}-s`, '')}${tb.svg.replace('translate(0 0)', `translate(${r1(hx + 14)} ${r1(hy + 18)})`)}`
  return { id, about, css: css + tb.css, body, readout: { rows: ['1 s', '5 s'], w: 52 } }
}

// ---------- nozzle temperature: a line printed too cold (gaps), right, and too hot (strings and sag) ----------
export function nozzleTempLoop(id = 'ant', about = 'Nozzle temperature: too cold and the line breaks into gaps; right, it is even; too hot and it strings and sags.') {
  const T = [0, 1.1, 2.2, 3.3], Z = 3
  const lines = [3, 8, 13].map((y) => rel([[2, y, Z], [24, y, Z]], false)).join('')
  const strings = [[6, 3, 8], [14, 8, 13], [19, 3, 8]].map(([x, y0, y1]) => `M${join(iso(x, y0, Z))}Q${join(iso(x + 1, (y0 + y1) / 2, Z + 3))} ${join(iso(x - 1, y1, Z))}`).join('')
  const css = [steps(id), `.sxs .${id}-h{animation-name:${id}-h}` + rowFrames(`${id}-h`, [[0, 0], [T[1], 1], [T[2], 2], [T[3], 0]]), vis(`${id}-0`, 0, T[1], T[3]), vis(`${id}-1`, T[1], T[2]), vis(`${id}-2`, T[2], T[3])].join('')
  const [hx, hy] = iso(26, 0, Z)
  const body = `${box([0, 0, 0], [26, 16, Z])}${stateG(id, 0, `<path class="s-n" style="stroke:var(${CUT});stroke-width:2.6;stroke-dasharray:3 2.5" d="${lines}"/>`)}${stateG(id, 1, bead('', lines))}${stateG(id, 2, bead('', lines, CUT, 3.4) + `<path class="s-n"${st(CUT, 0.9)} d="${strings}"/>`)}${hud(id, r1(hx + 16), r1(hy + 8), { w: 56 }, `${id}-h ${id}-s`, '')}`
  return { id, about, css, body, readout: { rows: ['190 °C', '215 °C', '240 °C'], w: 56 } }
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
  'adv-bridge-sag': () => bridgeSagLoop(),
  'adv-bridge-angle': () => hatchAngleLoop('aba', ['0°', '45°', '90°'], [0, 45, 90], 'Bridge angle: the bridge lines across an opening turned to the angle you set.', 1.6, true),
  'adv-infill-direction': () => hatchAngleLoop('aid', ['0°', '45°', '90°'], [0, 45, 90], 'Infill direction: the sparse infill lines turned to the angle you set.', 3.4),
  'adv-draft-shield': () => draftShieldLoop(),
  'adv-elephant-foot': () => elephantFootLoop(),
  'adv-internal-bridge': () => internalBridgeLoop(),
  'adv-ironing': () => ironingLoop(),
  'adv-make-printable': () => makePrintableLoop(),
  'adv-min-layer-time': () => minLayerTimeLoop(),
  'adv-nozzle-temperature': () => nozzleTempLoop(),
}
