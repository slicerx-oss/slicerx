// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Support pattern angle: turns the support lines on the bed, for example so they run across a part's long edge.
import type { StageTool } from '@slicerx/ui'

export const loop: StageTool = {
  id: 'brsn',
  readout: {rows: ["0°","45°"],w: 64},
  css: ".brsn0{animation-name:brsn0;animation-timing-function:steps(1,end)}@keyframes brsn0{0%{opacity:1}50%{opacity:0}98.6%{opacity:1}100%{opacity:1}}.brsn1{animation-name:brsn1;animation-timing-function:steps(1,end)}@keyframes brsn1{0%{opacity:0}50%{opacity:1}98.6%{opacity:0}100%{opacity:0}}.brsn-h{animation-name:brsn-h;animation-timing-function:steps(1,end)}@keyframes brsn-h{0%{translate:0 0px}50%{translate:0 -14px}98.6%{translate:0 0px}100%{translate:0 0px}}",
  body: "<g class=\"brsn0 s-a\"><polygon class=\"s-f2 s-ol\" points=\"81.6,113.5 148.2,152 148.2,131 81.6,92.5\"/><polygon class=\"s-f3 s-ol\" points=\"196.7,124 148.2,152 148.2,131 196.7,103\"/><polygon class=\"s-f1 s-ol\" points=\"130.1,64.5 196.7,103 148.2,131 81.6,92.5\"/><path class=\"s-n\" style=\"stroke:var(--stage-a2,#a57ae8);stroke-width:1.4\" d=\"M127 68l63.1 36.4l-6.1 3.5l-63-36.4l-6.1 3.5l63.1 36.4l-6.1 3.5l-63.1-36.4l-6 3.5l63 36.4l-6 3.5l-63.1-36.4l-6 3.5l63 36.4\"/></g><g class=\"brsn1 s-a\"><polygon class=\"s-f2 s-ol\" points=\"81.6,113.5 148.2,152 148.2,131 81.6,92.5\"/><polygon class=\"s-f3 s-ol\" points=\"196.7,124 148.2,152 148.2,131 196.7,103\"/><polygon class=\"s-f1 s-ol\" points=\"130.1,64.5 196.7,103 148.2,131 81.6,92.5\"/><path class=\"s-n\" style=\"stroke:var(--stage-a2,#a57ae8);stroke-width:1.4\" d=\"M188.8 100.2l0 4.9l-8.6 5l0-14.9l-8.5-4.9l0 24.7l-8.6 5l0-34.7l-8.6-4.9l0 44.5l-8.5 2.3l0-51.8l-8.6-4.9l0 51.8l-8.6-5l0-50.3l-8.6 4.9l0 40.5l-8.5-5l0-30.5l-8.6 4.9l0 20.7l-8.6-5l0-10.7l-8.6 4.9l0 .9\"/></g><g class=\" s-a\"><use href=\"#sxs-hud-brsn\" x=\"212\" y=\"40\"/><clipPath id=\"brsn-hw\"><rect x=\"218\" y=\"32\" width=\"54\" height=\"16\"/></clipPath><g clip-path=\"url(#brsn-hw)\"><g class=\"brsn-h s-a\"><use href=\"#sxs-rows-brsn\" x=\"212\" y=\"40\"/></g></g></g>",
}
