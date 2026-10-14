// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Stills, second batch: support and bridge line widths on the Slice tab, and the Model tab's structure: the model
// tree, the timeline marker, the pick kinds, the sketch status, named values, hollow, repair and measure. Nothing
// moves; values sit in pills, as in the first batch.
import { accentBox, box, iso } from './stage.mjs'
import { A1, CUT, rel, st, T2 } from './kit.mjs'
import { beads, face, lead, rowAt, still, strokes, tag, xBracket, zBracket } from './stills1.mjs'

const pts = (ps) => ps.map((q) => iso(...q).join(',')).join(' ')
const poly = (cls, ps, extra = '') => `<polygon class="${cls}" points="${pts(ps)}"${extra}/>`
/** A pill's width for its text, as `tag` draws it. */
const pw = (text) => Math.round(text.length * 6.1 + 18)
/** A bracket across one line on a section plane `P` (u, z), from ua to ub at height z, its ticks reaching into the
 *  line below it (or above, `up`), over a dark halo. */
const bracket = (P, ua, ub, z, up) => {
  const o = up ? -0.6 : 0.6, t = up ? 0.9 : -0.9
  const d = `M${P(ua, z + t).join(' ')}L${P(ua, z + o).join(' ')}L${P(ub, z + o).join(' ')}L${P(ub, z + t).join(' ')}`
  return `<path class="s-n"${st('--stage-ol', 3.4)} d="${d}"/><path class="s-n"${st(A1, 1.4)} d="${d}"/>`
}
const hole = (P, u0, u1, z0, z1) => `<polygon class="s-hole" points="${[P(u0, z0), P(u1, z0), P(u1, z1), P(u0, z1)].map((q) => q.join(',')).join(' ')}"/>`

// ---------- support line width: a section through support under a ledge, one support line bracketed ----------
// 7 mm of drawing per mm of print, as the first batch's line widths
function supportWidth(id, about) {
  const k = 7, H = 1.6, X0 = -10, X = 40, D = 4, gap = 0.2, wo = 0.42 * k, wi = 0.45 * k, ws = 0.42 * k
  const P = (u, z) => iso(X0 + u, D, z)
  const lo = wo + 2 * (wi + gap), sx = lo + 0.35 * k, sx1 = X - 1.2
  // the part: a wall on the left and a ledge over the support, its lines closed up
  const wall = [], ledge = [], sup = []
  for (let L = 0; L < 6; L++) wall.push([X0, L * H, 1, 0, wo, H], [X0 + wo + gap, L * H, 2, wi + gap, wi, H])
  for (let L = 6; L < 8; L++) { const c = Math.round((X + gap) / (ws + gap)); ledge.push([X0, L * H, c, (X - ws) / (c - 1), ws, H]) }
  // support lines stand in columns, one layer short of the ledge: that layer is the top Z gap
  const sc = 6, sp = (sx1 - sx - ws) / (sc - 1)
  for (let L = 0; L < 5; L++) sup.push([X0 + sx, L * H, sc, sp, ws, H])
  const sec = hole(P, 0, lo, 0, 6 * H) + hole(P, 0, X, 6 * H, 8 * H) + hole(P, sx, sx1, 0, 5 * H)
  const body = box([X0 + sx, -D, 0], [X0 + sx1, D, 5 * H], { l: 's-af', r: 's-af', t: 's-af', ol: 's-al' }) + box([X0, -D, 0], [X0 + lo, D, 6 * H]) + box([X0, -D, 6 * H], [X0 + X, D, 8 * H])
  const xa = X0 + sx + 5 * sp, z = 4 * H
  const lines = beads(wall, D, false) + beads(ledge, D, false) + beads(sup, D, true)
  return still(id, about, body + sec + lines + xBracket(xa, xa + ws, D, z + H, false) + lead([xa + ws / 2, D, z + H + 0.6], 226, 140) + tag(226, 140, '0.42 mm'))
}

