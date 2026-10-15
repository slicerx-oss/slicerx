// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The tooltip stage: one animated SVG for every tool's loop. The stage owns the iso floor grid, the pointer and its
// click ripple, the distance pill, the add and cut badge and the 3.5 s timeline; a tool brings only its own shapes
// and keyframes. Plain CSS and SVG, no script: colors come from the app's tokens, so dark, light and a custom
// viewport all work from the one file. The ground stays transparent; the tooltip paints the viewport behind it.

/** The stage's size in px, drawn 1:1 in the tooltip. */
export const STAGE_W = 296
export const STAGE_H = 166
/** One loop, in seconds. */
export const STAGE_LOOP = 3.5
/** The frame shown under reduced motion: the step done, before it reverses. */
export const STAGE_STILL = 1.6

/** One tool's loop on the stage. Class names and ids start with `id`. */
export interface StageTool {
  id: string
  /** The tool's keyframes and the rules that use them; each animated element also takes the class `a`. */
  css: string
  /** The tool's shapes, drawn over the floor grid and under the badge. */
  body: string
  /** What the step does: "+ Add" from `add` seconds, "− Cut" from `cut` seconds (the add ends there), both to 3.2 s. */
  badge?: { add?: number; cut?: number }
  /** A readout pill whose window slides over `rows` (top to bottom, `STAGE_ROW` px apart): rows from `cutFrom` on are
   *  in the cut color, `key` draws a keycap before them, `w` is the pill's width. */
  readout?: { rows: readonly string[]; cutFrom?: number; key?: string; w?: number }
}

/** The readout's row pitch in px. */
export const STAGE_ROW = 14

/** The fixed isometric camera, mm (x right and toward the viewer, y left and toward the viewer, z up) to stage px. */
export const STAGE_ISO = { cx: 124, cy: 82, s: 3.5 }
const C30 = Math.cos(Math.PI / 6)
export function isoPt(x: number, y: number, z: number): [number, number] {
  const { cx, cy, s } = STAGE_ISO
  return [round(cx + (x - y) * C30 * s), round(cy + ((x + y) / 2 - z) * s)]
}
const round = (v: number) => Math.round(v * 10) / 10

/** Keyframe percent for a time in the loop. */
export const pc = (t: number) => `${Math.round((t / STAGE_LOOP) * 10000) / 100}%`

// the floor grid: 4 mm squares at z 0, faded out toward the edges
function grid(): string {
  let d = ''
  for (let x = -8; x <= 40; x += 4) d += `M${isoPt(x, -8, 0).join(' ')}L${isoPt(x, 28, 0).join(' ')}`
  for (let y = -8; y <= 28; y += 4) d += `M${isoPt(-8, y, 0).join(' ')}L${isoPt(40, y, 0).join(' ')}`
  return `<path class="sxs-grid" d="${d}" mask="url(#sxs-fade)"/>`
}

const POINTER = 'M2 1.5v14.2l3.9-3.5 2.6 6 2.5-1.1-2.6-5.9 5.3-.4L2 1.5Z'

