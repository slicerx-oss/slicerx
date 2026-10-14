// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Advanced settings, first half continued: brims, holes, infill, walls, cooling and multi-material joins. Two states
// each, the first showing the problem (red) or the setting off, the second the setting at work.
import { box, cyl, disc, iso, kf, r1, S } from './stage.mjs'
import { A1, bead, CUT, join, pill, poly, rel, rows2, st, stateG, T2, T3, timebar, timeTwo, twoCss } from './kit.mjs'

const C30 = Math.cos(Math.PI / 6)
const CY = '--cyan,#8be9fd'
/** A slab and the z of its top. */
const slab = (X, Y, Z = 2.5) => box([0, 0, 0], [X, Y, Z])
/** An ellipse at a level disc. */
const ell = (d, cls, extra = '') => `<ellipse class="${cls}" cx="${d.cx}" cy="${d.cy}" rx="${d.rx}" ry="${d.ry}"${extra}/>`
/** Drawing on the front face (y = Y) in face mm: u along x, v up. */
const face = (Y, inner, extra = '') => {
  const [ox, oy] = iso(0, Y, 0)
  return `<g transform="matrix(${r1(C30 * S * 100) / 100} ${r1(0.5 * S * 100) / 100} 0 ${-S} ${ox} ${oy})"${extra}>${inner}</g>`
}
const pillAt = (id, X, Y, z, w) => {
  const [x, y] = iso(X, 0, z)
  return pill(id, x + 16, y + 6, w)
}
const withTime = (id, X, z, a, b) => {
  const tb = timebar(id, 0, 0, timeTwo(a, b))
  const [x, y] = iso(X, 0, z)
  return { css: tb.css, svg: tb.svg.replace('translate(0 0)', `translate(${r1(x + 16)} ${r1(y + 24)})`) }
}

// ---------- brim ears detection: ears under every corner, then only under the sharp one ----------
export function brimEarsDetectLoop(id = 'abe', about = 'Brim ears detection: ears go under each corner sharper than the max angle; a lower angle leaves only the sharpest.') {
  // a triangle with one sharp tip (about 30 degrees) and two blunter corners
  const P = [[2, 2], [26, 8], [2, 14]], Z = 4
  const top = poly('s-f1 s-ol', P.map(([x, y]) => [x, y, Z]))
  const side = poly('s-f2 s-ol', [[...P[1], 0], [...P[2], 0], [...P[2], Z], [...P[1], Z]])
  const ear = ([x, y]) => ell(disc(x, y, 0, 3), 's-af', st(A1, 1.6))
  const body = `${stateG(id, 'a', ear(P[0]) + ear(P[2]))}${ear(P[1])}${side}${top}${pillAt(id, 26, 2, Z, 48)}`
  return { id, about, css: twoCss(id) + rows2(id), body, readout: { rows: ['125°', '45°'], w: 48 } }
}

// ---------- counterbore bridging: a hole's wider step on the bed side, its ceiling sagging, then bridged ----------
export function counterboreLoop(id = 'acb', about = 'Counterbore hole bridging: the ceiling of a wide step under a narrow hole sags into the air; bridged, it prints flat.') {
  const X = 26, Y = 10, Z = 12, cav = [6, 20, 5], hole = [11, 15]
  const ceil = (sag) => `M${cav[0]} ${cav[2]}Q${(cav[0] + hole[0]) / 2} ${cav[2] - sag} ${hole[0]} ${cav[2]}M${hole[1]} ${cav[2]}Q${(hole[1] + cav[1]) / 2} ${cav[2] - sag} ${cav[1]} ${cav[2]}`
  const cut = `<path class="s-hole" d="M${cav[0]} 0V${cav[2]}H${hole[0]}V${Z}H${hole[1]}V${cav[2]}H${cav[1]}V0Z"/>`
  const inner = `${cut}${stateG(id, 'a', `<path class="s-n"${st(CUT, 1.8)} d="${ceil(2.2)}"/>`)}${stateG(id, 'b', `<path class="s-n"${st(A1, 2.4)} d="${ceil(0)}"/>`)}`
  return { id, about, css: twoCss(id), body: `${box([0, 0, 0], [X, Y, Z], { l: 's-f3' })}${face(Y, inner, ' style="vector-effect:non-scaling-stroke"')}` }
}

