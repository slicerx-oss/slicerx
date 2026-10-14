// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Wipe on loops: after closing a loop the nozzle moves a little inward along the part, which hides the seam's blob.
import type { StageTool } from '@slicerx/ui'

export const loop: StageTool = {
  id: 'bqwl',
  readout: {rows: ["Off","On"],w: 64},
  css: ".bqwl0{animation-name:bqwl0;animation-timing-function:steps(1,end)}@keyframes bqwl0{0%{opacity:1}50%{opacity:0}98.6%{opacity:1}100%{opacity:1}}.bqwl1{animation-name:bqwl1;animation-timing-function:steps(1,end)}@keyframes bqwl1{0%{opacity:0}50%{opacity:1}98.6%{opacity:0}100%{opacity:0}}.bqwl-h{animation-name:bqwl-h;animation-timing-function:steps(1,end)}@keyframes bqwl-h{0%{translate:0 0px}50%{translate:0 -14px}98.6%{translate:0 0px}100%{translate:0 0px}}.bqwl-w{animation-name:bqwl-w}@keyframes bqwl-w{0%{stroke-dashoffset:101}57.1%{stroke-dashoffset:101}71.4%{stroke-dashoffset:0}91.4%{opacity:1}95.7%{opacity:0}100%{opacity:0}}",
  body: "<polygon class=\"s-f2 s-ol\" points=\"75.5,110 148.2,152 148.2,145 75.5,103\"/><polygon class=\"s-f3 s-ol\" points=\"196.7,124 148.2,152 148.2,145 196.7,117\"/><polygon class=\"s-f1 s-ol\" points=\"124,75 196.7,117 148.2,145 75.5,103\"/><path class=\"s-n\" style=\"stroke:var(--stage-t3,#6c7086);stroke-width:2.4\" d=\"M119.5 119.3l-28.8-16.6 33.3-19.3 57.6 33.3-33.4 19.2-28.7-16.6\"/><g class=\"bqwl0 s-a\"><ellipse class=\"s-cf s-cl\" cx=\"119.5\" cy=\"119.3\" rx=\"6\" ry=\"3.5\"/></g><g class=\"bqwl1 s-a\"><path class=\"bqwl-w s-a s-n\" pathLength=\"100\" style=\"stroke:var(--stage-a2,#a57ae8);stroke-width:2.4;stroke-dasharray:100 102\" d=\"M119.5 119.3l-18.2-10.5 10.6-13.1\"/></g><g class=\" s-a\"><use href=\"#sxs-hud-bqwl\" x=\"212\" y=\"40\"/><clipPath id=\"bqwl-hw\"><rect x=\"218\" y=\"32\" width=\"54\" height=\"16\"/></clipPath><g clip-path=\"url(#bqwl-hw)\"><g class=\"bqwl-h s-a\"><use href=\"#sxs-rows-bqwl\" x=\"212\" y=\"40\"/></g></g></g>",
}
