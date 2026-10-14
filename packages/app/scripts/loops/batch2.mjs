// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Batch 2 tooltip loops: the viewport and model tools. These are hand actions, so the pointer shows where to act;
// a press lands at 0.5 s unless a loop says otherwise.
import { arrow, box, cyl, disc, hud, iso, kf, morph, pointer, r1, rowFrames, run, S, snapFrames, snaps, tr } from './stage.mjs'
import { A1, draw, fade, join, op, rel, st, steps, T3, vis } from './kit.mjs'

const EASE = 'animation-timing-function:cubic-bezier(.65,0,.35,1)'
const at = (dx, dy, dz) => `translate:${tr(dx, dy, dz)}`
const px = (dx, dy) => `translate:${r1(dx)}px ${r1(dy)}px`
/** The three visible faces of a box as relative paths, so boxes of any size morph into each other. */
const faces = ([x0, y0, z0], [x1, y1, z1]) => ({
  l: rel([[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]]),
  r: rel([[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]]),
  t: rel([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]),
})
/** A box that morphs through [seconds, [lo, hi]] frames. */
function morphBox(frames, still, cls = { l: 's-f2 s-ol', r: 's-f3 s-ol', t: 's-f1 s-ol' }) {
  return ['l', 'r', 't'].map((k) => morph(cls[k], frames.map(([t, b]) => [t, faces(...b)[k]]), faces(...still)[k])).join('')
}
const dashed = (d, c = T3) => `<path class="s-n" style="stroke:var(${c});stroke-width:1.3;stroke-dasharray:3 2.5" d="${d}"/>`

// ---------- history (suppress, view, earlier, later): a block with a hole and a boss, its three steps beside it ----------
const CHIP = { x: 226, y: [30, 48, 66], w: 50 }
function chip(i, glyph) {
  const y = CHIP.y[i]
  return `<rect class="sxs-pill" x="${CHIP.x}" y="${y - 7}" width="${CHIP.w}" height="14" rx="5"/>${glyph(CHIP.x + 10, y)}<rect x="${CHIP.x + 19}" y="${y - 1.5}" width="22" height="3" rx="1.5" style="fill:rgb(255 255 255/.35)"/>`
}
const PILL_INK = 'fill:none;stroke:var(--stage-pill-text,#f8f8f2);stroke-width:1.3'
const GLYPHS = [
  (x, y) => `<rect x="${x - 3}" y="${y - 3}" width="6" height="6" style="${PILL_INK}"/>`,
  (x, y) => `<circle cx="${x}" cy="${y}" r="3" style="${PILL_INK}"/>`,
  (x, y) => `<circle cx="${x}" cy="${y}" r="3" style="fill:var(--stage-pill-text,#f8f8f2)"/>`,
]
const HB = [[0, 0, 0], [20, 14, 8]], HOLE = disc(6, 7, 8, 2.5)
const ring = (e) => `M${r1(e.cx - e.rx)} ${e.cy}a${e.rx} ${e.ry} 0 1 0 ${r1(2 * e.rx)} 0a${e.rx} ${e.ry} 0 1 0 ${r1(-2 * e.rx)} 0`
function historyLoop(id, kind, about) {
  const css = [steps(id)]
  let chips = '', model = ''
  const holeEl = `<ellipse class="s-hole" cx="${HOLE.cx}" cy="${HOLE.cy}" rx="${HOLE.rx}" ry="${HOLE.ry}"/>`
  const boss = cyl(14, 7, 8, 12, 2.5)
  let px0 = CHIP.x + 44, py0 = CHIP.y[1] + 3
  if (kind === 'suppress' || kind === 'view') {
    // a click on step 2 at 0.5 s, another at 2.2 s brings it back
    const dim = kind === 'suppress' ? 1 : 2
    css.push(vis(`${id}-f`, 0, 0.6, 2.25))
    chips = [0, 1, 2].map((i) => (i === dim ? `<g class="${id}-x ${id}-s s-a">${chip(i, GLYPHS[i])}</g>` : chip(i, GLYPHS[i]))).join('')
    css.push(`.sxs .${id}-x{animation-name:${id}-x}` + kf(`${id}-x`, [[0, op(1)], [0.55, op(0.35)], [2.25, op(1)]]))
    model = `${box(...HB)}${kind === 'suppress' ? `<g class="${id}-f ${id}-s s-a">${holeEl}</g>${boss}` : `${holeEl}<g class="${id}-f ${id}-s s-a">${boss}</g>`}`
    css.push(run(`${id}-g`) + kf(`${id}-g`, [[0, 'opacity:0'], [0.6, 'opacity:0'], [0.62, 'opacity:1'], [2.2, 'opacity:1'], [2.22, 'opacity:0']]))
    model += `<g class="${id}-g s-a">${dashed(kind === 'suppress' ? ring(HOLE) : (() => { const t = disc(14, 7, 12, 2.5), b = disc(14, 7, 8, 2.5); return `${ring(t)}M${r1(t.cx - t.rx)} ${t.cy}V${b.cy}A${b.rx} ${b.ry} 0 0 0 ${r1(b.cx + b.rx)} ${b.cy}V${t.cy}` })())}</g>`
    const body = `${model}${chips}${pointer(px0, py0)}<circle class="sxs-rip s-a" cx="${px0}" cy="${py0}" r="9" style="animation-delay:1.7s"/>`
    return { id, about, css: css.join(''), body }
  }
  // earlier or later: steps 2 and 3 swap; the grabbed step leads, the part runs again and its top flashes
  const up = kind === 'earlier', grab = up ? 2 : 1, other = up ? 1 : 2, dy = CHIP.y[2] - CHIP.y[1]
  const mv = (name, d) => run(name) + kf(name, [[0.55, `translate:0 0;${EASE}`], [1.05, px(0, d)], [3.05, `${px(0, d)};${EASE}`], [3.4, 'translate:0 0']])
  css.push(mv(`${id}-a`, up ? -dy : dy), mv(`${id}-b`, up ? dy : -dy))
  css.push(run(`${id}-l`) + kf(`${id}-l`, [[1.1, 'fill:var(--stage-t1,#d6d8e4)'], [1.25, 'fill:var(--stage-a1,#c9a6fb)'], [1.6, 'fill:var(--stage-a1,#c9a6fb)'], [1.9, 'fill:var(--stage-t1,#d6d8e4)']]))
  chips = chip(0, GLYPHS[0]) + `<g class="${id}-b s-a">${chip(other, GLYPHS[other])}</g><g class="${id}-a s-a">${chip(grab, GLYPHS[grab])}${pointer(px0, CHIP.y[grab] + 3)}</g>`
  model = box(...HB, { t: `${id}-l s-a` }) + holeEl + boss
  return { id, about, css: css.join(''), body: model + chips }
}
export const historySuppress = () => historyLoop('hs', 'suppress', 'Suppress: a step clicked and left out, so the part runs without its hole; a second click brings it back.')
export const historyView = () => historyLoop('hv', 'view', 'Show the part after this step: step 2 clicked, so the part shows as it was then, without the later boss.')
export const historyEarlier = () => historyLoop('hy', 'earlier', 'Move earlier: the last step dragged above the one before it; the part runs again.')
export const historyLater = () => historyLoop('hz', 'later', 'Move later: a step dragged below the one after it; the part runs again.')

