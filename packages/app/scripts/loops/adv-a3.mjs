// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Advanced settings, first half, last set: overhang handling, the part fan, ooze, painted color joins and Z height,
// plus the stills for structure and location (a part's roles, the prime tower's spot, path resolution, top density).
import { box, iso, kf, r1, rowFrames, run, S } from './stage.mjs'
import { A1, bead, CUT, pill, poly, rel, rows2, st, stateG, steps, T2, T3, twoCss, vis } from './kit.mjs'

const C30 = Math.cos(Math.PI / 6)
const CY = '--cyan,#8be9fd'
const face = (Y, inner, extra = '') => {
  const [ox, oy] = iso(0, Y, 0)
  return `<g transform="matrix(${r1(C30 * S * 100) / 100} ${r1(0.5 * S * 100) / 100} 0 ${-S} ${ox} ${oy})"${extra}>${inner}</g>`
}
const pillAt = (id, X, z, w, dx = 16) => {
  const [x, y] = iso(X, 0, z)
  return pill(id, x + dx, y + 6, w)
}
/** n states over the loop, back to the first: their times. */
const states = (n) => [...Array.from({ length: n }, (_, i) => r1((3.3 * i) / n)), 3.3]
const nCss = (id, n) => {
  const T = states(n)
  return [steps(id), `.sxs .${id}-h{animation-name:${id}-h}` + rowFrames(`${id}-h`, [...T.slice(0, n).map((t, i) => [t, i]), [3.3, 0]]), ...Array.from({ length: n }, (_, i) => vis(`${id}-${i}`, T[i], T[i + 1], i ? undefined : 3.3))].join('')
}
/** The part cooling fan, spinning once per `dur` seconds. */
function fan(id, cx, cy, r, dur) {
  const blade = (a) => {
    const t = (a * Math.PI) / 180
    return `M${cx} ${cy}Q${r1(cx + r * Math.cos(t - 0.6))} ${r1(cy + r * Math.sin(t - 0.6))} ${r1(cx + r * Math.cos(t))} ${r1(cy + r * Math.sin(t))}Z`
  }
  return { css: `@keyframes ${id}-spin{to{rotate:360deg}}`, svg: `<g style="transform-box:fill-box;transform-origin:center;animation:${id}-spin ${dur}s linear infinite"><circle cx="${cx}" cy="${cy}" r="${r + 2}" style="fill:var(--stage-pill,#16171e);stroke:var(--stage-ol,#1a1b24)"/><path class="s-g1" d="${[0, 120, 240].map(blade).join('')}"/></g>` }
}

// ---------- painted color interlocking: two painted colors meet at a flat seam, then comb into each other ----------
export function paintedInterlockLoop(id = 'apc', about = 'Painted color interlocking: on every other layer each painted color reaches into the other, so the colors hold together.') {
  const X = 26, Y = 10, Z = 10, mid = 13, d = 2
  // six layers; the colors are set once per group, so each row is two bare rects
  const rowsAt = (shift) => {
    let a = '', c = ''
    for (let k = 0; k < 6; k++) {
      const m = mid + (shift ? (k % 2 ? d : -d) : 0), y = r1(k * 1.6 + 0.1)
      a += `<rect x="1" y="${y}" width="${m - 1}" height="1.4"/>`
      c += `<rect x="${m}" y="${y}" width="${X - 1 - m}" height="1.4"/>`
    }
    return `<g style="fill:var(--stage-a2,#a57ae8)">${a}</g><g style="fill:var(${CY})">${c}</g>`
  }
  return { id, about, css: twoCss(id) + rows2(id), body: `${box([0, 0, 0], [X, Y, Z], { l: 's-f3' })}${face(Y, stateG(id, 'a', rowsAt(false)) + stateG(id, 'b', rowsAt(true)))}${pillAt(id, X, Z / 2, 52)}`, readout: { rows: ['0 mm', '2 mm'], w: 52 } }
}

