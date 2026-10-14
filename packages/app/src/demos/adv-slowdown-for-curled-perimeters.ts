// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Slow down for curled perimeters: where an overhang's edge would curl up, the walls print slower so it lies flat and the nozzle does not catch it.
import type { StageTool } from '@slicerx/ui'

export const loop: StageTool = {
  id: 'brcw',
  readout: {rows: ["Off","On"],w: 64},
  css: ".brcw0{animation-name:brcw0;animation-timing-function:steps(1,end)}@keyframes brcw0{0%{opacity:1}50%{opacity:0}98.6%{opacity:1}100%{opacity:1}}.brcw1{animation-name:brcw1;animation-timing-function:steps(1,end)}@keyframes brcw1{0%{opacity:0}50%{opacity:1}98.6%{opacity:0}100%{opacity:0}}.brcw-h{animation-name:brcw-h;animation-timing-function:steps(1,end)}@keyframes brcw-h{0%{translate:0 0px}50%{translate:0 -14px}98.6%{translate:0 0px}100%{translate:0 0px}}",
  body: "<polygon class=\"s-f2 s-ol\" points=\"87.6,103 111.9,117 111.9,75 87.6,61\"/><polygon class=\"s-f3 s-ol\" points=\"136.1,103 111.9,117 111.9,75 136.1,61\"/><polygon class=\"s-f1 s-ol\" points=\"111.9,47 136.1,61 111.9,75 87.6,61\"/><polygon class=\"s-f2 s-ol\" points=\"111.9,85.5 148.2,106.5 148.2,96 111.9,75\"/><polygon class=\"s-f3 s-ol\" points=\"172.5,92.5 148.2,106.5 148.2,96 172.5,82\"/><polygon class=\"s-f1 s-ol\" points=\"136.1,61 172.5,82 148.2,96 111.9,75\"/><g class=\"brcw0 s-a\"><path class=\"s-n\" style=\"stroke:var(--stage-cut,#ff5555);stroke-width:2.4\" d=\"M148.2 96Q154.3 94.3 151.3 87.3\"/><path class=\"s-n\" stroke-dasharray=\"2 2\" style=\"stroke:var(--stage-cut,#ff5555);stroke-width:1.4\" d=\"M148.2 96l24.3-14\"/></g><g class=\"brcw1 s-a\"></g><g class=\" s-a\"><use href=\"#sxs-hud-brcw\" x=\"212\" y=\"40\"/><clipPath id=\"brcw-hw\"><rect x=\"218\" y=\"32\" width=\"54\" height=\"16\"/></clipPath><g clip-path=\"url(#brcw-hw)\"><g class=\"brcw-h s-a\"><use href=\"#sxs-rows-brcw\" x=\"212\" y=\"40\"/></g></g></g>",
}