// ---------- keep dimension: a length kept on the model follows the edge as the face is pulled ----------
export function keepDimension() {
  const Y = 12, Z = 8, X0 = 14, X1 = 22, Yd = Y + 5, drag = [1.1, 2.1], back = [3.1, 3.4]
  const fr = (fn) => [[drag[0], fn(X0)], [drag[1], fn(X1)], [back[0], fn(X1)], [back[1], fn(X0)]]
  const line = (x) => rel([[0, Yd, 0], [x, Yd, 0]], false)
  const tick = (x) => rel([[x, Y + 1, 0], [x, Yd + 1, 0]], false)
  const rows = []
  for (let v = X0; v <= X1; v += 2) rows.push(`${v}.0 mm`)
  const n = rows.length - 1
  const rowAt = Array.from({ length: n }, (_, i) => [drag[0] + ((i + 0.5) / n) * (drag[1] - drag[0]), i + 1])
  // the readout rides the moving end of the length; the pointer clicks the length near its start
  const half = tr(X1 - X0, 0, 0)
  const [mx, my] = iso(X0 * 0.3, Yd, 0), [ex, ey] = iso(X0, Yd, 0), [fx, fy] = iso(X0, Y / 2, Z / 2)
  const fx0 = iso(X0, 0, 0), fx1 = iso(X1, 0, 0)
  // the pointer clicks the length at its middle, then takes the end face
  const grab = [r1(fx + 4 - (mx + 8)), r1(fy - 2 - (my + 4))]
  const css = [steps('kd'), `.sxs .kd-h{animation-name:kd-h}`, rowFrames('kd-h', [[0, 0], ...rowAt, [back[1], 0]]),
    run('kd-m') + kf('kd-m', [[drag[0], 'translate:0 0'], [drag[1], `translate:${half}`], [back[0], `translate:${half}`], [back[1], 'translate:0 0']]),
    run('kd-p') + kf('kd-p', [[0.55, `translate:0 0;${EASE}`], [0.95, px(...grab)], [drag[0], px(...grab)], [drag[1], px(grab[0] + fx1[0] - fx0[0], grab[1] + fx1[1] - fx0[1])], [back[0], `${px(grab[0] + fx1[0] - fx0[0], grab[1] + fx1[1] - fx0[1])};${EASE}`], [back[1], 'translate:0 0']]),
    run('kd-e') + kf('kd-e', [[drag[0], 'translate:0 0'], [drag[1], `translate:${tr(X1 - X0, 0, 0)}`], [back[0], `translate:${tr(X1 - X0, 0, 0)}`], [back[1], 'translate:0 0']]),
    run('kd-k') + kf('kd-k', [[0.5, `stroke:var(${T3})`], [0.6, `stroke:var(${A1})`], [3.2, `stroke:var(${A1})`], [3.4, `stroke:var(${T3})`]]),
  ].join('')
  const lt = (x) => ['l', 't'].map((k) => faces([0, 0, 0], [x, Y, Z])[k])
  const right = `<polygon class="s-f3 s-ol" points="${[[X0, 0, 0], [X0, Y, 0], [X0, Y, Z], [X0, 0, Z]].map((q) => iso(...q).join(',')).join(' ')}"/>`
  const body = `${morph('s-f2 s-ol', fr((x) => lt(x)[0]), lt(X0)[0])}${morph('s-f1 s-ol', fr((x) => lt(x)[1]), lt(X0)[1])}<g class="kd-e s-a">${right}</g>
<g class="kd-k s-a" style="stroke-width:1.4;fill:none">${morph('s-n', fr(line), line(X0))}<path d="${tick(0)}"/><g class="kd-e s-a"><path d="${tick(X0)}"/></g></g>
<g class="kd-m s-a">${hud('kd', r1(ex + 10), r1(ey - 4), { w: 70 }, 'kd-h kd-s', '')}</g>
<g class="kd-p s-a">${pointer(r1(mx + 8), r1(my + 4))}</g>`
  return { id: 'kd', about: 'Keep this dimension: a length clicked to keep it, then the face pulled; the kept length follows and reads the new size.', css, body, readout: { rows, w: 70 } }
}

