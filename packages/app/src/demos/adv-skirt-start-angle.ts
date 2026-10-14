// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Skirt start angle: where on the skirt the nozzle starts printing, as an angle around the part.
import type { StageTool } from '@slicerx/ui'

export const loop: StageTool = {
  id: 'brka',
  readout: {rows: ["0°","90°","180°"],w: 64},
  css: ".brka0{animation-name:brka0;animation-timing-function:steps(1,end)}@keyframes brka0{0%{opacity:1}32.9%{opacity:0}98.6%{opacity:1}100%{opacity:1}}.brka1{animation-name:brka1;animation-timing-function:steps(1,end)}@keyframes brka1{0%{opacity:0}32.9%{opacity:1}65.7%{opacity:0}100%{opacity:0}}.brka2{animation-name:brka2;animation-timing-function:steps(1,end)}@keyframes brka2{0%{opacity:0}65.7%{opacity:1}98.6%{opacity:0}100%{opacity:0}}.brka-h{animation-name:brka-h;animation-timing-function:steps(1,end)}@keyframes brka-h{0%{translate:0 0px}32.9%{translate:0 -14px}65.7%{translate:0 -28px}98.6%{translate:0 0px}100%{translate:0 0px}}",
  body: "<path class=\"s-n\" style=\"stroke:var(--stage-a1,#c9a6fb);stroke-width:1.6\" d=\"M166.4 137.3l-6.3 3.1-7.1 2.3-7.7 1.6-8.1 .9-8.2 0-8.1-.9-7.7-1.6-7.2-2.3-6.2-3.1-5.3-3.6-4.1-4.1-2.9-4.5-1.4-4.7 0-4.7 1.4-4.7 2.9-4.5 4.1-4.1 5.3-3.6 6.2-3.1 7.2-2.3 7.7-1.6 8.1-.9 8.2 0 8.1 .9 7.7 1.6 7.1 2.3 6.3 3.1 5.3 3.6 4.1 4.1 2.8 4.5 1.5 4.7 0 4.7-1.5 4.7-2.8 4.5-4.1 4.1z\"/><polygon class=\"s-f2 s-ol\" points=\"102.8,118.8 133.1,136.3 133.1,111.8 102.8,94.3\"/><polygon class=\"s-f3 s-ol\" points=\"163.4,118.8 133.1,136.3 133.1,111.8 163.4,94.3\"/><polygon class=\"s-f1 s-ol\" points=\"133.1,76.8 163.4,94.3 133.1,111.8 102.8,94.3\"/><g class=\"brka0 s-a\"><ellipse class=\"s-g1 s-aol\" cx=\"166.4\" cy=\"137.3\" rx=\"5.6\" ry=\"3.2\"/></g><g class=\"brka1 s-a\"><ellipse class=\"s-g1 s-aol\" cx=\"99.8\" cy=\"137.3\" rx=\"5.6\" ry=\"3.2\"/></g><g class=\"brka2 s-a\"><ellipse class=\"s-g1 s-aol\" cx=\"99.8\" cy=\"98.8\" rx=\"5.6\" ry=\"3.2\"/></g><g class=\" s-a\"><use href=\"#sxs-hud-brka\" x=\"212\" y=\"40\"/><clipPath id=\"brka-hw\"><rect x=\"218\" y=\"32\" width=\"54\" height=\"16\"/></clipPath><g clip-path=\"url(#brka-hw)\"><g class=\"brka-h s-a\"><use href=\"#sxs-rows-brka\" x=\"212\" y=\"40\"/></g></g></g>",
}
