// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// On a face: letters moved onto a block's side, placed with a click, then raised out of the face.
import type { StageTool } from '@slicerx/ui'

export const loop: StageTool = {
  id: 'of',
  badge: {add: 1.25},
  css: ".sxs .of-g{animation-name:of-g}.sxs .of-t{animation-name:of-t}.sxs .of-u{animation-name:of-u}@keyframes of-g{0%{opacity:0;translate:-14px -8px}2.9%{opacity:0;translate:-14px -8px}8.6%{opacity:1;translate:-14px -8px}28.6%{opacity:1;translate:0 0}30%{opacity:0;translate:0 0}100%{opacity:0;translate:0 0}}@keyframes of-t{0%{opacity:0}27.7%{opacity:0}30%{opacity:1}90%{opacity:1}97.1%{opacity:0}100%{opacity:0}}.sxs .of-w{animation-name:of-w}@keyframes of-w{0%{opacity:0}32%{opacity:0}34.3%{opacity:1}60%{opacity:1}65.7%{opacity:0}100%{opacity:0}}@keyframes of-u{0%{translate:0 0}35.7%{translate:0 0}57.1%{translate:-4.2px 2.5px}88.6%{translate:-4.2px 2.5px}97.1%{translate:0 0}100%{translate:0 0}}",
  body: "<polygon class=\"s-f2 s-ol\" points=\"75.5,110 142.2,148.5 142.2,99.5 75.5,61\"/><polygon class=\"s-f3 s-ol\" points=\"190.7,120.5 142.2,148.5 142.2,99.5 190.7,71.5\"/><polygon class=\"s-f1 s-ol\" points=\"124,33 190.7,71.5 142.2,99.5 75.5,61\"/><g class=\"of-t s-a\"><text transform=\"matrix(3.031 1.75 0 3.5 90.7 103)\" style=\"font:800 8.5px var(--f-body,system-ui,sans-serif);fill:var(--stage-a3,#7f58c4)\">SX</text><g class=\"of-u s-a\"><text transform=\"matrix(3.031 1.75 0 3.5 90.7 103)\" style=\"font:800 8.5px var(--f-body,system-ui,sans-serif);fill:var(--stage-a1,#c9a6fb);stroke:var(--stage-aol,#2c1d4a);stroke-width:.25\">SX</text></g></g><g class=\"of-g s-a\"><text transform=\"matrix(3.031 1.75 0 3.5 90.7 103)\" style=\"font:800 8.5px var(--f-body,system-ui,sans-serif);fill:none;stroke:var(--stage-a1,#c9a6fb);stroke-width:.3;stroke-dasharray:1 .7\">SX</text><g transform=\"translate(30.3 26.3)\"><circle class=\"sxs-rip s-a\" cx=\"90.7\" cy=\"103\" r=\"9\" style=\"animation-delay:0.5s\"/><use href=\"#sxs-ptr\" x=\"90.7\" y=\"103\"/></g></g><g class=\"of-w s-a\"><use href=\"#sxs-arw\" transform=\"translate(127 125.8) rotate(240)\"/></g>",
}