// ---------- ooze prevention: the idle nozzle drips onto the part, then sits cooler and stays clean ----------
export function oozeLoop(id = 'aoz', about = 'Ooze prevention: the idle nozzle drops in temperature while the other prints, so it does not drip onto the part.') {
  const Z = 4
  const nozzle = (x, y, cls) => {
    const [nx, ny] = iso(x, y, Z + 2)
    return `<g class="${cls}"><polygon class="s-g2 s-aol" points="${nx},${ny} ${r1(nx - 5)},${r1(ny - 11)} ${r1(nx + 5)},${r1(ny - 11)}"/><rect class="s-g1 s-aol" x="${r1(nx - 8)}" y="${r1(ny - 21)}" width="16" height="10" rx="2"/></g>`
  }
  const [dx, dy] = iso(20, 8, Z + 2)
  const drip = `<path class="${id}-d s-a" style="fill:var(${CUT})" d="M${dx} ${dy}q-2.4 4.5 0 6.5q2.4-2 0-6.5Z"/><ellipse cx="${dx}" cy="${r1(iso(20, 8, Z)[1])}" rx="4" ry="1.6" style="fill:var(${CUT});fill-opacity:.55"/>`
  const css = twoCss(id) + rows2(id) + run(`${id}-d`) + kf(`${id}-d`, [[0, 'translate:0 0;opacity:1'], [1.2, `translate:0 ${r1(6)}px;opacity:1`], [1.5, `translate:0 ${r1(6)}px;opacity:0`]])
  const body = `${box([0, 0, 0], [26, 16, Z])}${nozzle(7, 8, '')}${nozzle(20, 8, '')}${stateG(id, 'a', drip)}${pillAt(id, 26, Z, 56)}`
  return { id, about, css, body, readout: { rows: ['0 °C', '−40 °C'], w: 56 } }
}

// ---------- overhang speed: a wall that steps further out slows down at each step ----------
export function overhangSpeedLoop(id = 'aos', about = 'Overhang speed: a wall slows down in steps as it hangs further out, so each part of the overhang cools before the next.') {
  const X = 20, Y = 10, steps4 = [0, 1, 2, 3]
  const bar = (k, cls) => `<rect class="${cls}" x="${2 + k * 1.6}" y="${3 + k * 2}" width="12" height="1.8" rx=".4"/>`
  const base = `<rect class="s-f2" x="2" y="0" width="12" height="3"/>`
  const lit = steps4.map((k) => stateG(id, k, bar(k, 's-g1'))).join('')
  const inner = base + steps4.map((k) => bar(k, 's-f1')).join('') + lit
  return { id, about, css: nCss(id, 4), body: `${box([0, 0, 0], [X, Y, 12], { l: 's-f3' })}${face(Y, inner, ' style="stroke:var(--stage-ol,#1a1b24);stroke-width:.25"')}${pillAt(id, X, 6, 72)}`, readout: { rows: ['1/4: 50 %', '2/4: 40 %', '3/4: 30 %', '4/4: 20 %'], w: 72 } }
}

// ---------- overhang fan: an overhang's edge curls up with the fan low, then prints flat with it at full ----------
export function overhangFanLoop(id = 'aof', about = 'Overhang fan speed: on overhangs and bridges the part fan runs at this speed, so the edge cools flat instead of curling.') {
  const f1 = fan(id, 232, 48, 12, 1.6), f2 = fan(`${id}g`, 232, 48, 12, 0.35)
  const curl = `<path class="s-n"${st(CUT, 2.4)} d="M${iso(20, 12, 9).join(' ')}Q${iso(26, 12, 9).join(' ')} ${iso(27, 12, 12).join(' ')}"/>`
  const body = `${box([0, 2, 0], [8, 12, 12])}${box([8, 2, 9], [20, 12, 12])}${stateG(id, 'a', curl + f1.svg)}${stateG(id, 'b', box([20, 2, 9], [26, 12, 12], { l: 's-g2', r: 's-g3', t: 's-g1', ol: 's-aol' }) + f2.svg)}${pill(id, 214, 76, 52)}`
  return { id, about, css: twoCss(id) + rows2(id) + f1.css + f2.css, body, readout: { rows: ['40 %', '100 %'], w: 52 } }
}

