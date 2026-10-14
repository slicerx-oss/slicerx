// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Branch walls: how many walls each tree branch gets; more walls make stiffer branches.
import type { StageTool } from '@slicerx/ui'

export const loop: StageTool = {
  id: 'bttw',
  readout: {rows: ["1 wall","2 walls"],w: 72},
  css: ".bttw0{animation-name:bttw0;animation-timing-function:steps(1,end)}@keyframes bttw0{0%{opacity:1}50%{opacity:0}98.6%{opacity:1}100%{opacity:1}}.bttw1{animation-name:bttw1;animation-timing-function:steps(1,end)}@keyframes bttw1{0%{opacity:0}50%{opacity:1}98.6%{opacity:0}100%{opacity:0}}.bttw-h{animation-name:bttw-h;animation-timing-function:steps(1,end)}@keyframes bttw-h{0%{translate:0 0px}50%{translate:0 -14px}98.6%{translate:0 0px}100%{translate:0 0px}}",
  body: "<g class=\"bttw0 s-a\"><path class=\"s-cy s-ol\" d=\"M135.3 92.5V124A12.9 7.4 0 0 0 161.1 124V92.5A12.9 7.4 0 0 1 135.3 92.5Z\"/><ellipse class=\"s-f1 s-ol\" cx=\"148.2\" cy=\"92.5\" rx=\"12.9\" ry=\"7.4\"/><ellipse class=\"s-n\" cx=\"148.2\" cy=\"92.5\" rx=\"10.3\" ry=\"5.9\" style=\"stroke:var(--stage-a2,#a57ae8);stroke-width:1.6\"/></g><g class=\"bttw1 s-a\"><path class=\"s-cy s-ol\" d=\"M135.3 92.5V124A12.9 7.4 0 0 0 161.1 124V92.5A12.9 7.4 0 0 1 135.3 92.5Z\"/><ellipse class=\"s-f1 s-ol\" cx=\"148.2\" cy=\"92.5\" rx=\"12.9\" ry=\"7.4\"/><ellipse class=\"s-n\" cx=\"148.2\" cy=\"92.5\" rx=\"10.3\" ry=\"5.9\" style=\"stroke:var(--stage-a2,#a57ae8);stroke-width:1.6\"/><ellipse class=\"s-n\" cx=\"148.2\" cy=\"92.5\" rx=\"6\" ry=\"3.5\" style=\"stroke:var(--stage-a2,#a57ae8);stroke-width:1.6\"/></g><g class=\" s-a\"><use href=\"#sxs-hud-bttw\" x=\"204\" y=\"40\"/><clipPath id=\"bttw-hw\"><rect x=\"210\" y=\"32\" width=\"62\" height=\"16\"/></clipPath><g clip-path=\"url(#bttw-hw)\"><g class=\"bttw-h s-a\"><use href=\"#sxs-rows-bttw\" x=\"204\" y=\"40\"/></g></g></g>",
}