// ---------- narrow solid infill: a thin strip filled with short zigzags, then a few long lines ----------
export function narrowSolidLoop(id = 'ans', about = 'Detect narrow internal solid infill: a thin strip is filled with long lines along it instead of short zigzags across it.') {
  const X = 26, Y = 14, Z = 2.5, y0 = 5.5, y1 = 8.5
  let zig = []
  for (let x = 3, k = 0; x <= 23; x += 1, k++) zig.push([x, k % 2 ? y1 : y0, Z])
  const along = [y0 + 0.6, (y0 + y1) / 2, y1 - 0.6].map((y) => rel([[3, y, Z], [23, y, Z]], false)).join('')
  const walls = rel([[2, y0 - 0.6, Z], [24, y0 - 0.6, Z], [24, y1 + 0.6, Z], [2, y1 + 0.6, Z]])
  const body = `${slab(X, Y)}${bead('', walls, T3, 1.6)}${stateG(id, 'a', bead('', rel(zig, false), CUT, 1.2))}${stateG(id, 'b', bead('', along, A1, 1.6))}`
  return { id, about, css: twoCss(id), body }
}

// ---------- arc fitting: a curve sent as many short moves, then as one arc ----------
export function arcFittingLoop(id = 'aaf', about = 'Arc fitting: a curve written as many short straight moves is sent as one arc move instead, so the printer runs it smoothly.') {
  const Z = 2.5, cx = 13, cy = 8, R = 9, N = 12
  const pts = (n) => Array.from({ length: n + 1 }, (_, k) => {
    const a = Math.PI * (0.15 + (0.7 * k) / n)
    return [cx - R * Math.cos(a), cy + R * Math.sin(a) - 4, Z]
  })
  const seg = rel(pts(N), false)
  const dots = pts(N).map((p) => { const [x, y] = iso(...p); return `M${x} ${y}h0` }).join('')
  const ends = [pts(N)[0], pts(N)[N]].map((p) => { const [x, y] = iso(...p); return `M${x} ${y}h0` }).join('')
  const arc = (() => { const q = pts(48); return rel(q, false) })()
  const body = `${slab(26, 16)}${stateG(id, 'a', bead('', seg, T3, 1.6) + `<path class="s-n"${st(CUT, 4)} style="stroke-linecap:round" d="${dots}"/>`)}${stateG(id, 'b', bead('', arc, A1, 2.4) + `<path class="s-n"${st(A1, 5)} style="stroke-linecap:round" d="${ends}"/>`)}`
  return { id, about, css: twoCss(id), body }
}

// ---------- more walls under overhangs: the overhanging part of a ledge gets extra wall loops ----------
export function overhangWallsLoop(id = 'aow', about = 'More walls under overhangs: steep overhangs get extra wall loops so they hold their shape.') {
  const ledge = (lo, hi) => box(lo, hi)
  const lines = (zs, c) => bead('', zs.map((z) => rel([[8, 12, z], [22, 12, z]], false)).join(''), c, 1.4)
  const body = `${box([0, 4, 0], [8, 12, 14])}${ledge([8, 4, 9], [22, 12, 14])}${lines([10, 13], T3)}${stateG(id, 'b', lines([11, 12], A1))}`
  return { id, about, css: twoCss(id), body }
}

// ---------- fan cooling layer time: a big layer cools with the fan slow; a small fast layer turns it up ----------
function fan(cx, cy, r, dur, cls) {
  const blade = (a) => {
    const t = (a * Math.PI) / 180
    return `M${cx} ${cy}Q${r1(cx + r * Math.cos(t - 0.6))} ${r1(cy + r * Math.sin(t - 0.6))} ${r1(cx + r * Math.cos(t))} ${r1(cy + r * Math.sin(t))}Z`
  }
  return `<g class="${cls}" style="transform-box:fill-box;transform-origin:center;animation:${cls}-r ${dur}s linear infinite"><circle cx="${cx}" cy="${cy}" r="${r + 2}" style="fill:var(--stage-pill,#16171e);stroke:var(--stage-ol,#1a1b24)"/><path class="s-g1" d="${[0, 120, 240].map(blade).join('')}"/></g>`
}
export function fanLayerTimeLoop(id = 'afc', about = 'Fan cooling layer time: a layer that prints faster than this gets more fan, up to full on the smallest layers.') {
  const css = twoCss(id) + rows2(id) + `@keyframes ${id}-f-r{to{rotate:360deg}}@keyframes ${id}-g-r{to{rotate:360deg}}`
  const body = `${stateG(id, 'a', box([0, 0, 0], [24, 16, 3]) + fan(232, 52, 13, 1.6, `${id}-f`))}${stateG(id, 'b', cyl(12, 8, 0, 14, 3) + fan(232, 52, 13, 0.35, `${id}-g`))}${pill(id, 212, 82, 52)}`
  return { id, about, css, body, readout: { rows: ['40 %', '100 %'], w: 52 } }
}