// ---------- mirror: an L-shaped part flipped across the X, Y or Z plane ----------
function mirrorLoop(axis) {
  const id = 'm' + 'xyz'[axis]
  // the upright at the low corner, and where the mirror puts it
  const parts = [
    { a: [[0, 0, 4], [5, 5, 12]], b: [[11, 0, 4], [16, 5, 12]], base: [[0, 0, 0], [16, 10, 4]] },
    { a: [[0, 0, 4], [5, 5, 12]], b: [[0, 5, 4], [5, 10, 12]], base: [[0, 0, 0], [16, 10, 4]] },
    { a: [[0, 0, 4], [5, 5, 12]], b: [[0, 0, 0], [5, 5, 8]], base: [[0, 0, 0], [16, 10, 4]], top: [[0, 0, 8], [16, 10, 12]] },
  ][axis]
  const plane = [
    rel([[8, -3, 0], [8, 13, 0], [8, 13, 14], [8, -3, 14]]),
    rel([[-3, 5, 0], [19, 5, 0], [19, 5, 14], [-3, 5, 14]]),
    rel([[-3, -3, 6], [19, -3, 6], [19, 13, 6], [-3, 13, 6]]),
  ][axis]
  const css = [fade(`${id}-p`, 0.35, 3.15), run(`${id}-o`) + kf(`${id}-o`, [[0.9, op(1)], [1.4, op(0.18)], [3.15, op(0.18)], [3.4, op(1)]]), fade(`${id}-n`, 1.3, 3.15, 0.35)].join('')
  const before = box(...parts.base) + box(...parts.a)
  const after = axis === 2 ? box(...parts.b) + box(...parts.top) : box(...parts.base) + box(...parts.b)
  const body = `<g class="${id}-o s-a">${before}</g><g class="${id}-n s-a">${after}</g><path class="${id}-p s-a s-af" style="stroke:var(${A1});stroke-width:1.4;stroke-dasharray:4 3" d="${plane}"/>`
  return { id, about: `Mirror along ${'XYZ'[axis]}: the mirror plane shows and the part flips across it, staying on the bed.`, css, body }
}
export const mirrorX = () => mirrorLoop(0)
export const mirrorY = () => mirrorLoop(1)
export const mirrorZ = () => mirrorLoop(2)

