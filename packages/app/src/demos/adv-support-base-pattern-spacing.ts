// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Support base spacing: the gap between support lines; wider uses less filament and comes off easier, but holds less.
import type { StageTool } from '@slicerx/ui'

export const loop: StageTool = {
  id: 'brbs',
  readout: {rows: ["1 mm","3 mm"],w: 64},
  css: ".brbs0{animation-name:brbs0;animation-timing-function:steps(1,end)}@keyframes brbs0{0%{opacity:1}50%{opacity:0}98.6%{opacity:1}100%{opacity:1}}.brbs1{animation-name:brbs1;animation-timing-function:steps(1,end)}@keyframes brbs1{0%{opacity:0}50%{opacity:1}98.6%{opacity:0}100%{opacity:0}}.brbs-h{animation-name:brbs-h;animation-timing-function:steps(1,end)}@keyframes brbs-h{0%{translate:0 0px}50%{translate:0 -14px}98.6%{translate:0 0px}100%{translate:0 0px}}",
  body: "<g class=\"brbs0 s-a\"><polygon class=\"s-f2 s-ol\" points=\"81.6,113.5 148.2,152 148.2,131 81.6,92.5\"/><polygon class=\"s-f3 s-ol\" points=\"196.7,124 148.2,152 148.2,131 196.7,103\"/><polygon class=\"s-f1 s-ol\" points=\"130.1,64.5 196.7,103 148.2,131 81.6,92.5\"/><path class=\"s-n\" style=\"stroke:var(--stage-a2,#a57ae8);stroke-width:1.4\" d=\"M127.9 67.5l63.1 36.4l-4.3 2.4l-63-36.4l-4.2 2.5l63 36.4l-4.2 2.4l-63.1-36.4l-4.2 2.5l63 36.4l-4.2 2.4l-63.1-36.4l-4.2 2.5l63 36.4l-4.2 2.4l-63.1-36.4l-4.2 2.5l63 36.4l-4.2 2.4l-63.1-36.4l-4.2 2.5l63.1 36.4\"/></g><g class=\"brbs1 s-a\"><polygon class=\"s-f2 s-ol\" points=\"81.6,113.5 148.2,152 148.2,131 81.6,92.5\"/><polygon class=\"s-f3 s-ol\" points=\"196.7,124 148.2,152 148.2,131 196.7,103\"/><polygon class=\"s-f1 s-ol\" points=\"130.1,64.5 196.7,103 148.2,131 81.6,92.5\"/><path class=\"s-n\" style=\"stroke:var(--stage-a2,#a57ae8);stroke-width:1.4\" d=\"M125.2 69.1l63.1 36.4l-9.7 5.6l-63.1-36.4l-9.7 5.6l63.1 36.4l-9.7 5.6l-63.1-36.4l-9.7 5.6l63.1 36.4\"/></g><g class=\" s-a\"><use href=\"#sxs-hud-brbs\" x=\"212\" y=\"40\"/><clipPath id=\"brbs-hw\"><rect x=\"218\" y=\"32\" width=\"54\" height=\"16\"/></clipPath><g clip-path=\"url(#brbs-hw)\"><g class=\"brbs-h s-a\"><use href=\"#sxs-rows-brbs\" x=\"212\" y=\"40\"/></g></g></g>",
}
