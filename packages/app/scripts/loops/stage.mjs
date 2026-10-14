// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Authoring helpers for the tooltip stage loops: the stage's iso camera, keyframes on the 3.5 s loop, snapped steps,
// and the primitives (boxes, cylinders, discs) in the icon look. Output is plain SVG and CSS strings.
export const LOOP = 3.5
export const S = 3.5
const CX = 124, CY = 82, C30 = Math.cos(Math.PI / 6)
export const r1 = (v) => Math.round(v * 10) / 10
export const iso = (x, y, z) => [r1(CX + (x - y) * C30 * S), r1(CY + ((x + y) / 2 - z) * S)]
export const pt = (p) => iso(...p).join(',')
export const pts = (...ps) => ps.map(pt).join(' ')
export const pc = (t) => `${Math.round((Math.max(0, Math.min(LOOP, t)) / LOOP) * 1000) / 10}%`
/** Screen offset of a move by (dx, dy, dz) mm, as a CSS translate value. */
export const tr = (dx, dy, dz) => {
  const a = iso(0, 0, 0), b = iso(dx, dy, dz)
  return `${r1(b[0] - a[0])}px ${r1(b[1] - a[1])}px`
}

/** `@keyframes` from [seconds, declarations] pairs; the first value also holds 0 % and the last holds 100 %. */
export function kf(name, steps) {
  const s = [...steps].sort((a, b) => a[0] - b[0])
  let out = ''
  if (s[0][0] > 0) out += `0%{${s[0][1]}}`
  for (const [t, d] of s) out += `${pc(t)}{${d}}`
  if (s[s.length - 1][0] < LOOP) out += `100%{${s[s.length - 1][1]}}`
  return `@keyframes ${name}{${out}}`
}
/** Rules that run keyframes on a class; `step` holds each value until the next. */
export const run = (cls, name = cls, step = false) => `.sxs .${cls}{animation-name:${name}${step ? ';animation-timing-function:steps(1,end)' : ''}}`

// the drag's ease (0.65, 0, 0.35, 1) and its inverse
const by = (u) => 3 * u * u * (1 - u) + u ** 3
const bx = (u) => 3 * u * (1 - u) ** 2 * 0.65 + 3 * u * u * (1 - u) * 0.35 + u ** 3
export function when(p, a, b) {
  let lo = 0, hi = 1
  for (let i = 0; i < 40; i++) {
    const m = (lo + hi) / 2
    if (by(m) < p) lo = m
    else hi = m
  }
  return a + bx((lo + hi) / 2) * (b - a)
}
/** Whole steps from v0 to v1 over [a, b] on the drag's ease, each snapping over the first 35 % of its share. */
export function snaps(v0, v1, a, b) {
  const n = Math.abs(v1 - v0), dir = Math.sign(v1 - v0), out = []
  for (let i = 0; i < n; i++) out.push({ t0: when(i / n, a, b), t1: when((i + 0.35) / n, a, b), v0: v0 + dir * i, v1: v0 + dir * (i + 1) })
  return out
}
/** Keyframe pairs for snapped steps: `decl(v)` gives the declarations at value v. */
export const snapFrames = (moves, decl) => moves.flatMap((m) => [[m.t0, decl(m.v0)], [m.t1, decl(m.v1)]])

/** A box lit like the icons: left face (+y) f2, right face (+x) f3, top f1. `c` overrides classes per face. */
export function box([x0, y0, z0], [x1, y1, z1], c = {}) {
  const ol = c.ol ?? 's-ol'
  return `<polygon class="${c.l ?? 's-f2'} ${ol}" points="${pts([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1])}"/><polygon class="${c.r ?? 's-f3'} ${ol}" points="${pts([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1])}"/><polygon class="${c.t ?? 's-f1'} ${ol}" points="${pts([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1])}"/>`
}
export const accentBox = (lo, hi) => box(lo, hi, { l: 's-g2', r: 's-g3', t: 's-g1', ol: 's-aol' })