// SMIL drives the path morphs (WKWebView does not animate CSS d); under reduced motion an s-still copy stands in for
// each s-smil shape, since CSS cannot pause SMIL
// rules for shapes inside <use> clones match on their own class only, never on .sxs ancestry
const CSS = `.sxs{overflow:visible}
:where(.sxs .s-a){animation-duration:${STAGE_LOOP}s;animation-iteration-count:infinite;animation-timing-function:linear;animation-fill-mode:both}
.sxs polygon,.sxs path,.sxs polyline,.sxs rect{stroke-linejoin:round;stroke-linecap:round;vector-effect:non-scaling-stroke}
.sxs .s-f1{fill:var(--stage-t1)}.sxs .s-f2{fill:var(--stage-t2)}.sxs .s-f3{fill:var(--stage-t3)}
.sxs .s-g1{fill:var(--stage-a1)}.sxs .s-g2{fill:var(--stage-a2)}.sxs .s-g3{fill:var(--stage-a3)}
.sxs .s-ol{stroke:var(--stage-ol);stroke-width:1.4}.sxs .s-aol{stroke:var(--stage-aol);stroke-width:1.4}
.sxs .s-cf{fill:var(--stage-cut);fill-opacity:.2}.sxs .s-af{fill:var(--stage-a1);fill-opacity:.28}.sxs .s-cl{stroke:var(--stage-cut);stroke-width:1.4}.sxs .s-al{stroke:var(--stage-a1);stroke-width:2}
.sxs .s-n{fill:none}.sxs .s-hole{fill:var(--stage-ol);fill-opacity:.85}.sxs .s-wire{fill:none;stroke:var(--stage-ol);stroke-width:.8;stroke-opacity:.55}.sxs .s-cy{fill:url(#sxs-cy)}.sxs .s-cya{fill:url(#sxs-cya)}
.sxs .s-still{display:none}
.sxs .s-ghost{fill:none;stroke:var(--stage-cut);stroke-width:1.3;stroke-dasharray:3 2.5}
.sxs-grid{fill:none;stroke:var(--stage-grid,var(--scene-grid,var(--stage-grid-fallback)));stroke-width:1;opacity:.55}
.sxs-ptr{fill:var(--stage-ptr);stroke:var(--stage-ptr-line);stroke-width:1.5}.sxs-ptrs{fill:black;opacity:.35}
.sxs-rip{fill:none;stroke:white;stroke-width:1.5;transform-box:fill-box;transform-origin:center;animation-name:sxs-rip}
.sxs-pill{fill:var(--stage-pill);stroke:var(--stage-pill-line);stroke-width:1}
.sxs-cap{fill:color-mix(in srgb,white 14%,transparent);stroke:color-mix(in srgb,white 30%,transparent);stroke-width:1}
.sxs text{font:600 10.5px var(--f-body,system-ui,sans-serif);fill:var(--stage-pill-text)}
.sxs-rows text{font:600 10.5px var(--f-body,system-ui,sans-serif);fill:var(--stage-pill-text)}.sxs-rows .sxs-cut{fill:var(--stage-cut)}
.sxs-aw{stroke:var(--stage-aol);stroke-width:10}.sxs-an{stroke:var(--stage-a1);stroke-width:6.5}.sxs-ah{fill:var(--stage-a1);stroke:var(--stage-aol);stroke-width:2}
.sxs-k{font:700 8.5px var(--f-body,system-ui,sans-serif);fill:var(--stage-pill-text)}.sxs .s-cut{fill:var(--stage-cut)}.sxs .s-add{fill:var(--stage-a1)}
.sxs .s-lit{animation-name:sxs-lit}.sxs .s-hud{animation-name:sxs-hud}
@keyframes sxs-lit{0%{fill:var(--stage-t1)}${pc(0.3)},${pc(3.2)}{fill:var(--stage-a1)}100%{fill:var(--stage-t1)}}
@keyframes sxs-rip{0%,${pc(0.45)}{opacity:0;transform:scale(.2)}${pc(0.5)}{opacity:.9;transform:scale(.3)}${pc(0.85)},100%{opacity:0;transform:scale(1)}}
@keyframes sxs-hud{0%,${pc(0.5)}{opacity:0}${pc(0.55)},${pc(3.25)}{opacity:1}${pc(3.32)},100%{opacity:0}}
@media (prefers-reduced-motion:reduce){.sxs .s-a{animation-delay:-${STAGE_STILL}s!important;animation-play-state:paused!important}.sxs .s-still{display:inline}.sxs .s-smil{display:none}}`

// keyframes carry the tool's id, since every tip's styles share the document
function badge(id: string, { add, cut }: NonNullable<StageTool['badge']>): string {
  const on = (name: string, a: number, b: number) =>
    `.sxs .${name}{animation-name:${name}}@keyframes ${name}{0%,${pc(a - 0.05)}{opacity:0}${pc(a + 0.05)},${pc(b)}{opacity:1}${pc(b + (b < 3.2 ? 0.01 : 0.25))},100%{opacity:0}}`
  const pill = (cls: string, text: string, tc: string, w: number) =>
    `<g class="${cls} s-a"><rect class="sxs-pill" x="8" y="6" width="${w}" height="18" rx="9" style="stroke:var(${tc})"/><text x="15" y="18.7" class="${cls.endsWith('add') ? 's-add' : 's-cut'}">${text}</text></g>`
  let css = ''
  let out = ''
  if (add !== undefined) {
    css += on(`${id}-badd`, add, cut ?? 3.2)
    out += pill(`${id}-badd`, '+ Add', '--stage-a1', 44)
  }
  if (cut !== undefined) {
    css += on(`${id}-bcut`, cut, 3.2)
    out += pill(`${id}-bcut`, '− Cut', '--stage-cut', 44)
  }
  return `<style>${css}</style>${out}`
}