// ---------- overhang reverse: every other layer of an overhang runs the other way, so it does not curl ----------
export function overhangReverseLoop(id = 'aor', about = 'Overhang reverse: on every other layer the walls over an overhang run the other way, which keeps the edge from curling.') {
  const X = 26, Y = 10
  const chevrons = (dirs) => dirs.map((dir, k) => Array.from({ length: 3 }, (_, j) => {
    const x = 5 + j * 7, y = 1.6 + k * 3
    return dir > 0 ? `M${x} ${y - 1}l2 1l-2 1` : `M${x + 2} ${y - 1}l-2 1l2 1`
  }).join('')).join('')
  const lines = Array.from({ length: 3 }, (_, k) => `<rect class="s-f1" x="1" y="${0.3 + k * 3}" width="24" height="2.6" rx=".6"/>`).join('')
  const inner = lines + stateG(id, 'a', `<path class="s-n"${st(CUT, 0.6)} d="${chevrons([1, 1, 1])}"/>`) + stateG(id, 'b', `<path class="s-n"${st(A1, 0.6)} d="${chevrons([1, -1, 1])}"/>`)
  return { id, about, css: twoCss(id), body: `${box([0, 0, 0], [X, Y, 9.5], { l: 's-f3' })}${face(Y, inner)}` }
}

// ---------- part fan: off for the first layers, ramping up to full by the full fan speed layer ----------
export function partFanLoop(id = 'apf', about = 'Part fan: off for the first layers so they stick, then ramping up to full speed by the layer you set.') {
  const n = 3, Z = [1, 3, 6]
  const fans = [fan(`${id}0`, 232, 48, 12, 9), fan(`${id}1`, 232, 48, 12, 0.9), fan(`${id}2`, 232, 48, 12, 0.3)]
  const body = Z.map((z, i) => stateG(id, i, box([4, 3, 0], [22, 13, z]) + fans[i].svg)).join('') + pill(id, 214, 76, 52)
  return { id, about, css: nCss(id, n) + fans.map((f) => f.css).join(''), body, readout: { rows: ['0 %', '50 %', '100 %'], w: 52 } }
}

// ---------- precise Z height: the top overshoots the model's height, then the last layers land on it exactly ----------
export function preciseZLoop(id = 'apz', about = 'Precise Z height: the last few layer heights are adjusted so the top lands exactly at the model\'s height.') {
  const X = 26, Y = 10, H = 9
  const layers = (hs, cls) => {
    let z = 0
    return hs.map((h) => { const r = `<rect class="${cls}" x="2" y="${r1(z + 0.06)}" width="22" height="${r1(h - 0.12)}" rx=".25"/>`; z += h; return r }).join('')
  }
  const even = Array(7).fill(1.4)
  const tuned = [1.4, 1.4, 1.4, 1.4, 1.4, 1.1, 0.9]
  const target = `<path class="s-n" style="stroke:var(${A1});stroke-width:.25;stroke-dasharray:1 .7" d="M0 ${H}H${X}"/>`
  // even layers overshoot the model's top; the tuned ones end on it
  const inner = `${stateG(id, 'a', layers(even.slice(0, 6), 's-f1') + `<rect class="s-cf" x="2" y="8.46" width="22" height="1.28" style="stroke:var(${CUT});stroke-width:.2"/>`)}${stateG(id, 'b', layers(tuned.slice(0, 5), 's-f1') + layers([7, 1.1, 0.9], 's-g1').replace(/<rect[^>]*>/, ''))}${target}`
  return { id, about, css: twoCss(id) + rows2(id), body: `${box([0, 0, 0], [X, Y, 11], { l: 's-f3' })}${face(Y, inner)}${pillAt(id, X, 6, 64)}`, readout: { rows: ['9.30 mm', '9.00 mm'], w: 64 } }
}

// ---------- stills and slow loops for structure and location ----------
/** A part cut open, each role lit in turn: walls, infill, top and bottom, support. */
export function partRolesLoop(id = 'arl', about = 'Roles of a part: a part cut open with its outer wall, inner wall, sparse infill and top and bottom surfaces lit in turn.') {
  const X = 26, Y = 10, Z = 11, n = 4
  const r = (x, y, w, h) => `<rect x="${x}" y="${y}" width="${w}" height="${h}"/>`
  const roles = [
    r(1, 0, 1.4, Z) + r(X - 2.4, 0, 1.4, Z),
    r(2.6, 1.6, 1.4, Z - 3.2) + r(X - 4, 1.6, 1.4, Z - 3.2),
    `<path style="fill:none;stroke-width:.5" d="M4.4 2.2L${X - 4.4} ${Z - 2.2}M4.4 ${Z - 2.2}L${X - 4.4} 2.2M13 2.2V${Z - 2.2}"/>`,
    r(2.6, 0, X - 5.2, 1.4) + r(2.6, Z - 1.4, X - 5.2, 1.4),
  ]
  const T = states(n)
  const css = [steps(id), ...roles.map((_, i) => `.sxs .${id}-l${i}{animation-name:${id}-l${i}}` + kf(`${id}-l${i}`, [[0, op0(i === 0)], ...(i ? [[T[i], op0(true)]] : []), [T[i + 1], op0(false)], ...(i ? [] : [[3.3, op0(true)]])]))].join('')
  const base = `<g style="fill:var(${T2});stroke:var(${T3})">${roles.join('')}</g>`
  const lit = roles.map((g, i) => `<g class="${id}-l${i} ${id}-s s-a" style="fill:var(${A1});stroke:var(${A1})">${g}</g>`).join('')
  return { id, about, css, body: `${box([0, 0, 0], [X, Y, Z], { l: 's-f3' })}${face(Y, `<rect class="s-hole" x="0" y="0" width="${X}" height="${Z}"/>${base}${lit}`)}` }
}
const op0 = (on) => `opacity:${on ? 1 : 0}`

