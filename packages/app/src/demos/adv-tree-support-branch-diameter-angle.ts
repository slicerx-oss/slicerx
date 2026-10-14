// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Branch diameter angle: how quickly branches thicken toward the bed; a little taper keeps tall trees standing.
import type { StageTool } from '@slicerx/ui'

export const loop: StageTool = {
  id: 'bttg',
  readout: {rows: ["0°","5°"],w: 64},
  css: ".bttg0{animation-name:bttg0;animation-timing-function:steps(1,end)}@keyframes bttg0{0%{opacity:1}50%{opacity:0}98.6%{opacity:1}100%{opacity:1}}.bttg1{animation-name:bttg1;animation-timing-function:steps(1,end)}@keyframes bttg1{0%{opacity:0}50%{opacity:1}98.6%{opacity:0}100%{opacity:0}}.bttg-h{animation-name:bttg-h;animation-timing-function:steps(1,end)}@keyframes bttg-h{0%{translate:0 0px}50%{translate:0 -14px}98.6%{translate:0 0px}100%{translate:0 0px}}",
  body: "<polygon class=\"s-f2 s-ol\" points=\"87.6,103 105.8,113.5 105.8,64.5 87.6,54\"/><polygon class=\"s-f3 s-ol\" points=\"130.1,99.5 105.8,113.5 105.8,64.5 130.1,50.5\"/><polygon class=\"s-f1 s-ol\" points=\"111.9,40 130.1,50.5 105.8,64.5 87.6,54\"/><polygon class=\"s-f2 s-ol\" points=\"105.8,78.5 160.4,110 160.4,96 105.8,64.5\"/><polygon class=\"s-f3 s-ol\" points=\"184.6,96 160.4,110 160.4,96 184.6,82\"/><polygon class=\"s-f1 s-ol\" points=\"130.1,50.5 184.6,82 160.4,96 105.8,64.5\"/><g class=\"bttg0 s-a\"><path class=\"s-n\" style=\"stroke:var(--stage-a2,#a57ae8);stroke-width:1.8\" d=\"M134.3 132.1l0-17.5M134.3 114.6Q125.2 97.1 116.1 86.6M134.3 114.6Q134.3 102.3 134.3 97.1M134.3 114.6Q143.4 107.6 152.5 107.6\"/><path class=\"s-g2 s-aol\" d=\"M133.4 131.5l1.8 1.1 .3-17.3-2.4-1.4z\"/></g><g class=\"bttg1 s-a\"><path class=\"s-n\" style=\"stroke:var(--stage-a2,#a57ae8);stroke-width:1.8\" d=\"M134.3 132.1l0-17.5M134.3 114.6Q125.2 97.1 116.1 86.6M134.3 114.6Q134.3 102.3 134.3 97.1M134.3 114.6Q143.4 107.6 152.5 107.6\"/><path class=\"s-g2 s-aol\" d=\"M125.2 126.8l18.2 10.5-7.9-22-2.4-1.4z\"/></g><g class=\" s-a\"><use href=\"#sxs-hud-bttg\" x=\"212\" y=\"40\"/><clipPath id=\"bttg-hw\"><rect x=\"218\" y=\"32\" width=\"54\" height=\"16\"/></clipPath><g clip-path=\"url(#bttg-hw)\"><g class=\"bttg-h s-a\"><use href=\"#sxs-rows-bttg\" x=\"212\" y=\"40\"/></g></g></g>",
}
