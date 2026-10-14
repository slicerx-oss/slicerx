// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Z hop: how far the nozzle lifts before a travel so it does not drag across the print; higher clears curled edges.
import type { StageTool } from '@slicerx/ui'

export const loop: StageTool = {
  id: 'bwzh',
  readout: {rows: ["0.2 mm","0.6 mm"],w: 72},
  css: ".bwzh0{animation-name:bwzh0;animation-timing-function:steps(1,end)}@keyframes bwzh0{0%{opacity:1}50%{opacity:0}98.6%{opacity:1}100%{opacity:1}}.bwzh1{animation-name:bwzh1;animation-timing-function:steps(1,end)}@keyframes bwzh1{0%{opacity:0}50%{opacity:1}98.6%{opacity:0}100%{opacity:0}}.bwzh-h{animation-name:bwzh-h;animation-timing-function:steps(1,end)}@keyframes bwzh-h{0%{translate:0 0px}50%{translate:0 -14px}98.6%{translate:0 0px}100%{translate:0 0px}}",
  body: "<polygon class=\"s-f2 s-ol\" points=\"81.6,106.5 160.4,152 160.4,138 81.6,92.5\"/><polygon class=\"s-f3 s-ol\" points=\"202.8,127.5 160.4,152 160.4,138 202.8,113.5\"/><polygon class=\"s-f1 s-ol\" points=\"124,68 202.8,113.5 160.4,138 81.6,92.5\"/><g class=\"bwzh0 s-a\"><path class=\"s-n\" style=\"stroke:var(--stage-a2,#a57ae8);stroke-width:2\" d=\"M111.9 84.8l0-5.2 60.6 35 0 5.2\"/><path class=\"s-n\" style=\"stroke:var(--stage-cut,#ff5555);stroke-width:1.6\" d=\"M142.2 102.3q-2 -8 3 -10\"/></g><g class=\"bwzh1 s-a\"><path class=\"s-n\" style=\"stroke:var(--stage-a2,#a57ae8);stroke-width:2\" d=\"M111.9 84.8l0-17.5 60.6 35 0 17.5\"/></g><g class=\" s-a\"><use href=\"#sxs-hud-bwzh\" x=\"204\" y=\"40\"/><clipPath id=\"bwzh-hw\"><rect x=\"210\" y=\"32\" width=\"62\" height=\"16\"/></clipPath><g clip-path=\"url(#bwzh-hw)\"><g class=\"bwzh-h s-a\"><use href=\"#sxs-rows-bwzh\" x=\"204\" y=\"40\"/></g></g></g>",
}
