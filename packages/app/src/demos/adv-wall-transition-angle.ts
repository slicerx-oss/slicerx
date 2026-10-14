// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Wall transition angle: how sharp a wedge must be before the wall count changes; too low leaves a gap near the tip.
import type { StageTool } from '@slicerx/ui'

export const loop: StageTool = {
  id: 'bttn',
  readout: {rows: ["5°","20°"],w: 64},
  css: ".bttn0{animation-name:bttn0;animation-timing-function:steps(1,end)}@keyframes bttn0{0%{opacity:1}50%{opacity:0}98.6%{opacity:1}100%{opacity:1}}.bttn1{animation-name:bttn1;animation-timing-function:steps(1,end)}@keyframes bttn1{0%{opacity:0}50%{opacity:1}98.6%{opacity:0}100%{opacity:0}}.bttn-h{animation-name:bttn-h;animation-timing-function:steps(1,end)}@keyframes bttn-h{0%{translate:0 0px}50%{translate:0 -14px}98.6%{translate:0 0px}100%{translate:0 0px}}",
  body: "<polygon class=\"s-f1 s-ol\" points=\"124,76.8 184.6,139.8 75.5,104.8\"/><polygon class=\"s-f2 s-ol\" points=\"75.5,110 184.6,145 184.6,139.8 75.5,104.8\"/><g class=\"bttn0 s-a\"><path class=\"s-n\" style=\"stroke:var(--stage-a2,#a57ae8);stroke-width:1.8\" d=\"M122.8 79.9l21.4 23.4-2 11.6 18.2 10.5M81.6 103.7l40.4 12.4 20.2-1.2\"/><ellipse class=\"s-cf s-cl\" cx=\"169.5\" cy=\"130.7\" rx=\"6.9\" ry=\"4\"/></g><g class=\"bttn1 s-a\"><path class=\"s-n\" style=\"stroke:var(--stage-a2,#a57ae8);stroke-width:1.8\" d=\"M122.8 79.9l21.4 23.4-2 11.6 36.4 21M81.6 103.7l40.4 12.4 20.2-1.2\"/></g><g class=\" s-a\"><use href=\"#sxs-hud-bttn\" x=\"212\" y=\"40\"/><clipPath id=\"bttn-hw\"><rect x=\"218\" y=\"32\" width=\"54\" height=\"16\"/></clipPath><g clip-path=\"url(#bttn-hw)\"><g class=\"bttn-h s-a\"><use href=\"#sxs-rows-bttn\" x=\"212\" y=\"40\"/></g></g></g>",
}
