// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Skirt height: the skirt rises this many layers, a low fence that also shields the part from drafts.
import type { StageTool } from '@slicerx/ui'

export const loop: StageTool = {
  id: 'brkh',
  readout: {rows: ["1 layer","4 layers"],w: 72},
  css: ".brkh0{animation-name:brkh0;animation-timing-function:steps(1,end)}@keyframes brkh0{0%{opacity:1}50%{opacity:0}98.6%{opacity:1}100%{opacity:1}}.brkh1{animation-name:brkh1;animation-timing-function:steps(1,end)}@keyframes brkh1{0%{opacity:0}50%{opacity:1}98.6%{opacity:0}100%{opacity:0}}.brkh-h{animation-name:brkh-h;animation-timing-function:steps(1,end)}@keyframes brkh-h{0%{translate:0 0px}50%{translate:0 -14px}98.6%{translate:0 0px}100%{translate:0 0px}}",
  body: "<polygon class=\"s-f2 s-ol\" points=\"99.8,110 136.1,131 136.1,106.5 99.8,85.5\"/><polygon class=\"s-f3 s-ol\" points=\"160.4,117 136.1,131 136.1,106.5 160.4,92.5\"/><polygon class=\"s-f1 s-ol\" points=\"124,71.5 160.4,92.5 136.1,106.5 99.8,85.5\"/><g class=\"brkh0 s-a\"><path class=\"s-n\" style=\"stroke:var(--stage-a1,#c9a6fb);stroke-width:1.6\" d=\"M124 81.3l60.6 35-48.5 28-60.6-35z\"/></g><g class=\"brkh1 s-a\"><path class=\"s-n\" style=\"stroke:var(--stage-a1,#c9a6fb);stroke-width:1.6\" d=\"M124 81.3l60.6 35-48.5 28-60.6-35zM124 78.9l60.6 35-48.5 28-60.6-35zM124 76.4l60.6 35-48.5 28-60.6-35zM124 74l60.6 35-48.5 28-60.6-35z\"/></g><g class=\" s-a\"><use href=\"#sxs-hud-brkh\" x=\"204\" y=\"40\"/><clipPath id=\"brkh-hw\"><rect x=\"210\" y=\"32\" width=\"62\" height=\"16\"/></clipPath><g clip-path=\"url(#brkh-hw)\"><g class=\"brkh-h s-a\"><use href=\"#sxs-rows-brkh\" x=\"204\" y=\"40\"/></g></g></g>",
}
