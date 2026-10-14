// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Wall transition filter: a margin that stops walls switching back and forth between one line and two, so there are fewer starts and stops.
import type { StageTool } from '@slicerx/ui'

export const loop: StageTool = {
  id: 'bttf',
  readout: {rows: ["5 %","25 %"],w: 64},
  css: ".bttf0{animation-name:bttf0;animation-timing-function:steps(1,end)}@keyframes bttf0{0%{opacity:1}50%{opacity:0}98.6%{opacity:1}100%{opacity:1}}.bttf1{animation-name:bttf1;animation-timing-function:steps(1,end)}@keyframes bttf1{0%{opacity:0}50%{opacity:1}98.6%{opacity:0}100%{opacity:0}}.bttf-h{animation-name:bttf-h;animation-timing-function:steps(1,end)}@keyframes bttf-h{0%{translate:0 0px}50%{translate:0 -14px}98.6%{translate:0 0px}100%{translate:0 0px}}",
  body: "<polygon class=\"s-f1 s-ol\" points=\"124,76.8 184.6,139.8 75.5,104.8\"/><polygon class=\"s-f2 s-ol\" points=\"75.5,110 184.6,145 184.6,139.8 75.5,104.8\"/><g class=\"bttf0 s-a\"><path class=\"s-n\" style=\"stroke:var(--stage-a2,#a57ae8);stroke-width:1.8\" d=\"M122.8 79.9l17 18.9-3.7 12.6 42.5 24.5M81.6 103.7l32.6 9.9 21.9-2.2M142.2 114.9l5.1 .5 .9 3M151.3 120.2l5.1 .5 .9 3M160.4 125.4l5.1 .5 .9 3M169.5 130.7l5.1 .5 .9 3\"/><ellipse class=\"s-cf s-cl\" cx=\"145.5\" cy=\"114.7\" rx=\"2.1\" ry=\"1.2\"/><ellipse class=\"s-cf s-cl\" cx=\"154.6\" cy=\"120\" rx=\"2.1\" ry=\"1.2\"/><ellipse class=\"s-cf s-cl\" cx=\"163.7\" cy=\"125.2\" rx=\"2.1\" ry=\"1.2\"/><ellipse class=\"s-cf s-cl\" cx=\"172.8\" cy=\"130.5\" rx=\"2.1\" ry=\"1.2\"/></g><g class=\"bttf1 s-a\"><path class=\"s-n\" style=\"stroke:var(--stage-a2,#a57ae8);stroke-width:1.8\" d=\"M122.8 79.9l17 18.9-3.7 12.6 42.5 24.5M81.6 103.7l32.6 9.9 21.9-2.2\"/></g><g class=\" s-a\"><use href=\"#sxs-hud-bttf\" x=\"212\" y=\"40\"/><clipPath id=\"bttf-hw\"><rect x=\"218\" y=\"32\" width=\"54\" height=\"16\"/></clipPath><g clip-path=\"url(#bttf-hw)\"><g class=\"bttf-h s-a\"><use href=\"#sxs-rows-bttf\" x=\"212\" y=\"40\"/></g></g></g>",
}
