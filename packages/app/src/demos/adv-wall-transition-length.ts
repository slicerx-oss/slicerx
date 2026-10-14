// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Wall transition length: how much room the walls get to join into one; longer is gentler.
import type { StageTool } from '@slicerx/ui'

export const loop: StageTool = {
  id: 'bttl',
  readout: {rows: ["50 %","200 %"],w: 72},
  css: ".bttl0{animation-name:bttl0;animation-timing-function:steps(1,end)}@keyframes bttl0{0%{opacity:1}50%{opacity:0}98.6%{opacity:1}100%{opacity:1}}.bttl1{animation-name:bttl1;animation-timing-function:steps(1,end)}@keyframes bttl1{0%{opacity:0}50%{opacity:1}98.6%{opacity:0}100%{opacity:0}}.bttl-h{animation-name:bttl-h;animation-timing-function:steps(1,end)}@keyframes bttl-h{0%{translate:0 0px}50%{translate:0 -14px}98.6%{translate:0 0px}100%{translate:0 0px}}",
  body: "<polygon class=\"s-f1 s-ol\" points=\"124,76.8 184.6,139.8 75.5,104.8\"/><polygon class=\"s-f2 s-ol\" points=\"75.5,110 184.6,145 184.6,139.8 75.5,104.8\"/><g class=\"bttl0 s-a\"><path class=\"s-n\" style=\"stroke:var(--stage-a2,#a57ae8);stroke-width:1.8\" d=\"M122.8 79.9l25.7 27.9-6.3 7.1 36.4 21M81.6 103.7l48.2 14.9 12.4-3.7\"/></g><g class=\"bttl1 s-a\"><path class=\"s-n\" style=\"stroke:var(--stage-a2,#a57ae8);stroke-width:1.8\" d=\"M122.8 79.9l14.9 16.6 4.5 18.4 36.4 21M81.6 103.7l28.7 8.6 31.9 2.6\"/></g><g class=\" s-a\"><use href=\"#sxs-hud-bttl\" x=\"204\" y=\"40\"/><clipPath id=\"bttl-hw\"><rect x=\"210\" y=\"32\" width=\"62\" height=\"16\"/></clipPath><g clip-path=\"url(#bttl-hw)\"><g class=\"bttl-h s-a\"><use href=\"#sxs-rows-bttl\" x=\"204\" y=\"40\"/></g></g></g>",
}