// ---------- bridge line width: a deck bridged between two pillars, cut across so its lines show end on ----------
function bridgeWidth(id, about) {
  const k = 7, H = 1.6, XA = -4, XR = 14, W = 14, gap = 0.2, wb = 0.4 * k, w = 0.42 * k, Pw = 2 * w + gap
  // the section is the right face, x = XR; u runs along y
  const P = (u, z) => iso(XR, u, z)
  const pil = [], deck = [], top = []
  for (let L = 0; L < 5; L++) pil.push([-W, L * H, 2, w + gap, w, H], [W - Pw, L * H, 2, w + gap, w, H])
  const cb = Math.round((2 * W + gap) / (wb + gap)), cw = Math.round((2 * W + gap) / (w + gap))
  deck.push([-W, 5 * H, cb, (2 * W - wb) / (cb - 1), wb, H])
  top.push([-W, 6 * H, cw, (2 * W - w) / (cw - 1), w, H])
  const body = box([XA, -W, 0], [XR, -W + Pw, 5 * H]) + box([XA, W - Pw, 0], [XR, W, 5 * H]) + box([XA, -W, 5 * H], [XR, W, 7 * H])
  const sec = hole(P, -W, -W + Pw, 0, 5 * H) + hole(P, W - Pw, W, 0, 5 * H) + hole(P, -W, W, 5 * H, 7 * H)
  // the line bracketed hangs over the middle of the gap, so its bracket sits under it in the open
  const [u0, , n, pitch] = deck[0], ua = u0 + Math.floor(n / 2) * pitch
  const lines = beads(pil, 0, false, P) + beads(top, 0, false, P) + beads(deck, 0, true, P)
  const [mx, my] = P(ua + wb / 2, 5 * H - 0.6)
  return still(id, about, body + sec + lines + bracket(P, ua, ua + wb, 5 * H, true) + `<path class="s-n"${st(A1, 1.2)} d="M${mx} ${my}L222 140"/>` + tag(222, 140, '0.40 mm'))
}

// ---------- model tree: the tree beside the view, a line from each entry to what it names ----------
function modelTree(id, about) {
  const rows = [['Sketches', 52, 0], ['Sketch 1', 72, 1], ['Bodies', 100, 0], ['Body 1', 120, 1]]
  let panel = `<rect class="sxs-pill" x="10" y="36" width="84" height="98" rx="8"/>`
  for (const [t, y, d] of rows) panel += `<text x="${20 + d * 12}" y="${y + 3.7}"${d ? '' : ' style="opacity:.6"'}>${t}</text>`
  // the sketch lies on the plate; the body stands beside it
  const sk = [[10, -16, 0], [22, -16, 0], [22, -6, 0], [10, -6, 0]]
  const sketch = `<path class="s-n"${st(A1, 2)} d="${rel(sk)}"/>` + sk.map((p) => { const [x, y] = iso(...p); return `<rect x="${x - 1.5}" y="${y - 1.5}" width="3" height="3" style="fill:var(--stage-t1);stroke:var(--stage-ol);stroke-width:.8"/>` }).join('')
  const body = box([8, 6, 0], [18, 16, 6])
  const toS = iso(10, -6, 0), toB = iso(13, 16, 3)
  return still(id, about, sketch + body + `<path class="s-n"${st(A1, 1.2)} d="M88 72L${toS.join(' ')}M78 120L${toB.join(' ')}"/>` + panel)
}

// ---------- timeline: steps in order, the marker after the second, the steps after it grayed ----------
function timeline(id, about) {
  const chips = ['Sketch', 'Extrude', 'Fillet', 'Shell']
  let x = 28, out = '', mx = 0
  const xs = []
  chips.forEach((t, i) => {
    if (i === 2) { mx = x + 2; x += 12 }
    xs.push(x)
    const pill = tag(x, 146, t)
    out += i >= 2 ? `<g style="opacity:.4">${pill}</g>` : pill
    x += pw(t) + 8
  })
  // the sketch feeds the extrude that uses it; the marker rolls the part back to just after the extrude
  const a = xs[0] + pw(chips[0]) / 2, b = xs[1] + pw(chips[1]) / 2
  const feed = `<path class="s-n"${st(A1, 1.2)} d="M${a} 137C${a} 124 ${b} 124 ${b} 134"/><path class="s-n"${st(A1, 1.2)} d="M${b - 3} 131L${b} 135L${b + 3} 131"/>`
  const marker = `<path class="s-n"${st('--stage-ol', 4)} d="M${mx} 130V160"/><path class="s-n"${st(A1, 2)} d="M${mx} 130V160"/><path style="fill:var(${A1});stroke:var(--stage-ol);stroke-width:1" d="M${mx - 5} 126H${mx + 5}L${mx} 132Z"/>`
  const part = box([-6, -10, 0], [14, 4, 10])
  return still(id, about, part + feed + out + marker)
}