// ---------- print sequence: two parts printed by layer (the nozzle hops) and then by object (one finishes first) ----------
export function printSequence() {
  const P = [{ x: [0, 7], y: [2, 9] }, { x: [13, 20], y: [6, 13] }], H = 2.5, N = 4
  const byLayer = [], byObject = []
  for (let k = 0; k < N; k++) for (const p of [0, 1]) byLayer.push([p, k + 1])
  for (const p of [0, 1]) for (let k = 0; k < N; k++) byObject.push([p, k + 1])
  const t1 = (i) => 0.25 + i * 0.17, t2 = (i) => 1.85 + i * 0.17
  const h = [0, 1].map((p) => {
    const f = [[0, 'translate:0 0']]
    byLayer.forEach(([q, k], i) => q === p && f.push([t1(i), `translate:0 ${r1(-k * H * S)}px`]))
    f.push([1.7, 'translate:0 0'])
    byObject.forEach(([q, k], i) => q === p && f.push([t2(i), `translate:0 ${r1(-k * H * S)}px`]))
    f.push([3.3, 'translate:0 0'])
    return kf(`ps-${p}`, f)
  })
  const nz = [[0, 'translate:0 0']]
  const nozzleAt = (p, k) => {
    const a = iso(P[0].x[1] - 2, P[0].y[1] - 2, H), b = iso(P[p].x[1] - 2, P[p].y[1] - 2, k * H)
    return `translate:${r1(b[0] - a[0])}px ${r1(b[1] - a[1])}px`
  }
  byLayer.forEach(([p, k], i) => nz.push([t1(i), nozzleAt(p, k)]))
  nz.push([1.7, nozzleAt(0, 1)])
  byObject.forEach(([p, k], i) => nz.push([t2(i), nozzleAt(p, k)]))
  nz.push([3.3, nozzleAt(0, 1)])
  const css = [steps('ps'), `.sxs .ps-0{animation-name:ps-0}.sxs .ps-1{animation-name:ps-1}.sxs .ps-n{animation-name:ps-n}`, ...h, kf('ps-n', nz)].join('')
  const part = ({ x: [x0, x1], y: [y0, y1] }, p) => {
    const hi = N * H
    const clip = [iso(x0, y1, 0), iso(x1, y1, 0), iso(x1, y0, 0)]
    const sides = `<polygon class="s-f2 s-ol" points="${[[x0, y1, -hi], [x1, y1, -hi], [x1, y1, 0], [x0, y1, 0]].map((q) => iso(...q).join(',')).join(' ')}"/><polygon class="s-f3 s-ol" points="${[[x1, y0, -hi], [x1, y1, -hi], [x1, y1, 0], [x1, y0, 0]].map((q) => iso(...q).join(',')).join(' ')}"/>`
    const lines = Array.from({ length: N - 1 }, (_, k) => rel([[x0, y1, -(k + 1) * H], [x1, y1, -(k + 1) * H], [x1, y0, -(k + 1) * H]], false)).join('')
    return `<clipPath id="ps-c${p}"><polygon points="${clip.map((q) => q.join(',')).join(' ')} ${clip[2][0]},0 ${clip[0][0]},0"/></clipPath><g clip-path="url(#ps-c${p})"><g class="ps-${p} ps-s s-a">${sides}<path class="s-n" style="stroke:var(--stage-ol,#1a1b24);stroke-width:1;stroke-opacity:.45" d="${lines}"/><polygon class="s-f1 s-ol" points="${[[x0, y0, 0], [x1, y0, 0], [x1, y1, 0], [x0, y1, 0]].map((q) => iso(...q).join(',')).join(' ')}"/></g></g>`
  }
  const [nx, ny] = iso(P[0].x[1] - 2, P[0].y[1] - 2, H)
  const nozzle = `<g class="ps-n ps-s s-a"><polygon class="s-g2 s-aol" points="${nx},${ny} ${r1(nx - 5)},${r1(ny - 11)} ${r1(nx + 5)},${r1(ny - 11)}"/><rect class="s-g1 s-aol" x="${r1(nx - 8)}" y="${r1(ny - 21)}" width="16" height="10" rx="2"/></g>`
  return { id: 'ps', about: 'Print sequence: two parts printed by layer, the nozzle hopping between them, then by object, one finished before the other starts.', css, body: part(P[0], 0) + part(P[1], 1) + nozzle }
}

