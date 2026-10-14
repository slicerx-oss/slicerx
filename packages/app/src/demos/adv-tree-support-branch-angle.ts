// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Branch angle: how far branches may lean; a wider angle reaches further from the trunk but stands less steady.
import type { StageTool } from '@slicerx/ui'

export const loop: StageTool = {
  id: 'btta',
  readout: {rows: ["25°","50°"],w: 64},
  css: ".btta0{animation-name:btta0;animation-timing-function:steps(1,end)}@keyframes btta0{0%{opacity:1}50%{opacity:0}98.6%{opacity:1}100%{opacity:1}}.btta1{animation-name:btta1;animation-timing-function:steps(1,end)}@keyframes btta1{0%{opacity:0}50%{opacity:1}98.6%{opacity:0}100%{opacity:0}}.btta-h{animation-name:btta-h;animation-timing-function:steps(1,end)}@keyframes btta-h{0%{translate:0 0px}50%{translate:0 -14px}98.6%{translate:0 0px}100%{translate:0 0px}}",
  body: "<polygon class=\"s-f2 s-ol\" points=\"87.6,103 105.8,113.5 105.8,64.5 87.6,54\"/><polygon class=\"s-f3 s-ol\" points=\"130.1,99.5 105.8,113.5 105.8,64.5 130.1,50.5\"/><polygon class=\"s-f1 s-ol\" points=\"111.9,40 130.1,50.5 105.8,64.5 87.6,54\"/><polygon class=\"s-f2 s-ol\" points=\"105.8,78.5 160.4,110 160.4,96 105.8,64.5\"/><polygon class=\"s-f3 s-ol\" points=\"184.6,96 160.4,110 160.4,96 184.6,82\"/><polygon class=\"s-f1 s-ol\" points=\"130.1,50.5 184.6,82 160.4,96 105.8,64.5\"/><g class=\"btta0 s-a\"><path class=\"s-n\" style=\"stroke:var(--stage-a2,#a57ae8);stroke-width:3.2\" d=\"M134.3 132.1l0-24.5M134.3 107.6Q128.2 95.3 122.2 90.1M134.3 107.6Q134.3 98.8 134.3 97.1M134.3 107.6Q140.4 102.3 146.4 104.1\"/></g><g class=\"btta1 s-a\"><path class=\"s-n\" style=\"stroke:var(--stage-a2,#a57ae8);stroke-width:3.2\" d=\"M134.3 132.1l0-7M134.3 125.1Q120.7 99.7 107 81.3M134.3 125.1Q134.3 107.6 134.3 97.1M134.3 125.1Q147.9 115.4 161.6 112.8\"/></g><g class=\" s-a\"><use href=\"#sxs-hud-btta\" x=\"212\" y=\"40\"/><clipPath id=\"btta-hw\"><rect x=\"218\" y=\"32\" width=\"54\" height=\"16\"/></clipPath><g clip-path=\"url(#btta-hw)\"><g class=\"btta-h s-a\"><use href=\"#sxs-rows-btta\" x=\"212\" y=\"40\"/></g></g></g>",
}