// ---------- pick kinds: one part three times, each with what its pick kind lights ----------
function pickKinds(id, kind, about) {
  const T = 11, h = 8, pos = rowAt(3, T, 86, 2)
  const kinds = [['object', 'Objects'], ['face', 'Faces'], ['edge', 'Edges']]
  let body = ''
  kinds.forEach(([k, label], i) => {
    const [x, y] = pos[i], lo = [x, y, 0], hi = [x + T, y + T, h], e = rel([[x, y + T, h], [x + T, y + T, h]], false)
    const lit = { object: accentBox(lo, hi), face: poly('s-g1 s-aol', [[x, y, h], [x + T, y, h], [x + T, y + T, h], [x, y + T, h]]), edge: `<path class="s-n"${st('--stage-aol', 5.5)} d="${e}"/><path class="s-n"${st(A1, 3.5)} d="${e}"/>` }[k]
    const [cx] = iso(x + T, y + T, 0), pill = tag(cx - pw(label) / 2, 150, label)
    // the row's own kind is lit in full; the others keep their part and show what they light faintly
    body += box(lo, hi) + (k === kind ? lit + pill : `<g style="opacity:.35">${lit}${pill}</g>`)
  })
  return still(id, about, body)
}

// ---------- sketch status: a sketch with its constraint glyphs, and the status line in its three tones ----------
const GLYPH = {
  Horizontal: 'M-4 0H4',
  Vertical: 'M0 -4V4',
  Perpendicular: 'M-4 4H4M0 4V-4',
  Concentric: 'M-1.6 0A1.6 1.6 0 1 0 1.6 0A1.6 1.6 0 1 0 -1.6 0M-3.6 0A3.6 3.6 0 1 0 3.6 0A3.6 3.6 0 1 0 -3.6 0',
}
const glyph = (x, y, k) => `<g transform="translate(${x} ${y})"><rect class="sxs-pill" x="-7" y="-7" width="14" height="14" rx="3"/><path class="s-n" style="stroke:var(--stage-pill-text);stroke-width:1.3" d="${GLYPH[k]}"/></g>`
function sketchStatus(id, about) {
  const [x0, y0, x1, y1] = [26, 22, 132, 82], cx = 102, cy = 52
  const node = (x, y) => `<rect x="${x - 1.5}" y="${y - 1.5}" width="3" height="3" style="fill:var(--stage-t1);stroke:var(--stage-ol);stroke-width:.8"/>`
  let body = `<path class="s-n"${st(A1, 2)} d="M${x0} ${y0}H${x1}V${y1}H${x0}ZM${cx - 9} ${cy}A9 9 0 1 0 ${cx + 9} ${cy}A9 9 0 1 0 ${cx - 9} ${cy}M${cx - 16} ${cy}A16 16 0 1 0 ${cx + 16} ${cy}A16 16 0 1 0 ${cx - 16} ${cy}"/>`
  body += [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [cx, cy]].map(([x, y]) => node(x, y)).join('')
  // each glyph sits by what it holds; the legend names them
  body += glyph(58, y0 - 10, 'Horizontal') + glyph(x1 + 10, 40, 'Vertical') + glyph(x0 + 10, y1 - 10, 'Perpendicular') + glyph(cx, cy, 'Concentric')
  Object.keys(GLYPH).forEach((k, i) => { body += glyph(176, 22 + i * 21, k) + tag(188, 22 + i * 21, k) })
  // the status line: open, done and over-constrained
  const tones = [['2 degrees of freedom left', T2], ['Fully constrained', '--green,#50fa7b'], ['Over-constrained', '--orange,#ffb86c']]
  tones.forEach(([t, c], i) => {
    const y = 110 + i * 21, w = pw(t) + 12
    body += `<rect class="sxs-pill" x="26" y="${y - 9}" width="${w}" height="18" rx="9"/><circle cx="36" cy="${y}" r="3.5" style="fill:var(${c})"/><text x="45" y="${y + 3.7}">${t}</text>`
  })
  return still(id, about, body)
}