// ---------- whole loop: one picked edge, then every edge around that face ----------
export function wholeLoop() {
  const X = 22, Y = 14, Z = 8
  const css = [draw('wh-e', 0.5, 0.6), draw('wh-l', 1.2, 1.9)].join('')
  const glow = (cls, d) => `<path class="${cls} s-a s-n" pathLength="100" style="stroke:var(${A1});stroke-width:3;stroke-dasharray:100;filter:url(#sxs-glow)" d="${d}"/>`
  const [ex, ey] = iso(X, Y * 0.6, Z)
  const body = `${box([0, 0, 0], [X, Y, Z])}${glow('wh-l', rel([[X, Y, Z], [X, 0, Z], [0, 0, Z], [0, Y, Z]]))}${glow('wh-e', rel([[X, Y, Z], [X, 0, Z]], false))}${pointer(r1(ex + 2), r1(ey + 2))}`
  return { id: 'wh', about: 'Whole loop: one top edge picked, then every edge around that face added.', css, body }
}

// ---------- drop to bed: a floating part lowered until it touches ----------
export function dropToBed() {
  const lo = [5, 3, 0], hi = [17, 13, 8], Z = 9
  const css = [run('dr-z') + kf('dr-z', [[0.5, `${at(0, 0, Z)};${EASE}`], [1.2, 'translate:0 0'], [3.1, `translate:0 0;${op(1)}`], [3.3, `translate:0 0;${op(0)}`], [3.32, `${at(0, 0, Z)};${op(0)}`], [3.5, `${at(0, 0, Z)};${op(1)}`]]), fade('dr-f', 0.15, 1.15), fade('dr-w', 0.2, 1.0)].join('')
  const [ax, ay] = iso(11, 8, Z - 1)
  const body = `<path class="dr-f s-a s-n" style="stroke:var(${A1});stroke-width:1.4;stroke-dasharray:3 2.5" d="${rel([[lo[0], lo[1], 0], [hi[0], lo[1], 0], [hi[0], hi[1], 0], [lo[0], hi[1], 0]])}"/><g class="dr-z s-a">${box(lo, hi)}</g><g class="dr-w s-a">${arrow(r1(ax + 46), r1(ay - 6), 180)}</g>`
  return { id: 'dr', about: 'Drop to bed: a part floating over the plate lowered until it rests on it.', css, body }
}

// ---------- round corners: a sketched rectangle's corners rounded ----------
export function roundCorners() {
  const C = [[3, 3], [23, 3], [23, 15], [3, 15]], R = 3, g = [1.0, 1.8], back = [3.0, 3.35]
  const P = (x, y) => iso(x, y, 0)
  const shape = (r) => {
    let d = ''
    C.forEach(([x, y], i) => {
      const [nx, ny] = C[(i + 1) % 4], [qx, qy] = C[(i + 3) % 4]
      const a = [x + Math.sign(qx - x) * r, y + Math.sign(qy - y) * r], b = [x + Math.sign(nx - x) * r, y + Math.sign(ny - y) * r]
      d += `${i ? 'L' : 'M'}${join(P(...a))}Q${join(P(x, y))} ${join(P(...b))}`
    })
    return d + 'Z'
  }
  const moves = snaps(0, R, g[0], g[1])
  const css = [steps('rc'), `.sxs .rc-h{animation-name:rc-h}`, rowFrames('rc-h', [[0, 0], ...moves.map((m) => [(m.t0 + m.t1) / 2, m.v1]), [back[1], 0]]), vis('rc-c', 0, g[0] + 0.1, back[1]), vis('rc-t', g[0] + 0.1, back[1])].join('')
  // one vertex node, placed by reference
  const node = ([x, y]) => `<use href="#rc-n" x="${x}" y="${y}"/>`
  const def = '<defs><rect id="rc-n" x="-1.6" y="-1.6" width="3.2" height="3.2" style="fill:#fff;stroke:var(--stage-ol,#1a1b24);stroke-width:.8"/></defs>'
  const tangents = C.flatMap(([x, y], i) => {
    const [nx, ny] = C[(i + 1) % 4], [qx, qy] = C[(i + 3) % 4]
    return [P(x + Math.sign(qx - x) * R, y + Math.sign(qy - y) * R), P(x + Math.sign(nx - x) * R, y + Math.sign(ny - y) * R)]
  })
  const fr = [[g[0], shape(0)], [g[1], shape(R)], [back[0], shape(R)], [back[1], shape(0)]]
  const [ex, ey] = P(3, 9), [hx, hy] = P(23, 6)
  const body = `${def}${morph('s-n', fr, shape(R), ` style="stroke:var(${A1});stroke-width:2"`)}<g class="rc-c rc-s s-a">${C.map((c) => node(P(...c))).join('')}</g><g class="rc-t rc-s s-a">${tangents.map(node).join('')}</g>${pointer(r1(ex - 1), r1(ey))}${hud('rc', r1(hx + 14), r1(hy), { w: 70 }, 'rc-h rc-s')}`
  const rows = Array.from({ length: R + 1 }, (_, i) => `R ${i}.0 mm`)
  return { id: 'rc', about: 'Round corners: a sketched rectangle picked and its corners rounded to 3 mm in 1 mm steps.', css, body, readout: { rows, w: 70 } }
}

