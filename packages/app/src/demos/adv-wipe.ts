// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Wipe: the nozzle moves back over the line it just printed while it retracts, which wipes off ooze before the travel.
import type { StageTool } from '@slicerx/ui'

export const loop: StageTool = {
  id: 'bwwo',
  readout: {rows: ["Off","On"],w: 64},
  css: ".bwwo0{animation-name:bwwo0;animation-timing-function:steps(1,end)}@keyframes bwwo0{0%{opacity:1}50%{opacity:0}98.6%{opacity:1}100%{opacity:1}}.bwwo1{animation-name:bwwo1;animation-timing-function:steps(1,end)}@keyframes bwwo1{0%{opacity:0}50%{opacity:1}98.6%{opacity:0}100%{opacity:0}}.bwwo-h{animation-name:bwwo-h;animation-timing-function:steps(1,end)}@keyframes bwwo-h{0%{translate:0 0px}50%{translate:0 -14px}98.6%{translate:0 0px}100%{translate:0 0px}}.bwwo-b{animation-name:bwwo-b}@keyframes bwwo-b{0%{stroke-dashoffset:101}55.7%{stroke-dashoffset:101}74.3%{stroke-dashoffset:0}91.4%{opacity:1}95.7%{opacity:0}100%{opacity:0}}",
  body: "<polygon class=\"s-f2 s-ol\" points=\"81.6,106.5 160.4,152 160.4,145 81.6,99.5\"/><polygon class=\"s-f3 s-ol\" points=\"202.8,127.5 160.4,152 160.4,145 202.8,120.5\"/><polygon class=\"s-f1 s-ol\" points=\"124,75 202.8,120.5 160.4,145 81.6,99.5\"/><path class=\"s-n\" style=\"stroke:var(--stage-t3,#6c7086);stroke-width:3\" d=\"M108.8 90.2l60.7 35\"/><g class=\"bwwo0 s-a\"><ellipse class=\"s-cf s-cl\" cx=\"169.5\" cy=\"125.2\" rx=\"6\" ry=\"3.5\"/><path class=\"s-n\" style=\"stroke:var(--stage-cut,#ff5555);stroke-width:1.2\" d=\"M169.5 125.2q10 -3 22 6\"/></g><g class=\"bwwo1 s-a\"><path class=\"bwwo-b s-a s-n\" pathLength=\"100\" style=\"stroke:var(--stage-a2,#a57ae8);stroke-width:2;stroke-dasharray:100 102\" d=\"M167.6 124.9l-15.1-8.8\"/></g><g class=\" s-a\"><use href=\"#sxs-hud-bwwo\" x=\"212\" y=\"40\"/><clipPath id=\"bwwo-hw\"><rect x=\"218\" y=\"32\" width=\"54\" height=\"16\"/></clipPath><g clip-path=\"url(#bwwo-hw)\"><g class=\"bwwo-h s-a\"><use href=\"#sxs-rows-bwwo\" x=\"212\" y=\"40\"/></g></g></g>",
}
