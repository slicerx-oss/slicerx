// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Seam gap: the loop stops a little short of its start, so the ends meet without a blob.
import type { StageTool } from '@slicerx/ui'

export const loop: StageTool = {
  id: 'bqsg',
  readout: {rows: ["0 %","15 %"],w: 64},
  css: ".bqsg0{animation-name:bqsg0;animation-timing-function:steps(1,end)}@keyframes bqsg0{0%{opacity:1}50%{opacity:0}98.6%{opacity:1}100%{opacity:1}}.bqsg1{animation-name:bqsg1;animation-timing-function:steps(1,end)}@keyframes bqsg1{0%{opacity:0}50%{opacity:1}98.6%{opacity:0}100%{opacity:0}}.bqsg-h{animation-name:bqsg-h;animation-timing-function:steps(1,end)}@keyframes bqsg-h{0%{translate:0 0px}50%{translate:0 -14px}98.6%{translate:0 0px}100%{translate:0 0px}}.bqsg-a{animation-name:bqsg-a}@keyframes bqsg-a{0%{stroke-dashoffset:101}5.7%{stroke-dashoffset:101}31.4%{stroke-dashoffset:0}45.7%{opacity:1}50%{opacity:0}100%{opacity:0}}.bqsg-b{animation-name:bqsg-b}@keyframes bqsg-b{0%{stroke-dashoffset:101}54.3%{stroke-dashoffset:101}80%{stroke-dashoffset:0}91.4%{opacity:1}95.7%{opacity:0}100%{opacity:0}}",
  body: "<polygon class=\"s-f2 s-ol\" points=\"75.5,110 148.2,152 148.2,145 75.5,103\"/><polygon class=\"s-f3 s-ol\" points=\"196.7,124 148.2,152 148.2,145 196.7,117\"/><polygon class=\"s-f1 s-ol\" points=\"124,75 196.7,117 148.2,145 75.5,103\"/><g class=\"bqsg0 s-a\"><path class=\"bqsg-a s-a s-n\" pathLength=\"100\" style=\"stroke:var(--stage-a2,#a57ae8);stroke-width:2.4;stroke-dasharray:100 102\" d=\"M119.5 119.3l-28.8-16.6 33.3-19.3 57.6 33.3-33.4 19.2-28.7-16.6\"/><ellipse class=\"s-cf s-cl\" cx=\"119.5\" cy=\"119.3\" rx=\"6\" ry=\"3.5\"/></g><g class=\"bqsg1 s-a\"><path class=\"bqsg-b s-a s-n\" pathLength=\"100\" style=\"stroke:var(--stage-a2,#a57ae8);stroke-width:2.4;stroke-dasharray:100 102\" d=\"M119.5 119.3l-28.8-16.6 33.3-19.3 57.6 33.3-33.4 19.2-16.6-9.6\"/></g><g class=\" s-a\"><use href=\"#sxs-hud-bqsg\" x=\"212\" y=\"40\"/><clipPath id=\"bqsg-hw\"><rect x=\"218\" y=\"32\" width=\"54\" height=\"16\"/></clipPath><g clip-path=\"url(#bqsg-hw)\"><g class=\"bqsg-h s-a\"><use href=\"#sxs-rows-bqsg\" x=\"212\" y=\"40\"/></g></g></g>",
}
