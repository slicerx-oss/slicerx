// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Preview legend markers: two small towers of wall loops with a travel between them. Each loop turns its own marker
// kind on over the toolpaths, as its legend box does; the other kinds stay as faint dots. Loop ids start with "p".
import { hud, iso, kf, r1, rowFrames } from './stage.mjs'

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
const st = (c, w, extra = '') => ` style="stroke:var(${c});stroke-width:${w}${extra}"`
const A1 = '--stage-a1,#c9a6fb', T1 = '--stage-t1,#d6d8e4', T2 = '--stage-t2,#9da1b6', T3 = '--stage-t3,#6c7086', OL = '--stage-ol,#1a1b24'

// layers of the two towers, bottom to top
const Z = Array.from({ length: 7 }, (_, k) => 0.4 + k * 1.8)
const TOP = Z.at(-1)
const square = (x0, y0, x1, y1, z) => [[x0, y1, z], [x0, y0, z], [x1, y0, z], [x1, y1, z]]
// each layer is an outer and an inner wall loop
const A = (z) => rel(square(-6, 0, 6, 12, z)) + rel(square(-4.8, 1.2, 4.8, 10.8, z)), B = (z) => rel(square(13, -8, 25, 4, z)) + rel(square(14.2, -6.8, 23.8, 2.8, z))
const BASE = `<path class="s-n"${st(T3, 1.5)} d="${Z.slice(0, -1).map((z) => A(z) + B(z)).join('')}"/>`
  + `<path class="s-n"${st(T2, 2)} d="${A(TOP) + B(TOP)}"/>`
  + `<path class="s-n"${st(T2, 1.2, ';stroke-dasharray:2.5 2.5')} d="${rel([[6, 4, TOP], [9.5, 2, TOP + 1.2], [13, 0, TOP]], false)}"/>`

// where each kind sits, in mm, and its legend shape
const KINDS = {
  retractions: { shape: 'disc', at: Z.map((z) => [6, 4, z]) },
  seams: { shape: 'disc', at: Z.flatMap((z) => [[-6, 12, z], [13, 4, z]]) },
  lifts: { shape: 'disc', at: Z.map((z) => [9.5, 2, z + 0.9]) },
  wipes: { shape: 'diamond', at: Z.map((z) => [6, 7, z]) },
  toolChanges: { shape: 'square', at: [2, 5].flatMap((k) => [[0, 12, Z[k]], [19, 4, Z[k]]]) },
  pauses: { shape: 'square', at: [[-6, 6, Z[4]]] },
}
/** One marker glyph at a mm point, `r` px from its center to its edge. */
function glyph(shape, p, r, extra) {
  const [x, y] = iso(...p)
  if (shape === 'disc') return `<circle cx="${x}" cy="${y}" r="${r}"${extra}/>`
  if (shape === 'square') return `<rect x="${r1(x - r)}" y="${r1(y - r)}" width="${r1(2 * r)}" height="${r1(2 * r)}"${extra}/>`
  const d = r1(r * 1.3)
  return `<path d="M${x} ${r1(y - d)}l${d} ${d}l${-d} ${d}l${-d} ${-d}z"${extra}/>`
}
const faint = (kind) => KINDS[kind].at.map((p) => glyph(KINDS[kind].shape, p, 1.4, '')).join('')

// off until 1.75 s, then the kind's markers pop in one after another, bottom layer first, and hold to the loop's end
const ON = 1.75, OFF = 3.4
function markers(kind, id) {
  const k = KINDS[kind]
  // one pop per layer, so a layer's markers share their keyframes
  const layers = [...new Set(k.at.map((p) => p[2]))].sort((a, b) => a - b)
  const look = ` style="fill:var(${A1});stroke:var(${OL});stroke-width:.9"`
  let css = `.sxs .${id}-m{transform-box:fill-box;transform-origin:center}`
  layers.forEach((z, i) => {
    const t = ON + (i / layers.length) * 0.5
    css += `.sxs .${id}-m${i}{animation-name:${id}-m${i}}` + kf(`${id}-m${i}`, [[t, `${op(0)};scale:.2`], [t + 0.12, `${op(1)};scale:1.35`], [t + 0.26, 'scale:1'], [OFF, op(1)], [OFF + 0.08, op(0)]])
  })
  const body = k.at.map((p) => glyph(k.shape, p, kind === 'pauses' ? 3.4 : 2.7, ` class="${id}-m ${id}-m${layers.indexOf(p[2])} s-a"${look}`)).join('')
  return { css, body }
}

function loop(kind, id, about) {
  const m = markers(kind, id)
  const others = `<g style="fill:var(${T3})">${Object.keys(KINDS).filter((k) => k !== kind).map(faint).join('')}</g>`
  const rows = `.${id}-h{animation-name:${id}-h;animation-timing-function:steps(1,end)}` + rowFrames(`${id}-h`, [[0, 0], [ON, 1], [OFF + 0.05, 0]])
  return { id, about, css: m.css + rows, body: BASE + others + m.body + hud(id, 212, 40, { w: 64 }, `${id}-h`, ''), readout: { rows: ['Off', 'On'], w: 64 } }
}

export const LOOPS = {
  'preview-markers-retractions': () => loop('retractions', 'pmr', 'Retractions: where the filament pulls back before a travel.'),
  'preview-markers-seams': () => loop('seams', 'pms', 'Seams: where each wall loop starts and ends.'),
  'preview-markers-z-hops': () => loop('lifts', 'pmz', 'Z hops: where the nozzle lifts before a travel.'),
  'preview-markers-wipes': () => loop('wipes', 'pmw', 'Wipes: where the nozzle wipes along the path after a retraction.'),
  'preview-markers-tool-changes': () => loop('toolChanges', 'pmt', 'Tool changes: where the printer changes to another filament or tool.'),
  'preview-markers-pauses': () => loop('pauses', 'pmp', 'Pauses: where the print pauses and waits for you.'),
}
