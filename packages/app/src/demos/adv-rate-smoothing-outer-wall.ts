// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Smoothing on the outer wall only: the outer wall keeps its ramp; inner lines change flow at once.
import type { StageTool } from '@slicerx/ui'

export const loop: StageTool = {
  id: 'bqro',
  readout: {rows: ["All lines","Outer wall"],w: 82},
  css: ".bqro0{animation-name:bqro0;animation-timing-function:steps(1,end)}@keyframes bqro0{0%{opacity:1}50%{opacity:0}98.6%{opacity:1}100%{opacity:1}}.bqro1{animation-name:bqro1;animation-timing-function:steps(1,end)}@keyframes bqro1{0%{opacity:0}50%{opacity:1}98.6%{opacity:0}100%{opacity:0}}.bqro-h{animation-name:bqro-h;animation-timing-function:steps(1,end)}@keyframes bqro-h{0%{translate:0 0px}50%{translate:0 -14px}98.6%{translate:0 0px}100%{translate:0 0px}}",
  body: "<polygon class=\"s-f2 s-ol\" points=\"85.8,83.1 194.9,146.1 194.9,100.6 85.8,37.6\"/><polygon class=\"s-f3 s-ol\" points=\"196.7,145 194.9,146.1 194.9,100.6 196.7,99.5\"/><polygon class=\"s-f1 s-ol\" points=\"87.6,36.5 196.7,99.5 194.9,100.6 85.8,37.6\"/><path class=\"s-n\" style=\"stroke:var(--stage-t3,#6c7086);stroke-width:1.2\" d=\"M91.9 83.1l97 56\"/><g class=\"bqro0 s-a\"><path class=\"s-n\" style=\"stroke:var(--stage-a2,#a57ae8);stroke-width:2.4\" d=\"M91.9 70.8l30.3 17.5 18.2-14 18.2 10.5 18.1 35 12.2 7\"/><path class=\"s-n\" style=\"stroke:var(--stage-t3,#6c7086);stroke-width:2\" d=\"M91.9 81.3l30.3 17.5 18.2-14 18.2 10.5 18.1 35 12.2 7\"/></g><g class=\"bqro1 s-a\"><path class=\"s-n\" style=\"stroke:var(--stage-a2,#a57ae8);stroke-width:2.4\" d=\"M91.9 70.8l30.3 17.5 18.2-14 18.2 10.5 18.1 35 12.2 7\"/><path class=\"s-n\" style=\"stroke:var(--stage-t3,#6c7086);stroke-width:2\" d=\"M91.9 81.3l36.3 21 0-28 3.1 17.5 9.1-7 24.2 14 0 29.8 4.6-7.9 1.5 6.1 18.2 10.5\"/></g><g class=\" s-a\"><use href=\"#sxs-hud-bqro\" x=\"200\" y=\"40\"/><clipPath id=\"bqro-hw\"><rect x=\"206\" y=\"32\" width=\"72\" height=\"16\"/></clipPath><g clip-path=\"url(#bqro-hw)\"><g class=\"bqro-h s-a\"><use href=\"#sxs-rows-bqro\" x=\"200\" y=\"40\"/></g></g></g>",
}
