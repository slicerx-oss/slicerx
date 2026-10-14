// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Travel slope: how steeply the nozzle climbs on a slope or spiral z hop; 90 lifts straight up.
import type { StageTool } from '@slicerx/ui'

export const loop: StageTool = {
  id: 'btts',
  readout: {rows: ["90°","30°"],w: 64},
  css: ".btts0{animation-name:btts0;animation-timing-function:steps(1,end)}@keyframes btts0{0%{opacity:1}50%{opacity:0}98.6%{opacity:1}100%{opacity:1}}.btts1{animation-name:btts1;animation-timing-function:steps(1,end)}@keyframes btts1{0%{opacity:0}50%{opacity:1}98.6%{opacity:0}100%{opacity:0}}.btts-h{animation-name:btts-h;animation-timing-function:steps(1,end)}@keyframes btts-h{0%{translate:0 0px}50%{translate:0 -14px}98.6%{translate:0 0px}100%{translate:0 0px}}.btts-a{animation-name:btts-a}@keyframes btts-a{0%{stroke-dashoffset:101}8.6%{stroke-dashoffset:101}34.3%{stroke-dashoffset:0}45.7%{opacity:1}50%{opacity:0}100%{opacity:0}}.btts-b{animation-name:btts-b}@keyframes btts-b{0%{stroke-dashoffset:101}55.7%{stroke-dashoffset:101}81.4%{stroke-dashoffset:0}91.4%{opacity:1}95.7%{opacity:0}100%{opacity:0}}",
  body: "<polygon class=\"s-f2 s-ol\" points=\"81.6,106.5 160.4,152 160.4,138 81.6,92.5\"/><polygon class=\"s-f3 s-ol\" points=\"202.8,127.5 160.4,152 160.4,138 202.8,113.5\"/><polygon class=\"s-f1 s-ol\" points=\"124,68 202.8,113.5 160.4,138 81.6,92.5\"/><g class=\"btts0 s-a\"><path class=\"btts-a s-a s-n\" pathLength=\"100\" style=\"stroke:var(--stage-a2,#a57ae8);stroke-width:2;stroke-dasharray:100 102\" d=\"M111.9 84.8l0-16.8 60.6 35 0 16.8\"/></g><g class=\"btts1 s-a\"><path class=\"btts-b s-a s-n\" pathLength=\"100\" style=\"stroke:var(--stage-a2,#a57ae8);stroke-width:2;stroke-dasharray:100 102\" d=\"M111.9 84.8l30.3 .7 30.3 17.5 0 16.8\"/></g><g class=\" s-a\"><use href=\"#sxs-hud-btts\" x=\"212\" y=\"40\"/><clipPath id=\"btts-hw\"><rect x=\"218\" y=\"32\" width=\"54\" height=\"16\"/></clipPath><g clip-path=\"url(#btts-hw)\"><g class=\"btts-h s-a\"><use href=\"#sxs-rows-btts\" x=\"212\" y=\"40\"/></g></g></g>",
}
