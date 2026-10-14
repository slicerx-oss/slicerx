// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// XY contour compensation: when parts print a little too large, a small negative value shrinks the outside back to size.
import type { StageTool } from '@slicerx/ui'

export const loop: StageTool = {
  id: 'bwxc',
  readout: {rows: ["0 mm","-0.05 mm"],w: 80},
  css: ".bwxc0{animation-name:bwxc0;animation-timing-function:steps(1,end)}@keyframes bwxc0{0%{opacity:1}50%{opacity:0}98.6%{opacity:1}100%{opacity:1}}.bwxc1{animation-name:bwxc1;animation-timing-function:steps(1,end)}@keyframes bwxc1{0%{opacity:0}50%{opacity:1}98.6%{opacity:0}100%{opacity:0}}.bwxc-h{animation-name:bwxc-h;animation-timing-function:steps(1,end)}@keyframes bwxc-h{0%{translate:0 0px}50%{translate:0 -14px}98.6%{translate:0 0px}100%{translate:0 0px}}",
  body: "<g class=\"bwxc0 s-a\"><polygon class=\"s-f2 s-ol\" points=\"84,110 148.2,147.1 148.2,136.6 84,99.5\"/><polygon class=\"s-f3 s-ol\" points=\"188.3,124 148.2,147.1 148.2,136.6 188.3,113.5\"/><polygon class=\"s-f1 s-ol\" points=\"124,76.4 188.3,113.5 148.2,136.6 84,99.5\"/><path class=\"s-n\" style=\"stroke:var(--stage-cut,#ff5555);stroke-width:1.8\" d=\"M124 76.2l64.3 37.1-40.1 23.1-64.2-37.1z\"/><path class=\"s-ghost\" style=\"stroke:var(--stage-a1,#c9a6fb)\" d=\"M124 78.2l60.6 35-36.4 21-60.6-35z\"/></g><g class=\"bwxc1 s-a\"><polygon class=\"s-f2 s-ol\" points=\"87.6,110 148.2,145 148.2,134.5 87.6,99.5\"/><polygon class=\"s-f3 s-ol\" points=\"184.6,124 148.2,145 148.2,134.5 184.6,113.5\"/><polygon class=\"s-f1 s-ol\" points=\"124,78.5 184.6,113.5 148.2,134.5 87.6,99.5\"/><path class=\"s-ghost\" style=\"stroke:var(--stage-a1,#c9a6fb)\" d=\"M124 78.2l60.6 35-36.4 21-60.6-35z\"/></g><g class=\" s-a\"><use href=\"#sxs-hud-bwxc\" x=\"198\" y=\"40\"/><clipPath id=\"bwxc-hw\"><rect x=\"204\" y=\"32\" width=\"70\" height=\"16\"/></clipPath><g clip-path=\"url(#bwxc-hw)\"><g class=\"bwxc-h s-a\"><use href=\"#sxs-rows-bwxc\" x=\"198\" y=\"40\"/></g></g></g>",
}
