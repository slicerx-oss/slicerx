// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Preferred branch angle: the lean branches take when nothing is in the way; lower is more upright, higher merges branches sooner.
import type { StageTool } from '@slicerx/ui'

export const loop: StageTool = {
  id: 'btal',
  readout: {rows: ["15°","35°"],w: 64},
  css: ".btal0{animation-name:btal0;animation-timing-function:steps(1,end)}@keyframes btal0{0%{opacity:1}50%{opacity:0}98.6%{opacity:1}100%{opacity:1}}.btal1{animation-name:btal1;animation-timing-function:steps(1,end)}@keyframes btal1{0%{opacity:0}50%{opacity:1}98.6%{opacity:0}100%{opacity:0}}.btal-h{animation-name:btal-h;animation-timing-function:steps(1,end)}@keyframes btal-h{0%{translate:0 0px}50%{translate:0 -14px}98.6%{translate:0 0px}100%{translate:0 0px}}",
  body: "<polygon class=\"s-f2 s-ol\" points=\"87.6,103 105.8,113.5 105.8,64.5 87.6,54\"/><polygon class=\"s-f3 s-ol\" points=\"130.1,99.5 105.8,113.5 105.8,64.5 130.1,50.5\"/><polygon class=\"s-f1 s-ol\" points=\"111.9,40 130.1,50.5 105.8,64.5 87.6,54\"/><polygon class=\"s-f2 s-ol\" points=\"105.8,78.5 160.4,110 160.4,96 105.8,64.5\"/><polygon class=\"s-f3 s-ol\" points=\"184.6,96 160.4,110 160.4,96 184.6,82\"/><polygon class=\"s-f1 s-ol\" points=\"130.1,50.5 184.6,82 160.4,96 105.8,64.5\"/><g class=\"btal0 s-a\"><path class=\"s-n\" style=\"stroke:var(--stage-a2,#a57ae8);stroke-width:3.2\" d=\"M134.3 132.1l0-28M134.3 104.1Q128.2 93.6 122.2 90.1M134.3 104.1Q134.3 97.1 134.3 97.1M134.3 104.1Q140.4 100.6 146.4 104.1\"/></g><g class=\"btal1 s-a\"><path class=\"s-n\" style=\"stroke:var(--stage-a2,#a57ae8);stroke-width:3.2\" d=\"M134.3 132.1l0-12.3M134.3 119.8Q123.7 98.8 113.1 84.8M134.3 119.8Q134.3 104.9 134.3 97.1M134.3 119.8Q144.9 111.1 155.5 109.3\"/></g><g class=\" s-a\"><use href=\"#sxs-hud-btal\" x=\"212\" y=\"40\"/><clipPath id=\"btal-hw\"><rect x=\"218\" y=\"32\" width=\"54\" height=\"16\"/></clipPath><g clip-path=\"url(#btal-hw)\"><g class=\"btal-h s-a\"><use href=\"#sxs-rows-btal\" x=\"212\" y=\"40\"/></g></g></g>",
}
