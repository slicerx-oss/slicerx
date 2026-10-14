// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Shared helpers for the loop batches: compact relative paths, stepped and drawn-in keyframes, theme colors and the
// time bar. Built on stage.mjs.
import { hud, iso, kf, r1, rowFrames, run } from './stage.mjs'

export const op = (v) => `opacity:${v}`
export const num = (v) => String(r1(v)).replace(/^(-?)0\./, '$1.')
export const join = (ns) => ns.map(num).reduce((s, n, i) => s + (i && !n.startsWith('-') ? ' ' : '') + n, '')
/** A relative path through mm points: one absolute move, then deltas. */
export function rel(ps, close = true) {
  const q = ps.map((p) => iso(...p))
  const d = []
  for (let i = 1; i < q.length; i++) d.push(r1(q[i][0] - q[i - 1][0]), r1(q[i][1] - q[i - 1][1]))
  return `M${join(q[0])}l${join(d)}${close ? 'z' : ''}`
}
/** Stepped visibility: on over [a, b), plus from `again` to the end when given. */
export const vis = (name, a, b, again) => {
  const f = [[0, op(a <= 0 ? 1 : 0)]]
  if (a > 0) f.push([a, op(1)])
  f.push([b, op(0)])
  if (again !== undefined) f.push([again, op(1)])
  return `.sxs .${name}{animation-name:${name}}` + kf(name, f)
}
/** Line drawn in over [a, b], held, faded at `out`. */
export const draw = (name, a, b, out = 3.2) => run(name) + kf(name, [[a, 'stroke-dashoffset:100;opacity:0'], [a + 0.04, 'stroke-dashoffset:96;opacity:1'], [b, 'stroke-dashoffset:0'], [out, op(1)], [out + 0.2, op(0)]])
export const fade = (name, a, b, f = 0.2) => run(name) + kf(name, [[a - f, op(0)], [a, op(1)], [b, op(1)], [b + f, op(0)]])
export const st = (c, w) => ` style="stroke:var(${c});stroke-width:${w}"`
export const A1 = '--stage-a1,#c9a6fb', T2 = '--stage-t2,#9da1b6', T3 = '--stage-t3,#6c7086', CUT = '--stage-cut,#ff5555'
/** Three states over the loop, back to the first at the end. */
export const T3S = [0, 1.1, 2.2, 3.3]
/** Stepped timing for every vis() class of a loop and its readout rows. */
export const steps = (id) => `.sxs .${id}-s{animation-timing-function:steps(1,end)}`
export const rows3 = (id) => `.sxs .${id}-h{animation-name:${id}-h}` + rowFrames(`${id}-h`, [[0, 0], [T3S[1], 1], [T3S[2], 2], [T3S[3], 0]])

/** The time bar: a pill with a clock and a bar whose fill steps to each [seconds, share] pair. */
export function timebar(id, x, y, steps) {
  const css = `.sxs .${id}-t{transform-box:fill-box;transform-origin:left;animation-name:${id}-t;animation-timing-function:cubic-bezier(.65,0,.35,1)}` + kf(`${id}-t`, steps.map(([t, s]) => [t, `scale:${s} 1`]))
  const svg = `<g transform="translate(${x} ${y})"><rect class="sxs-pill" x="0" y="-7" width="64" height="14" rx="7"/><g style="fill:none;stroke:var(--stage-pill-text,#f8f8f2);stroke-width:1.2"><circle cx="9" r="3.6"/><path d="M9-1.8V0h1.6"/></g><rect x="17" y="-2" width="40" height="4" rx="2" style="fill:rgb(255 255 255/.18)"/><rect class="${id}-t s-a" x="17" y="-2" width="40" height="4" rx="2" style="fill:var(${A1})"/></g>`
  return { css, svg }
}


/** Two states: A over [0, t), B over [t, 3.3), back to A. */
export const TWO = [0, 1.6, 3.3]
/** The readout rows stepping with TWO. */
export const rows2 = (id, t = TWO) => `.sxs .${id}-h{animation-name:${id}-h}` + rowFrames(`${id}-h`, [[0, 0], [t[1], 1], [t[2], 0]])
/** Stepped CSS for two still states, A then B. */
export const twoCss = (id, t = TWO) => [steps(id), vis(`${id}-a`, 0, t[1], t[2]), vis(`${id}-b`, t[1], t[2])].join('')
/** One state's group: `${id}-${k}`, stepped. */
export const stateG = (id, k, inner) => `<g class="${id}-${k} ${id}-s s-a">${inner}</g>`
/** A polygon through mm points. */
export const poly = (cls, ps, extra = '') => `<polygon class="${cls}" points="${ps.map((q) => iso(...q).join(',')).join(' ')}"${extra}/>`
/** A stroked path with no fill. */
export const bead = (cls, d, c = A1, w = 2.6, extra = '') => `<path class="${cls}${cls ? ' s-a ' : ''}s-n" style="stroke:var(${c});stroke-width:${w}${extra}" d="${d}"/>`
/** The readout pill (stepped with the loop's states) at (x, y). */
export const pill = (id, x, y, w) => hud(id, r1(x), r1(y), { w }, `${id}-h ${id}-s`, '')
/** Time bar steps between two shares on TWO. */
export const timeTwo = (a, b, t = TWO) => [[0, a], [t[1] - 0.05, a], [t[1] + 0.3, b], [t[2] - 0.05, b], [t[2] + 0.15, a]]