// ---------- named values: a value, the same name in a distance field, and the size it drives ----------
function namedValues(id, about) {
  const lo = [4, -10, 0], hi = [22, 4, 8]
  const part = box(lo, hi) + accentBox([4, -10, 8], [22, 4, 10.5])
  const [bx, D] = [22 + 1.6, 4]
  const [mx, my] = iso(bx, D, 9.25)
  const field = `<rect class="sxs-pill" x="18" y="${92 - 9}" width="${pw('Distance = wall')}" height="18" rx="9" style="stroke:var(${A1})"/><text x="27" y="${92 + 3.7}">Distance = wall</text>`
  const link = `<path class="s-n"${st(A1, 1.2)} d="M50 49C50 66 50 70 50 81"/><path class="s-n"${st(A1, 1.2)} d="M47 78L50 82L53 78"/>`
  return still(id, about, part + zBracket(bx, D, 8, 10.5) + tag(18, 40, 'wall = 2.5 mm') + link + field + `<path class="s-n"${st(A1, 1.2)} d="M${18 + pw('Distance = wall')} 92L${mx} ${my}"/>`)
}

// ---------- hollow: a section of a hollowed part, its even wall dimensioned ----------
function hollow(id, about) {
  const X0 = -14, X = 28, D = 5, Z = 13, t = 2
  const P = (u, z) => iso(X0 + u, D, z)
  const sec = `<path style="fill:var(--stage-t1);stroke:var(--stage-ol);stroke-width:1.4" d="M${[P(0, 0), P(X, 0), P(X, Z), P(0, Z)].map((q) => q.join(' ')).join('L')}Z"/>` + hole(P, t, X - t, t, Z - t)
  const body = box([X0, -D, 0], [X0 + X, D, Z], { l: 's-f3' }) + sec
  const zw = Z / 2
  const wallB = xBracket(X0 + X - t, X0 + X, D, zw, false)
  return still(id, about, body + wallB + lead([X0 + X - t / 2, D, zw + 0.6], 226, 46) + tag(226, 46, '2 mm'))
}

// ---------- repair: the same mesh before and after, its open edges and flipped face marked ----------
function repair(id, about) {
  const T = 10, h = 9, pos = rowAt(2, T, 160, 2)
  let body = ''
  pos.forEach(([x, y], i) => {
    const c = (a, b, z) => [x + a * T, y + b * T, z * h]
    // the triangles: one diagonal on each visible face
    const wire = rel([c(0, 1, 0), c(1, 1, 1)], false) + rel([c(1, 0, 0), c(1, 1, 1)], false) + rel([c(0, 0, 1), c(1, 1, 1)], false)
    body += box(c(0, 0, 0), c(1, 1, 1)) + `<path class="s-wire" style="stroke-opacity:.9" d="${wire}"/>`
    const gap = [c(0, 0, 1), c(1, 0, 1), c(1, 1, 1)], flip = [c(1, 0, 0), c(1, 1, 0), c(1, 1, 1)]
    if (i === 0) body += poly('s-hole', gap) + `<path class="s-n"${st(CUT, 1.8)} d="${rel(gap)}"/>` + poly('s-cf s-cl', flip)
    else body += poly('s-af s-al', gap, ' style="stroke-width:1.2"')
    const [cx] = iso(...c(1, 1, 0)), t = i ? 'After' : 'Before'
    body += tag(cx - pw(t) / 2, 152, t)
  })
  // the open edges and the flipped face, named in the space between the two
  const [x, y] = pos[0], [gx, gy] = iso(x + T * 0.66, y + T * 0.33, h), [fx, fy] = iso(x + T, y + T * 0.66, h * 0.33)
  body += `<path class="s-n"${st(A1, 1.2)} d="M${gx} ${gy}L112 56M${fx} ${fy}L112 98"/>` + tag(112, 56, 'Open edges') + tag(112, 98, 'Flipped face')
  return still(id, about, body)
}