const DEFS = `<defs><radialGradient id="sxs-fg" cx=".42" cy=".62" r=".6"><stop offset=".45" stop-color="white"/><stop offset="1" stop-color="white" stop-opacity="0"/></radialGradient>
<mask id="sxs-fade"><rect width="${STAGE_W}" height="${STAGE_H}" fill="url(#sxs-fg)"/></mask>
<filter id="sxs-glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur in="SourceAlpha" stdDeviation="3" result="b"/><feFlood style="flood-color:var(--stage-a1)" flood-opacity=".75"/><feComposite in2="b" operator="in"/><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter>
<g id="sxs-ptr" transform="scale(1.15) translate(-2 -1.5)"><path class="sxs-ptrs" d="${POINTER}" transform="translate(0 1.4)"/><path class="sxs-ptr" d="${POINTER}"/></g>
<linearGradient id="sxs-cy"><stop offset="0" style="stop-color:var(--stage-t2)"/><stop offset=".28" style="stop-color:var(--stage-t1)"/><stop offset=".7" style="stop-color:var(--stage-t2)"/><stop offset="1" style="stop-color:var(--stage-t3)"/></linearGradient>
<linearGradient id="sxs-cya"><stop offset="0" style="stop-color:var(--stage-a2)"/><stop offset=".28" style="stop-color:var(--stage-a1)"/><stop offset=".7" style="stop-color:var(--stage-a2)"/><stop offset="1" style="stop-color:var(--stage-a3)"/></linearGradient>
<g id="sxs-arw" filter="url(#sxs-glow)"><path class="sxs-aw" d="M0 0V-25"/><path class="sxs-an" d="M0 0V-25"/><polygon class="sxs-ah" points="0,-40 -12,-23 12,-23"/></g>`

// the readout: its pill (with a keycap when it has a key) and its rows; the ids carry the tool's, since rows differ and its rows, as defs the tool places and slides
function readout(id: string, { rows, cutFrom, key, w }: NonNullable<StageTool['readout']>): string {
  const x = key ? 42 : 10
  const width = w ?? (key ? 94 : 60)
  let t = ''
  rows.forEach((r, i) => (t += `<text x="${x}" y="${round(3.7 + i * STAGE_ROW)}"${cutFrom !== undefined && i >= cutFrom ? ' class="sxs-cut"' : ''}>${r}</text>`))
  const cap = key ? `<rect class="sxs-cap" x="6" y="-6" width="28" height="12" rx="3"/><text class="sxs-k" x="10" y="3.2" style="font-size:8.5px;font-weight:700">${key}</text>` : ''
  return `<g id="sxs-hud-${id}"><rect class="sxs-pill" x="0" y="-9" width="${width}" height="18" rx="9"/>${cap}</g><g id="sxs-rows-${id}" class="sxs-rows">${t}</g>`
}

/** The whole stage for one tool, as SVG markup. */
export function stageSvg(tool: StageTool, label: string): string {
  return `<svg class="sxs" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${STAGE_W} ${STAGE_H}" width="${STAGE_W}" height="${STAGE_H}" role="img" aria-label="${label}">${stageInner(tool)}</svg>`
}

/** The stage's contents, for an svg element the caller draws. */
export function stageInner(tool: StageTool): string {
  return `<style>${CSS}\n${tool.css}</style>${DEFS}${tool.readout ? readout(tool.id, tool.readout) : ''}</defs>${grid()}${tool.body}${tool.badge ? badge(tool.id, tool.badge) : ''}`
}
