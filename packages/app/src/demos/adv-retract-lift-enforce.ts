// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Enforce lift on: lifting over top surfaces keeps the nozzle from scratching them; bottom only drags across the top.
import type { StageTool } from '@slicerx/ui'

export const loop: StageTool = {
  id: 'bqze',
  readout: {rows: ["All surfaces","Bottom only","Top only"],w: 96},
  css: ".bqze0{animation-name:bqze0;animation-timing-function:steps(1,end)}@keyframes bqze0{0%{opacity:1}32.9%{opacity:0}98.6%{opacity:1}100%{opacity:1}}.bqze1{animation-name:bqze1;animation-timing-function:steps(1,end)}@keyframes bqze1{0%{opacity:0}32.9%{opacity:1}65.7%{opacity:0}100%{opacity:0}}.bqze2{animation-name:bqze2;animation-timing-function:steps(1,end)}@keyframes bqze2{0%{opacity:0}65.7%{opacity:1}98.6%{opacity:0}100%{opacity:0}}.bqze-h{animation-name:bqze-h;animation-timing-function:steps(1,end)}@keyframes bqze-h{0%{translate:0 0px}32.9%{translate:0 -14px}65.7%{translate:0 -28px}98.6%{translate:0 0px}100%{translate:0 0px}}",
  body: "<polygon class=\"s-f2 s-ol\" points=\"81.6,106.5 148.2,145 148.2,124 81.6,85.5\"/><polygon class=\"s-f3 s-ol\" points=\"190.7,120.5 148.2,145 148.2,124 190.7,99.5\"/><polygon class=\"s-f1 s-ol\" points=\"124,61 190.7,99.5 148.2,124 81.6,85.5\"/><g class=\"bqze0 s-a\"><path class=\"s-n\" style=\"stroke:var(--stage-a1,#c9a6fb);stroke-width:1.6\" d=\"M108.8 74.7Q136.1 71.5 163.4 106.2\"/></g><g class=\"bqze1 s-a\"><path class=\"s-n\" style=\"stroke:var(--stage-t2,#9da1b6);stroke-width:1.4\" d=\"M108.8 74.7l54.6 31.5\"/><path class=\"s-n\" style=\"stroke:var(--stage-cut,#ff5555);stroke-width:1.6\" d=\"M116.7 82.7l36.4 21\"/></g><g class=\"bqze2 s-a\"><path class=\"s-n\" style=\"stroke:var(--stage-a1,#c9a6fb);stroke-width:1.6\" d=\"M108.8 74.7Q136.1 71.5 163.4 106.2\"/></g><g class=\" s-a\"><use href=\"#sxs-hud-bqze\" x=\"186\" y=\"40\"/><clipPath id=\"bqze-hw\"><rect x=\"192\" y=\"32\" width=\"86\" height=\"16\"/></clipPath><g clip-path=\"url(#bqze-hw)\"><g class=\"bqze-h s-a\"><use href=\"#sxs-rows-bqze\" x=\"186\" y=\"40\"/></g></g></g>",
}
