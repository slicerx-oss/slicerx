// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Branch distance: how far apart the branch tips sit under the part; closer holds better and is harder to remove.
import type { StageTool } from '@slicerx/ui'

export const loop: StageTool = {
  id: 'bttb',
  readout: {rows: ["8 mm","3 mm"],w: 64},
  css: ".bttb0{animation-name:bttb0;animation-timing-function:steps(1,end)}@keyframes bttb0{0%{opacity:1}50%{opacity:0}98.6%{opacity:1}100%{opacity:1}}.bttb1{animation-name:bttb1;animation-timing-function:steps(1,end)}@keyframes bttb1{0%{opacity:0}50%{opacity:1}98.6%{opacity:0}100%{opacity:0}}.bttb-h{animation-name:bttb-h;animation-timing-function:steps(1,end)}@keyframes bttb-h{0%{translate:0 0px}50%{translate:0 -14px}98.6%{translate:0 0px}100%{translate:0 0px}}",
  body: "<polygon class=\"s-f2 s-ol\" points=\"87.6,103 105.8,113.5 105.8,64.5 87.6,54\"/><polygon class=\"s-f3 s-ol\" points=\"130.1,99.5 105.8,113.5 105.8,64.5 130.1,50.5\"/><polygon class=\"s-f1 s-ol\" points=\"111.9,40 130.1,50.5 105.8,64.5 87.6,54\"/><polygon class=\"s-f2 s-ol\" points=\"105.8,78.5 160.4,110 160.4,96 105.8,64.5\"/><polygon class=\"s-f3 s-ol\" points=\"184.6,96 160.4,110 160.4,96 184.6,82\"/><polygon class=\"s-f1 s-ol\" points=\"130.1,50.5 184.6,82 160.4,96 105.8,64.5\"/><g class=\"bttb0 s-a\"><path class=\"s-n\" style=\"stroke:var(--stage-a2,#a57ae8);stroke-width:2.6\" d=\"M134.3 132.1l0-17.5M134.3 114.6Q123.7 96.2 113.1 84.8M134.3 114.6Q134.3 102.3 134.3 97.1M134.3 114.6Q144.9 108.4 155.5 109.3\"/></g><g class=\"bttb1 s-a\"><path class=\"s-n\" style=\"stroke:var(--stage-a2,#a57ae8);stroke-width:2.2\" d=\"M134.3 132.1l0-17.5M134.3 114.6Q122.2 95.3 110.1 83.1M134.3 114.6Q126.7 97.9 119.2 88.3M134.3 114.6Q131.3 100.6 128.2 93.6M134.3 114.6Q135.8 103.2 137.3 98.8M134.3 114.6Q140.4 105.8 146.4 104.1M134.3 114.6Q144.9 108.4 155.5 109.3\"/></g><g class=\" s-a\"><use href=\"#sxs-hud-bttb\" x=\"212\" y=\"40\"/><clipPath id=\"bttb-hw\"><rect x=\"218\" y=\"32\" width=\"54\" height=\"16\"/></clipPath><g clip-path=\"url(#bttb-hw)\"><g class=\"bttb-h s-a\"><use href=\"#sxs-rows-bttb\" x=\"212\" y=\"40\"/></g></g></g>",
}
