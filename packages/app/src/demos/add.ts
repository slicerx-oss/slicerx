// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Add: a cylinder dropped onto the plate beside a block, then a box.
import type { StageTool } from '@slicerx/ui'

export const loop: StageTool = {
  id: 'ad',
  badge: {add: 0.55},
  css: ".sxs .ad-a{animation-name:ad-a}.sxs .ad-b{animation-name:ad-b}.sxs .ad-m{animation-name:ad-m}.sxs .ad-w{animation-name:ad-w}@keyframes ad-a{0%{opacity:0;translate:0px -42px}15.7%{opacity:0;translate:0px -42px}18.6%{opacity:1;translate:0px -31.5px}28.6%{opacity:1;translate:0 0}90%{opacity:1;translate:0 0}97.1%{opacity:0;translate:0 0}100%{opacity:0;translate:0 0}}@keyframes ad-b{0%{opacity:0;translate:0px -42px}45.7%{opacity:0;translate:0px -42px}48.6%{opacity:1;translate:0px -31.5px}58.6%{opacity:1;translate:0 0}90%{opacity:1;translate:0 0}97.1%{opacity:0;translate:0 0}100%{opacity:0;translate:0 0}}@keyframes ad-m{0%{opacity:0}4.3%{opacity:1}17.1%{opacity:1}25.7%{opacity:0}100%{opacity:0}}@keyframes ad-w{0%{opacity:0}2%{opacity:0}4.3%{opacity:1}15.7%{opacity:1}20%{opacity:0}100%{opacity:0}}",
  body: "<polygon class=\"s-f2 s-ol\" points=\"87.6,103 124,124 124,89 87.6,68\"/><polygon class=\"s-f3 s-ol\" points=\"160.4,103 124,124 124,89 160.4,68\"/><polygon class=\"s-f1 s-ol\" points=\"124,47 160.4,68 124,89 87.6,68\"/><ellipse class=\"ad-m s-a s-n s-al\" cx=\"184.6\" cy=\"138\" rx=\"21.4\" ry=\"12.4\" style=\"stroke-dasharray:3 2.5\"/><g class=\"ad-a s-a\"><path class=\"s-cya s-aol\" d=\"M163.2 103V138A21.4 12.4 0 0 0 206 138V103A21.4 12.4 0 0 1 163.2 103Z\"/><ellipse class=\"s-g1 s-aol\" cx=\"184.6\" cy=\"103\" rx=\"21.4\" ry=\"12.4\"/></g><g class=\"ad-b s-a\"><polygon class=\"s-g2 s-aol\" points=\"54.3,129.3 78.5,143.3 78.5,122.3 54.3,108.3\"/><polygon class=\"s-g3 s-aol\" points=\"102.8,129.3 78.5,143.3 78.5,122.3 102.8,108.3\"/><polygon class=\"s-g1 s-aol\" points=\"78.5,94.3 102.8,108.3 78.5,122.3 54.3,108.3\"/></g><g class=\"ad-w s-a\"><use href=\"#sxs-arw\" transform=\"translate(184.6 60) rotate(180)\"/></g><circle class=\"sxs-rip s-a\" cx=\"187.7\" cy=\"146.8\" r=\"9\"/><use href=\"#sxs-ptr\" x=\"187.7\" y=\"146.8\"/>",
}