// ---------- brim ears: two corners clicked for ears, then one removed with a right click ----------
export function brimEars() {
  const FOOT = [[4, 3, 0], [20, 13, 9]]
  const ear = (cls, x, y) => {
    const d = disc(x, y, 0, 3.5)
    return `<ellipse class="${cls} s-a s-af" cx="${d.cx}" cy="${d.cy}" rx="${d.rx}" ry="${d.ry}"${st(A1, 1.6)}/>`
  }
  const pop = (name, a, b, cut) => run(name) + kf(name, [[a, `${op(0)};scale:.3`], [a + 0.2, `${op(1)};scale:1`], ...(cut ? [[b, `${op(1)};stroke:var(${A1})`], [b + 0.05, 'stroke:var(--stage-cut,#ff5555);fill:var(--stage-cut,#ff5555)'], [b + 0.3, `${op(0)};stroke:var(--stage-cut,#ff5555)`]] : [[b, op(1)], [b + 0.2, op(0)]])])
  const A = iso(20, 13, 0), B = iso(20, 3, 0)
  const d = [r1(B[0] - A[0]), r1(B[1] - A[1])]
  const css = ['.sxs .be-a,.sxs .be-b{transform-box:fill-box;transform-origin:center}', pop('be-a', 0.5, 2.2, true), pop('be-b', 1.4, 3.15, false),
    run('be-p') + kf('be-p', [[0.6, `translate:0 0;${EASE}`], [1.15, px(...d)], [1.6, `${px(...d)};${EASE}`], [2.0, 'translate:0 0']]),
    '.sxs .be-r{animation-delay:.9s}.sxs .be-q{animation-delay:1.7s;stroke:var(--stage-cut,#ff5555)}'].join('')
  const body = `${ear('be-a', 20, 13)}${ear('be-b', 20, 3)}${box(...FOOT)}<g class="be-p s-a">${pointer(A[0], A[1])}<circle class="sxs-rip be-r s-a" cx="${A[0]}" cy="${A[1]}" r="9"/><circle class="sxs-rip be-q s-a" cx="${A[0]}" cy="${A[1]}" r="9"/></g>`
  return { id: 'be', about: 'Brim ears: two corners clicked for an ear each, then the first ear removed with a right click.', css, body }
}

// ---------- move: a part dragged across the plate in 2 mm steps ----------
export function move() {
  const lo = [0, 3, 0], hi = [10, 13, 8], N = 6, drag = [0.7, 2.2], back = [3.05, 3.4]
  const moves = snaps(0, N, drag[0], drag[1])
  const dx = (v) => `${at(v * 2, 0, 0)}`
  const css = [steps('mv'), `.sxs .mv-h{animation-name:mv-h}`, rowFrames('mv-h', [[0, 0], ...moves.map((m) => [(m.t0 + m.t1) / 2, m.v1]), [back[1], 0]]),
    run('mv-x') + kf('mv-x', [[0, 'translate:0 0'], ...snapFrames(moves, dx), [back[0], `${dx(N)};${EASE}`], [back[1], 'translate:0 0']]),
    fade('mv-g', drag[0], back[0]), fade('mv-w', 0.4, drag[0] + 0.3)].join('')
  const rows = Array.from({ length: N + 1 }, (_, i) => `+${i * 2}.0 mm`)
  const [cx, cy] = iso(7, 8, 8), [wx, wy] = iso(11, 8, 4)
  const body = `<path class="mv-g s-a s-n" style="stroke:var(${T3});stroke-width:1.3;stroke-dasharray:3 2.5" d="${rel([[lo[0], lo[1], 0], [hi[0], lo[1], 0], [hi[0], hi[1], 0], [lo[0], hi[1], 0]])}"/><g class="mv-w s-a">${arrow(wx + 8, wy + 4, 120)}</g><g class="mv-x s-a">${box(lo, hi, { t: 's-lit s-a' })}${pointer(cx, cy)}${hud('mv', r1(cx + 24), r1(cy + 20), { w: 78 }, 'mv-h mv-s')}</g>`
  return { id: 'mv', about: 'Move: a part dragged across the plate in 2 mm steps, its first spot left as an outline.', css, body, readout: { rows, w: 78 } }
}