// ---------- flush into infill: purge goes into the part's infill instead of a taller prime tower ----------
export function flushInfillLoop(id = 'afl', about = 'Flush into infill: some of the old color is purged into the part\'s infill, so the prime tower stays smaller.') {
  const Z = 6
  const grid = (c) => bead('', [3, 7, 11, 15].map((x) => rel([[x, 1, Z], [x, 13, Z]], false)).join('') + [4, 8, 12].map((y) => rel([[1, y, Z], [17, y, Z]], false)).join(''), c, 1.6)
  const tower = (h) => box([22, 2, 0], [27, 7, h], { l: 's-g2', r: 's-g3', t: 's-g1', ol: 's-aol' })
  const top = poly('s-f1 s-ol', [[0, 0, Z], [18, 0, Z], [18, 14, Z], [0, 14, Z]])
  const sides = box([0, 0, 0], [18, 14, Z]).replace(/<polygon class="s-f1[^>]*>/, '')
  const body = `${sides}${top}${stateG(id, 'a', grid(T3) + tower(14))}${stateG(id, 'b', grid(CY) + tower(7))}`
  return { id, about, css: twoCss(id), body }
}

// ---------- infill anchor: infill lines that stop at the wall, then run along it to anchor ----------
export function infillAnchorLoop(id = 'aan', about = 'Infill anchor: each infill line runs a short way along the wall before it turns, so it holds to the wall.') {
  const Z = 2.5, X = 26, Y = 16, W = 1.5
  const xs = [5, 9, 13, 17, 21]
  const free = xs.map((x) => rel([[x, W + 1, Z], [x, Y - W - 1, Z]], false)).join('')
  const anchored = xs.map((x, i) => rel([[x - (i % 2 ? 2.4 : 0), W + 0.3, Z], [x, W + 0.3, Z], [x, Y - W - 0.3, Z], [x + (i % 2 ? 0 : 2.4), Y - W - 0.3, Z]], false)).join('')
  const walls = rel([[W, W, Z], [X - W, W, Z], [X - W, Y - W, Z], [W, Y - W, Z]])
  const ends = xs.flatMap((x) => [[x, W + 1, Z], [x, Y - W - 1, Z]]).map((p) => { const [a, b] = iso(...p); return `M${a} ${b}h0` }).join('')
  const body = `${slab(X, Y)}${bead('', walls, T3, 1.8)}${stateG(id, 'a', bead('', free, T2, 1.4) + `<path class="s-n"${st(CUT, 3.4)} style="stroke-linecap:round" d="${ends}"/>`)}${stateG(id, 'b', bead('', anchored, A1, 1.4))}${pillAt(id, X, Y, Z, 60)}`
  return { id, about, css: twoCss(id) + rows2(id), body, readout: { rows: ['0 mm', '2.5 mm'], w: 60 } }
}

// ---------- combine infill layers: sparse infill printed every other layer at twice the height ----------
export function combineInfillLoop(id = 'aci', about = 'Combine infill layers: sparse infill is printed once every few layers at a greater height, which saves time.') {
  const X = 26, Y = 10, Z = 10
  const rowsAt = (n, c) => Array.from({ length: n }, (_, k) => {
    const h = 8 / n
    return `<rect x="7" y="${r1(1 + k * h + 0.15)}" width="12" height="${r1(h - 0.3)}" rx="${r1(Math.min(0.8, h / 3))}" style="fill:var(${c})"/>`
  }).join('')
  const walls = Array.from({ length: 8 }, (_, k) => `<rect x="1" y="${1 + k + 0.1}" width="5" height="0.8" rx=".3" class="s-f1"/><rect x="20" y="${1 + k + 0.1}" width="5" height="0.8" rx=".3" class="s-f1"/>`).join('')
  const tb = withTime(id, X, Z / 2, 0.75, 0.55)
  const inner = `${walls}${stateG(id, 'a', rowsAt(8, T2))}${stateG(id, 'b', rowsAt(4, '--stage-a1,#c9a6fb'))}`
  return { id, about, css: twoCss(id) + tb.css, body: `${box([0, 0, 0], [X, Y, Z], { l: 's-f3' })}${face(Y, inner)}${tb.svg}` }
}

// ---------- infill and wall overlap: infill lines that stop short of the wall, then reach into it ----------
export function infillOverlapLoop(id = 'aio', about = 'Overlap between infill and walls: how far the infill reaches into the walls; with none, a gap is left between them.') {
  const Z = 2.5, X = 26, Y = 16, W = 2
  const lines = (reach) => [5, 9, 13, 17, 21].map((x) => rel([[x, W + 1.2 - reach, Z], [x, Y - W - 1.2 + reach, Z]], false)).join('')
  const walls = rel([[W, W, Z], [X - W, W, Z], [X - W, Y - W, Z], [W, Y - W, Z]])
  const gap = poly('s-cf', [[W + 0.4, W + 0.4, Z], [X - W - 0.4, W + 0.4, Z], [X - W - 0.4, W + 1.1, Z], [W + 0.4, W + 1.1, Z]]) + poly('s-cf', [[W + 0.4, Y - W - 1.1, Z], [X - W - 0.4, Y - W - 1.1, Z], [X - W - 0.4, Y - W - 0.4, Z], [W + 0.4, Y - W - 0.4, Z]])
  const body = `${slab(X, Y)}${bead('', walls, T3, 2.4)}${stateG(id, 'a', gap + bead('', lines(0), T2, 1.4))}${stateG(id, 'b', bead('', lines(1.2), A1, 1.4))}${pillAt(id, X, Y, Z, 48)}`
  return { id, about, css: twoCss(id) + rows2(id), body, readout: { rows: ['0 %', '15 %'], w: 48 } }
}

// ---------- interlocking: two materials meeting at a flat seam, then woven together with beams ----------
export function interlockingLoop(id = 'ail', about = 'Interlocking: where two materials meet, beams of each reach into the other on alternate layers so the joint holds.') {
  const X = 26, Y = 10, Z = 10, mid = 13
  const a = `<rect x="1" y="0" width="${mid - 1}" height="${Z}" style="fill:var(--stage-a2,#a57ae8)"/>`, b = `<rect x="${mid}" y="0" width="${X - mid - 1}" height="${Z}" style="fill:var(${CY})"/>`
  const teeth = Array.from({ length: 5 }, (_, k) => k % 2 ? `<rect x="${mid - 3}" y="${k * 2}" width="3" height="2" style="fill:var(${CY})"/>` : `<rect x="${mid}" y="${k * 2}" width="3" height="2" style="fill:var(--stage-a2,#a57ae8)"/>`).join('')
  const seam = `<path class="s-n"${st(CUT, 0.5)} d="M${mid} 0V${Z}"/>`
  return { id, about, css: twoCss(id), body: `${box([0, 0, 0], [X, Y, Z], { l: 's-f3' })}${face(Y, a + b + stateG(id, 'a', seam) + stateG(id, 'b', teeth))}` }
}

// ---------- lightning infill: thin trees inside the part hold up only the top surface; the angle sets their spread ----------
export function lightningLoop(id = 'alt', about = 'Lightning infill: thin branching trees inside the part hold up only the top surface; the angles set how far they spread.') {
  const X = 26, Y = 10, Z = 12
  const tree = (spread) => {
    let d = ''
    for (const x of [7, 19]) {
      d += `M${x} 0V5`
      for (const s of [-1, 1]) d += `M${x} 5L${r1(x + s * spread)} ${Z - 1}M${x} 5L${r1(x + s * spread * 0.4)} ${Z - 1}`
    }
    return d
  }
  const inner = `<rect x="0" y="${Z - 1}" width="${X}" height="1" class="s-f1"/>${stateG(id, 'a', `<path class="s-n"${st(A1, 0.6)} d="${tree(3)}"/>`)}${stateG(id, 'b', `<path class="s-n"${st(A1, 0.6)} d="${tree(5.5)}"/>`)}`
  const [x, y] = iso(X, 0, Z / 2)
  return { id, about, css: twoCss(id) + rows2(id), body: `${box([0, 0, 0], [X, Y, Z], { l: 's-hole' })}${face(Y, inner)}${pill(id, x + 16, y, 48)}`, readout: { rows: ['45°', '30°'], w: 48 } }
}

// ---------- min feature size: a thin fin prints at a low threshold and is dropped at a high one ----------
export function minFeatureLoop(id = 'amf', about = 'Min feature size: features thinner than this share of the nozzle are left out instead of printed.') {
  const fin = (cls) => box([6, 7, 6], [20, 7.6, 12], cls)
  const ghost = `<path class="s-ghost" d="${rel([[6, 7.6, 6], [6, 7.6, 12], [20, 7.6, 12], [20, 7.6, 6]], false)}"/>`
  const body = `${box([0, 0, 0], [26, 14, 6])}${stateG(id, 'a', fin({ l: 's-g2', r: 's-g3', t: 's-g1', ol: 's-aol' }))}${stateG(id, 'b', ghost)}${pillAt(id, 26, 0, 6, 52)}`
  return { id, about, css: twoCss(id) + rows2(id), body, readout: { rows: ['25 %', '75 %'], w: 52 } }
}

// ---------- polyhole: a round hole prints small and the pin will not go in; with flat sides it fits ----------
export function polyholeLoop(id = 'aph', about = 'Polyholes: a round hole prints a little small; turned into a polygon with flat sides, it comes out true and the pin fits.') {
  const Z = 6, c = [13, 8], R = 4
  const round = ell(disc(c[0], c[1], Z, R - 0.5), 's-hole', st(CUT, 1.6))
  const poly8 = `<path class="s-hole" d="${rel(Array.from({ length: 8 }, (_, k) => { const a = (k / 8) * Math.PI * 2 + Math.PI / 8; return [c[0] + R * Math.cos(a), c[1] + R * Math.sin(a), Z] }))}"/>`
  const pin = (z, cls) => `<g class="${cls}">${cyl(c[0], c[1], z, z + 8, R - 0.6, true)}</g>`
  const css = twoCss(id) + `.sxs .${id}-p{animation-name:${id}-p}` + kf(`${id}-p`, [[1.6, 'translate:0 0'], [2.1, `translate:0 ${r1(5 * S)}px`], [3.2, `translate:0 ${r1(5 * S)}px`], [3.3, 'translate:0 0']])
  const body = `${box([0, 0, 0], [26, 16, Z])}${stateG(id, 'a', round + pin(Z + 1, ''))}${stateG(id, 'b', poly8 + `<clipPath id="${id}-k"><rect x="0" y="0" width="296" height="${r1(iso(c[0], c[1] + R, Z)[1])}"/></clipPath><g clip-path="url(#${id}-k)"><g class="${id}-p s-a">${pin(Z + 1, '')}</g></g>`)}`
  return { id, about, css, body }
}

// ---------- precise wall: a gap left between the outer and inner walls, then closed to the exact spacing ----------
export function preciseWallLoop(id = 'apw', about = 'Precise wall: the spacing between the outer and inner walls is set exactly, so no gap is left between them.') {
  const Z = 2.5, X = 26, Y = 16
  const loop = (i) => rel([[i, i, Z], [X - i, i, Z], [X - i, Y - i, Z], [i, Y - i, Z]])
  const body = `${slab(X, Y)}${bead('', loop(1.2), T3, 4)}${stateG(id, 'a', bead('', loop(3), T2, 4) + bead('', loop(2.1), CUT, 0.8))}${stateG(id, 'b', bead('', loop(2.3), A1, 4))}`
  return { id, about, css: twoCss(id), body }
}

/** Advanced, first half continued, by the file name the export uses. */
export const LOOPS = {
  'adv-brim-ears-detect': () => brimEarsDetectLoop(),
  'adv-counterbore': () => counterboreLoop(),
  'adv-narrow-solid': () => narrowSolidLoop(),
  'adv-arc-fitting': () => arcFittingLoop(),
  'adv-overhang-walls': () => overhangWallsLoop(),
  'adv-fan-layer-time': () => fanLayerTimeLoop(),
  'adv-flush-infill': () => flushInfillLoop(),
  'adv-infill-anchor': () => infillAnchorLoop(),
  'adv-combine-infill': () => combineInfillLoop(),
  'adv-infill-overlap': () => infillOverlapLoop(),
  'adv-interlocking': () => interlockingLoop(),
  'adv-lightning': () => lightningLoop(),
  'adv-min-feature': () => minFeatureLoop(),
  'adv-polyhole': () => polyholeLoop(),
  'adv-precise-wall': () => preciseWallLoop(),
}