// ---------- measure: two picks on a part, the distance between them and how far apart along X, Y and Z ----------
function measure(id, about) {
  const [x0, y0, x1, y1, Z] = [-4, -2, 16, 8, 9]
  // from the top's back corner to the bottom's front corner; the legs run along the edges, X, then Y, then Z
  const p1 = [x0, y0, Z], a = [x1, y0, Z], b = [x1, y1, Z], p2 = [x1, y1, 0]
  const legs = `<path class="s-n"${st('--stage-aol', 4)} d="${rel([p1, a, b, p2], false)}"/><path class="s-n"${st(A1, 2)} d="${rel([p1, a, b, p2], false)}"/>`
  const diag = `<path class="s-n" style="stroke:var(${A1});stroke-width:1.4;stroke-dasharray:4 3" d="${rel([p1, p2], false)}"/>`
  const pin = (p, n) => { const [x, y] = iso(...p); return `<circle cx="${x}" cy="${y}" r="7" style="fill:var(--stage-pill);stroke:var(${A1});stroke-width:1.4"/><text x="${x - 3}" y="${y + 3.7}">${n}</text>` }
  const mid = (p, q) => iso(...p.map((v, i) => (v + q[i]) / 2))
  const [ax, ay] = mid(p1, a), [bx, by] = mid(a, b), [zx, zy] = mid(b, p2), [dx, dy] = mid(p1, p2)
  const pills = tag(ax + 10, ay - 20, 'X 20 mm') + tag(bx + 14, by, 'Y 10 mm') + tag(zx + 12, zy + 12, 'Z 9 mm') + tag(12, 140, 'Distance 24.10 mm')
  const leads = `<path class="s-n"${st(A1, 1.2)} d="M${dx} ${dy}L${12 + pw('Distance 24.10 mm')} 140"/>`
  return still(id, about, box([x0, y0, 0], [x1, y1, Z]) + legs + diag + pin(p1, 1) + pin(p2, 2) + leads + pills)
}

/** The second batch of stills, by the file name the export uses: [name, tip sentence, drawing]. */
export const STILLS = {
  'still-line-width-support': ['Support line width', 'The support lines, picked out under a ledge, print at the default width when this is 0, here 0.42 mm.', (about) => supportWidth('ulwp', about)],
  'still-line-width-bridge': ['Bridge line width', 'The bridge lines over the gap, seen end on, print 0.40 mm wide, 100% of a 0.4 mm nozzle.', (about) => bridgeWidth('ulwb', about)],
  'still-model-tree': ['Model tree', 'Each entry in the tree is one thing in the view: a sketch lies on its plane, a body stands on the plate.', (about) => modelTree('umtr', about)],
  'still-timeline': ['Timeline marker', 'Steps run left to right. Move the marker back and the part shows as it was there; the steps after it are grayed.', (about) => timeline('umtl', about)],
  'still-pick-object': ['Objects', 'Picking objects takes the whole part.', (about) => pickKinds('upko', 'object', about)],
  'still-pick-face': ['Faces', 'Picking faces takes one face of the part.', (about) => pickKinds('upkf', 'face', about)],
  'still-pick-edge': ['Edges', 'Picking edges takes one edge, where two faces meet.', (about) => pickKinds('upke', 'edge', about)],
  'still-sketch-status': ['Sketch status', 'Constraint glyphs sit by the lines they hold. The status line says how much of the sketch can still move.', (about) => sketchStatus('usks', about)],
  'still-named-values': ['Named values', 'Name a value once, type its name in a size such as a push and pull distance, and the part follows when the value changes.', (about) => namedValues('unvl', about)],
  'still-hollow': ['Hollow', 'Hollowing empties the inside and leaves an even wall all around, here 2 mm, which saves material and print time.', (about) => hollow('uhol', about)],
  'still-repair': ['Repair mesh', 'Repair closes open edges and turns flipped faces to point outward, so the mesh slices as a closed solid.', (about) => repair('urep', about)],
  'still-measure': ['Measure', 'Pick two places: the panel gives the distance between them and how far apart they are along X, Y and Z.', (about) => measure('umea', about)],
}
export const LOOPS = Object.fromEntries(Object.entries(STILLS).map(([f, [name, tip, make]]) => [f, () => make(`${name}: ${tip[0].toLowerCase()}${tip.slice(1)}`)]))