// ---------- lay on face: a standing slab tipped over onto the face that was picked ----------
export function layOnFace() {
  const X = 6, Y = 14, Z = 16, tip = [0.9, 1.75], back = [3.15, 3.45]
  // the slab turned by `a` degrees about its bottom edge at x = X, toward +x
  const rot = (a) => {
    const t = (a * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t)
    return (x, y, z) => [X + (x - X) * c + z * s, y, -(x - X) * s + z * c]
  }
  const F = {
    l: (f) => rel([f(0, Y, 0), f(X, Y, 0), f(X, Y, Z), f(0, Y, Z)]),
    t: (f) => rel([f(0, 0, Z), f(X, 0, Z), f(X, Y, Z), f(0, Y, Z)]),
    r: (f) => rel([f(X, 0, 0), f(X, Y, 0), f(X, Y, Z), f(X, 0, Z)]),
    b: (f) => rel([f(0, 0, 0), f(0, Y, 0), f(0, Y, Z), f(0, 0, Z)]),
  }
  const ang = [0, 22.5, 45, 67.5, 90]
  const fr = (k) => [...ang.map((a, i) => [tip[0] + (i / 4) * (tip[1] - tip[0]), F[k](rot(a))]), [back[0], F[k](rot(90))], [back[0] + 0.01, F[k](rot(0))]]
  // the picked face (+x) shows until the turn passes 45 degrees, the far face (-x) after
  const lit = (name, a, b) => run(name) + kf(name, [[tip[0], `fill:var(${a})`], [tip[1], `fill:var(${b})`], [back[0], `fill:var(${b})`], [back[0] + 0.01, `fill:var(${a})`]])
  const css = [steps('lf'), vis('lf-r', 0, (tip[0] + tip[1]) / 2, back[0]), vis('lf-b', (tip[0] + tip[1]) / 2, back[0]), fade('lf-p', 0.15, tip[0], 0.15), lit('lf-u', '--stage-t3,#6c7086', '--stage-t1,#d6d8e4'), lit('lf-v', '--stage-t1,#d6d8e4', '--stage-t3,#6c7086')].join('')
  const [fx, fy] = iso(X, Y / 2, Z / 2)
  const body = `<g class="lf-b lf-s s-a">${morph('lf-u s-a s-ol', fr('b'), F.b(rot(90)))}</g><g class="lf-r lf-s s-a">${morph('s-lit s-a s-ol', fr('r'), F.r(rot(0)))}</g>${morph('s-f2 s-ol', fr('l'), F.l(rot(90)))}${morph('lf-v s-a s-ol', fr('t'), F.t(rot(90)))}<g class="lf-p s-a">${pointer(r1(fx + 2), r1(fy))}</g>`
  return { id: 'lf', about: 'Lay on face: the big side of a standing slab picked, and the slab tips over to lie flat on it.', css, body }
}

