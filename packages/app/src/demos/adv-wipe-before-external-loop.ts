// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Wipe before the outer wall: the nozzle starts the outer loop with a short move from inside the part, so the start does not leave a blob on the surface.
import type { StageTool } from '@slicerx/ui'

export const loop: StageTool = {
  id: 'bqwb',
  readout: {rows: ["Off","On"],w: 64},
  css: ".bqwb0{animation-name:bqwb0;animation-timing-function:steps(1,end)}@keyframes bqwb0{0%{opacity:1}50%{opacity:0}98.6%{opacity:1}100%{opacity:1}}.bqwb1{animation-name:bqwb1;animation-timing-function:steps(1,end)}@keyframes bqwb1{0%{opacity:0}50%{opacity:1}98.6%{opacity:0}100%{opacity:0}}.bqwb-h{animation-name:bqwb-h;animation-timing-function:steps(1,end)}@keyframes bqwb-h{0%{translate:0 0px}50%{translate:0 -14px}98.6%{translate:0 0px}100%{translate:0 0px}}.bqwb-w{animation-name:bqwb-w}@keyframes bqwb-w{0%{stroke-dashoffset:101}55.7%{stroke-dashoffset:101}68.6%{stroke-dashoffset:0}91.4%{opacity:1}95.7%{opacity:0}100%{opacity:0}}",
  body: "<polygon class=\"s-f2 s-ol\" points=\"75.5,110 148.2,152 148.2,145 75.5,103\"/><polygon class=\"s-f3 s-ol\" points=\"196.7,124 148.2,152 148.2,145 196.7,117\"/><polygon class=\"s-f1 s-ol\" points=\"124,75 196.7,117 148.2,145 75.5,103\"/><path class=\"s-n\" style=\"stroke:var(--stage-t3,#6c7086);stroke-width:2.4\" d=\"M119.5 119.3l-28.8-16.6 33.3-19.3 57.6 33.3-33.4 19.2-28.7-16.6\"/><g class=\"bqwb0 s-a\"><ellipse class=\"s-cf s-cl\" cx=\"119.5\" cy=\"119.3\" rx=\"6\" ry=\"3.5\"/></g><g class=\"bqwb1 s-a\"><path class=\"bqwb-w s-a s-n\" pathLength=\"100\" style=\"stroke:var(--stage-a2,#a57ae8);stroke-width:2.4;stroke-dasharray:100 102\" d=\"M117.9 99.2l-7.5 14.8 9.1 5.3\"/></g><g class=\" s-a\"><use href=\"#sxs-hud-bqwb\" x=\"212\" y=\"40\"/><clipPath id=\"bqwb-hw\"><rect x=\"218\" y=\"32\" width=\"54\" height=\"16\"/></clipPath><g clip-path=\"url(#bqwb-hw)\"><g class=\"bqwb-h s-a\"><use href=\"#sxs-rows-bqwb\" x=\"212\" y=\"40\"/></g></g></g>",
}
