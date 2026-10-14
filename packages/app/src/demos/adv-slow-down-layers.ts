// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Slow down layers: the first layers after the first one ramp up to full speed, which helps the bottom stick and stay flat.
import type { StageTool } from '@slicerx/ui'

export const loop: StageTool = {
  id: 'brsl',
  readout: {rows: ["0 layers","3 layers"],w: 72},
  css: ".brsl0{animation-name:brsl0;animation-timing-function:steps(1,end)}@keyframes brsl0{0%{opacity:1}50%{opacity:0}98.6%{opacity:1}100%{opacity:1}}.brsl1{animation-name:brsl1;animation-timing-function:steps(1,end)}@keyframes brsl1{0%{opacity:0}50%{opacity:1}98.6%{opacity:0}100%{opacity:0}}.brsl-h{animation-name:brsl-h;animation-timing-function:steps(1,end)}@keyframes brsl-h{0%{translate:0 0px}50%{translate:0 -14px}98.6%{translate:0 0px}100%{translate:0 0px}}",
  body: "<polygon class=\"s-f2 s-ol\" points=\"87.6,103 160.4,145 160.4,103 87.6,61\"/><polygon class=\"s-f3 s-ol\" points=\"196.7,124 160.4,145 160.4,103 196.7,82\"/><polygon class=\"s-f1 s-ol\" points=\"124,40 196.7,82 160.4,103 87.6,61\"/><path class=\"s-n\" style=\"stroke:var(--stage-t3,#6c7086);stroke-width:1\" d=\"M87.6 97.8l72.8 42M87.6 92.5l72.8 42M87.6 87.3l72.8 42M87.6 82l72.8 42M87.6 76.8l72.8 42M87.6 71.5l72.8 42M87.6 66.3l72.8 42\"/><g class=\"brsl0 s-a\"><polygon class=\"s-g1\" style=\"opacity:0.9\" points=\"87.6,103 160.4,145 160.4,139.8 87.6,97.8\"/></g><g class=\"brsl1 s-a\"><polygon class=\"s-g1\" style=\"opacity:0.9\" points=\"87.6,103 160.4,145 160.4,139.8 87.6,97.8\"/><polygon class=\"s-g1\" style=\"opacity:0.7\" points=\"87.6,97.8 160.4,139.8 160.4,134.5 87.6,92.5\"/><polygon class=\"s-g1\" style=\"opacity:0.5\" points=\"87.6,92.5 160.4,134.5 160.4,129.3 87.6,87.3\"/><polygon class=\"s-g1\" style=\"opacity:0.3\" points=\"87.6,87.3 160.4,129.3 160.4,124 87.6,82\"/></g><g class=\" s-a\"><use href=\"#sxs-hud-brsl\" x=\"204\" y=\"40\"/><clipPath id=\"brsl-hw\"><rect x=\"210\" y=\"32\" width=\"62\" height=\"16\"/></clipPath><g clip-path=\"url(#brsl-hw)\"><g class=\"brsl-h s-a\"><use href=\"#sxs-rows-brsl\" x=\"204\" y=\"40\"/></g></g></g>",
}