/** The plate with two parts, a no-go zone and the prime tower in the clear spot (a still). */
export function towerSpotStill(id = 'ats', about = 'Prime tower spot: the tower is placed where the plate is clear, away from the parts and the no-go zones.') {
  const nogo = poly('s-cf', [[-8, 18, 0], [6, 18, 0], [6, 28, 0], [-8, 28, 0]], ` style="stroke:var(${CUT});stroke-dasharray:3 2"`)
  const body = `${nogo}${box([0, 0, 0], [10, 10, 6])}${box([14, 2, 0], [24, 12, 8])}${box([30, -6, 0], [35, -1, 14], { l: 's-g2', r: 's-g3', t: 's-g1', ol: 's-aol' })}`
  return { id, about, css: '', body }
}

/** One curve cut into long segments and the same curve in short ones (a still). */
export function pathResolutionStill(id = 'apr', about = 'Path resolution: a curve cut into long segments shows facets; cut finer it stays round, at the cost of more moves.') {
  const arc = (cx, n) => rel(Array.from({ length: n + 1 }, (_, k) => {
    const a = Math.PI * (k / n)
    return [cx + 6 * Math.cos(a), 8 - 6 * Math.sin(a) + 4, 2.5]
  }), false)
  const dots = (cx, n) => Array.from({ length: n + 1 }, (_, k) => {
    const a = Math.PI * (k / n), [x, y] = iso(cx + 6 * Math.cos(a), 8 - 6 * Math.sin(a) + 4, 2.5)
    return `M${x} ${y}h0`
  }).join('')
  const body = `${box([0, 0, 0], [30, 14, 2.5])}${bead('', arc(8, 4), CUT, 2)}<path class="s-n"${st(CUT, 4)} style="stroke-linecap:round" d="${dots(8, 4)}"/>${bead('', arc(22, 24), A1, 2)}`
  return { id, about, css: '', body }
}

/** A top surface with pinholes at low density, solid at full (a still). */
export function topDensityStill(id = 'atd', about = 'Top surface density: a top printed below full density leaves pinholes; at full it closes.') {
  const Z = 2.5
  const lines = (x0, x1, sp) => {
    let d = ''
    for (let y = 1.2; y < 14; y += sp) d += rel([[x0, y, Z], [x1, y, Z]], false)
    return d
  }
  const body = `${box([0, 0, 0], [30, 14, Z], { t: 's-hole' })}${bead('', lines(1, 14, 1.6), T2, 1.4)}${bead('', lines(16, 29, 0.8), A1, 1.6)}`
  return { id, about, css: '', body }
}

/** Advanced, first half, last set, by the file name the export uses. */
export const LOOPS = {
  'adv-painted-interlock': () => paintedInterlockLoop(),
  'adv-ooze': () => oozeLoop(),
  'adv-overhang-speed': () => overhangSpeedLoop(),
  'adv-overhang-fan': () => overhangFanLoop(),
  'adv-overhang-reverse': () => overhangReverseLoop(),
  'adv-part-fan': () => partFanLoop(),
  'adv-precise-z': () => preciseZLoop(),
  'adv-part-roles': () => partRolesLoop(),
  'adv-tower-spot': () => towerSpotStill(),
  'adv-path-resolution': () => pathResolutionStill(),
  'adv-top-density': () => topDensityStill(),
}