// ---------- rotate: a block turned on its ring in 15 degree steps with Shift ----------
export function rotate() {
  const cx = 10, cy = 8, hx = 8, hy = 4, Z = 6, N = 2, drag = [0.7, 1.8], back = [3.1, 3.4]
  const turn = (deg) => {
    const t = (deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t)
    return (x, y, z) => [cx + x * c - y * s, cy + x * s + y * c, z]
  }
  const F = {
    l: (f) => rel([f(-hx, hy, 0), f(hx, hy, 0), f(hx, hy, Z), f(-hx, hy, Z)]),
    r: (f) => rel([f(hx, -hy, 0), f(hx, hy, 0), f(hx, hy, Z), f(hx, -hy, Z)]),
    t: (f) => rel([f(-hx, -hy, Z), f(hx, -hy, Z), f(hx, hy, Z), f(-hx, hy, Z)]),
  }
  const moves = snaps(0, N, drag[0], drag[1])
  const fr = (k) => [[drag[0], F[k](turn(0))], ...moves.flatMap((m) => [[m.t0, F[k](turn(m.v0 * 15))], [m.t1, F[k](turn(m.v1 * 15))]]), [back[0], F[k](turn(30))], [back[1], F[k](turn(0))]]
  const ring = disc(cx, cy, 0, 13)
  // the pointer rides the ring's front from 0 to 45 degrees
  const on = (deg) => {
    const t = ((deg + 45) * Math.PI) / 180
    const [x, y] = iso(cx + 13 * Math.cos(t), cy + 13 * Math.sin(t), 0)
    return [x, y]
  }
  const p0 = on(0)
  const pf = (v) => {
    const [x, y] = on(v * 15)
    return px(x - p0[0], y - p0[1])
  }
  const css = [steps('ro'), `.sxs .ro-h{animation-name:ro-h}`, rowFrames('ro-h', [[0, 0], ...moves.map((m) => [(m.t0 + m.t1) / 2, m.v1]), [back[1], 0]]),
    run('ro-p') + kf('ro-p', [[0, 'translate:0 0'], ...snapFrames(moves, pf), [back[0], `${pf(N)};${EASE}`], [back[1], 'translate:0 0']])].join('')
  const rows = Array.from({ length: N + 1 }, (_, i) => `${i * 15}°`)
  const body = `<ellipse class="s-n" cx="${ring.cx}" cy="${ring.cy}" rx="${ring.rx}" ry="${ring.ry}" style="stroke:var(${A1});stroke-width:2.4"/>${morph('s-f2 s-ol', fr('l'), F.l(turn(30)))}${morph('s-f3 s-ol', fr('r'), F.r(turn(30)))}${morph('s-f1 s-ol', fr('t'), F.t(turn(30)))}<g class="ro-p s-a">${pointer(...p0)}</g>${hud('ro', 196, 112, { key: 'Shift', w: 82 }, 'ro-h ro-s')}`
  return { id: 'ro', about: 'Rotate: a block turned by its ring with Shift held, snapping 15 degrees at a time to 30.', css, body, readout: { rows, key: 'Shift', w: 82 } }
}

// ---------- scale: a block grown from its corner handle, 100 to 150 percent ----------
export function scale() {
  const lo = [2, 2, 0], hi = [12, 10, 8], N = 2, drag = [0.7, 1.9], back = [3.1, 3.4]
  const [ox, oy] = iso(...lo), [hx, hy] = iso(hi[0], hi[1], hi[2])
  const moves = snaps(0, N, drag[0], drag[1])
  const s = (v) => 1 + v * 0.25
  const sc = (v) => `scale:${s(v)}`
  const hp = (v) => px((s(v) - 1) * (hx - ox), (s(v) - 1) * (hy - oy))
  const css = [steps('sc'), `.sxs .sc-h{animation-name:sc-h}`, rowFrames('sc-h', [[0, 0], ...moves.map((m) => [(m.t0 + m.t1) / 2, m.v1]), [back[1], 0]]),
    `.sxs .sc-b{transform-box:view-box;transform-origin:${ox}px ${oy}px}`,
    run('sc-b') + kf('sc-b', [[0, 'scale:1'], ...snapFrames(moves, sc), [back[0], `${sc(N)};${EASE}`], [back[1], 'scale:1']]),
    run('sc-p') + kf('sc-p', [[0, 'translate:0 0'], ...snapFrames(moves, hp), [back[0], `${hp(N)};${EASE}`], [back[1], 'translate:0 0']])].join('')
  const rows = Array.from({ length: N + 1 }, (_, i) => `${100 + i * 25} %`)
  const body = `<g class="sc-b s-a">${box(lo, hi)}</g><g class="sc-p s-a"><rect class="s-g1 s-aol" x="${r1(hx - 3)}" y="${r1(hy - 3)}" width="6" height="6" rx="1"/>${pointer(r1(hx + 1), r1(hy + 1))}${hud('sc', r1(hx + 24), r1(hy + 22), { w: 58 }, 'sc-h sc-s')}</g>`
  return { id: 'sc', about: 'Scale: a block grown from its corner handle, uniformly, from 100 to 150 percent in 25 percent steps.', css, body, readout: { rows, w: 58 } }
}

/** Batch 2, by the file name the export uses. */
export const LOOPS = {
  'history-suppress': historySuppress, 'history-view': historyView, 'history-earlier': historyEarlier, 'history-later': historyLater,
  'keep-dimension': keepDimension, 'mirror-x': mirrorX, 'mirror-y': mirrorY, 'mirror-z': mirrorZ, 'print-sequence': printSequence,
  'whole-loop': wholeLoop, 'drop-to-bed': dropToBed, 'round-corners': roundCorners, 'brim-ears': brimEars, move, 'lay-on-face': layOnFace,
  rotate, scale,
}