/** A level disc's ellipse (a circle of radius r at height z). */
export function disc(x, y, z, r) {
  const [cx, cy] = iso(x, y, z)
  return { cx, cy, rx: r1(r * Math.SQRT2 * C30 * S), ry: r1(r * Math.SQRT2 * 0.5 * S) }
}
export const ellipse = (d, cls, extra = '') => `<ellipse class="${cls}" cx="${d.cx}" cy="${d.cy}" rx="${d.rx}" ry="${d.ry}"${extra}/>`
/** A standing cylinder: the lit side band and its top. */
export function cyl(x, y, z0, z1, r, accent = false, topCls) {
  const b = disc(x, y, z0, r), t = disc(x, y, z1, r)
  const ol = accent ? 's-aol' : 's-ol'
  const side = `<path class="${accent ? 's-cya' : 's-cy'} ${ol}" d="M${r1(t.cx - t.rx)} ${t.cy}V${b.cy}A${b.rx} ${b.ry} 0 0 0 ${r1(b.cx + b.rx)} ${b.cy}V${t.cy}A${t.rx} ${t.ry} 0 0 1 ${r1(t.cx - t.rx)} ${t.cy}Z"/>`
  return side + ellipse(t, `${topCls ?? (accent ? 's-g1' : 's-f1')} ${ol}`)
}
/** A path through points (closed with z). */
export const path = (ps, close = true) => `M${ps.map(pt).join('L')}${close ? 'Z' : ''}`

/** The pointer at (x, y) px, with its press ripple `delay` s after the shared one (0.5 s). */
export const pointer = (x, y, delay = 0) =>
  `<circle class="sxs-rip s-a" cx="${x}" cy="${y}" r="9"${delay ? ` style="animation-delay:${delay}s"` : ''}/><use href="#sxs-ptr" x="${x}" y="${y}"/>`
/** The bold arrow from (x, y) px, turned `deg` clockwise from straight up. */
export const arrow = (x, y, deg = 0, cls = '') =>
  `<use${cls ? ` class="${cls} s-a"` : ''} href="#sxs-arw" ${deg ? `transform="translate(${x} ${y}) rotate(${deg})"` : `x="${x}" y="${y}"`}/>`

/** The readout pill at (x, y) px (its left edge, its middle) with the window over its rows; `slide` names the
 *  keyframes that move the rows (translate 0 -i*14px shows row i). */
export function hud(id, x, y, { key, w } = {}, slide, vis = 's-hud') {
  const width = w ?? (key ? 94 : 60)
  const wx = key ? x + 38 : x + 6
  return `<g class="${vis} s-a"><use href="#sxs-hud-${id}" x="${x}" y="${y}"/><clipPath id="${id}-hw"><rect x="${r1(wx)}" y="${r1(y - 8)}" width="${r1(width - (wx - x) - 4)}" height="16"/></clipPath><g clip-path="url(#${id}-hw)"><g class="${slide ? `${slide} s-a` : ''}"><use href="#sxs-rows-${id}" x="${x}" y="${y}"/></g></g></g>`
}
/** Row-slide keyframes: [seconds, row index] pairs. */
export const rowFrames = (name, at) => kf(name, at.map(([t, i]) => [t, `translate:0 ${-i * 14}px`]))

/** A SMIL path morph over the loop: [seconds, d] pairs, plus a still copy for reduced motion. */
export function morph(cls, frames, still, extra = '') {
  const s = [...frames].sort((a, b) => a[0] - b[0])
  if (s[0][0] > 0) s.unshift([0, s[0][1]])
  if (s[s.length - 1][0] < LOOP) s.push([LOOP, s[s.length - 1][1]])
  const kt = s.map(([t]) => Math.round((t / LOOP) * 1000) / 1000).join(';')
  const v = s.map(([, d]) => d).join(';')
  return `<path class="${cls} s-smil" d="${s[0][1]}"${extra}><animate attributeName="d" dur="${LOOP}s" repeatCount="indefinite" keyTimes="${kt}" values="${v}"/></path><path class="${cls} s-still" d="${still}"${extra}/>`
}

/** The module text for one loop. */
export function moduleText({ id, about, css, body, badge, readout }) {
  const fields = [`  id: '${id}',`]
  if (badge) fields.push(`  badge: ${JSON.stringify(badge).replace(/"(\w+)":/g, '$1: ')},`)
  if (readout) fields.push(`  readout: ${JSON.stringify(readout).replace(/"(\w+)":/g, '$1: ')},`)
  fields.push(`  css: ${JSON.stringify(css)},`, `  body: ${JSON.stringify(body.replace(/\n\s*/g, ''))},`)
  return `// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// ${about}
import type { StageTool } from '@slicerx/ui'

export const loop: StageTool = {
${fields.join('\n')}
}
`
}
