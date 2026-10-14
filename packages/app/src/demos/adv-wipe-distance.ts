// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Wipe distance: how far the nozzle moves back along the last line while it wipes.
import type { StageTool } from '@slicerx/ui'

export const loop: StageTool = {
  id: 'bwwd',
  readout: {rows: ["1 mm","4 mm"],w: 64},
  css: ".bwwd0{animation-name:bwwd0;animation-timing-function:steps(1,end)}@keyframes bwwd0{0%{opacity:1}50%{opacity:0}98.6%{opacity:1}100%{opacity:1}}.bwwd1{animation-name:bwwd1;animation-timing-function:steps(1,end)}@keyframes bwwd1{0%{opacity:0}50%{opacity:1}98.6%{opacity:0}100%{opacity:0}}.bwwd-h{animation-name:bwwd-h;animation-timing-function:steps(1,end)}@keyframes bwwd-h{0%{translate:0 0px}50%{translate:0 -14px}98.6%{translate:0 0px}100%{translate:0 0px}}",
  body: "<polygon class=\"s-f2 s-ol\" points=\"81.6,106.5 160.4,152 160.4,145 81.6,99.5\"/><polygon class=\"s-f3 s-ol\" points=\"202.8,127.5 160.4,152 160.4,145 202.8,120.5\"/><polygon class=\"s-f1 s-ol\" points=\"124,75 202.8,120.5 160.4,145 81.6,99.5\"/><path class=\"s-n\" style=\"stroke:var(--stage-t3,#6c7086);stroke-width:3\" d=\"M108.8 90.2l60.7 35\"/><g class=\"bwwd0 s-a\"><path class=\"s-n\" style=\"stroke:var(--stage-a2,#a57ae8);stroke-width:2\" d=\"M167.6 124.9l-6-3.5\"/></g><g class=\"bwwd1 s-a\"><path class=\"s-n\" style=\"stroke:var(--stage-a2,#a57ae8);stroke-width:2\" d=\"M167.6 124.9l-24.2-14\"/></g><g class=\" s-a\"><use href=\"#sxs-hud-bwwd\" x=\"212\" y=\"40\"/><clipPath id=\"bwwd-hw\"><rect x=\"218\" y=\"32\" width=\"54\" height=\"16\"/></clipPath><g clip-path=\"url(#bwwd-hw)\"><g class=\"bwwd-h s-a\"><use href=\"#sxs-rows-bwwd\" x=\"212\" y=\"40\"/></g></g></g>",
}
