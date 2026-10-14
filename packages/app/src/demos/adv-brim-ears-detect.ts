// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Brim ears detection: ears go under each corner sharper than the max angle; a lower angle leaves only the sharpest.
import type { StageTool } from '@slicerx/ui'

export const loop: StageTool = {
  id: 'abe',
  readout: {rows: ["125°","45°"],w: 48},
  css: ".sxs .abe-s{animation-timing-function:steps(1,end)}.sxs .abe-a{animation-name:abe-a}@keyframes abe-a{0%{opacity:1}45.7%{opacity:0}94.3%{opacity:1}100%{opacity:1}}.sxs .abe-b{animation-name:abe-b}@keyframes abe-b{0%{opacity:0}45.7%{opacity:1}94.3%{opacity:0}100%{opacity:0}}.sxs .abe-h{animation-name:abe-h}@keyframes abe-h{0%{translate:0 0px}45.7%{translate:0 -14px}94.3%{translate:0 0px}100%{translate:0 0px}}",
  body: "<g class=\"abe-a abe-s s-a\"><ellipse class=\"s-af\" cx=\"124\" cy=\"89\" rx=\"12.9\" ry=\"7.4\" style=\"stroke:var(--stage-a1,#c9a6fb);stroke-width:1.6\"/><ellipse class=\"s-af\" cx=\"87.6\" cy=\"110\" rx=\"12.9\" ry=\"7.4\" style=\"stroke:var(--stage-a1,#c9a6fb);stroke-width:1.6\"/></g><ellipse class=\"s-af\" cx=\"178.6\" cy=\"141.5\" rx=\"12.9\" ry=\"7.4\" style=\"stroke:var(--stage-a1,#c9a6fb);stroke-width:1.6\"/><polygon class=\"s-f2 s-ol\" points=\"178.6,141.5 87.6,110 87.6,96 178.6,127.5\"/><polygon class=\"s-f1 s-ol\" points=\"124,75 178.6,127.5 87.6,96\"/><g class=\" s-a\"><use href=\"#sxs-hud-abe\" x=\"218.8\" y=\"119.5\"/><clipPath id=\"abe-hw\"><rect x=\"224.8\" y=\"111.5\" width=\"38\" height=\"16\"/></clipPath><g clip-path=\"url(#abe-hw)\"><g class=\"abe-h abe-s s-a\"><use href=\"#sxs-rows-abe\" x=\"218.8\" y=\"119.5\"/></g></g></g>",
}
