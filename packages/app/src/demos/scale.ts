// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Scale: a block grown from its corner handle, uniformly, from 100 to 150 percent in 25 percent steps.
import type { StageTool } from '@slicerx/ui'

export const loop: StageTool = {
  id: 'sc',
  readout: {rows: ["100 %","125 %","150 %"],w: 58},
  css: ".sxs .sc-s{animation-timing-function:steps(1,end)}.sxs .sc-h{animation-name:sc-h}@keyframes sc-h{0%{translate:0 0px}26.1%{translate:0 -14px}38.3%{translate:0 -28px}97.1%{translate:0 0px}100%{translate:0 0px}}.sxs .sc-b{transform-box:view-box;transform-origin:124px 89px}.sxs .sc-b{animation-name:sc-b}@keyframes sc-b{0%{scale:1}20%{scale:1}32.1%{scale:1.25}37.1%{scale:1.25}39.4%{scale:1.5}88.6%{scale:1.5;animation-timing-function:cubic-bezier(.65,0,.35,1)}97.1%{scale:1}100%{scale:1}}.sxs .sc-p{animation-name:sc-p}@keyframes sc-p{0%{translate:0 0}20%{translate:0px 0px}32.1%{translate:1.5px 0.9px}37.1%{translate:1.5px 0.9px}39.4%{translate:3px 1.8px}88.6%{translate:3px 1.8px;animation-timing-function:cubic-bezier(.65,0,.35,1)}97.1%{translate:0 0}100%{translate:0 0}}",
  body: "<g class=\"sc-b s-a\"><polygon class=\"s-f2 s-ol\" points=\"99.8,103 130.1,120.5 130.1,92.5 99.8,75\"/><polygon class=\"s-f3 s-ol\" points=\"154.3,106.5 130.1,120.5 130.1,92.5 154.3,78.5\"/><polygon class=\"s-f1 s-ol\" points=\"124,61 154.3,78.5 130.1,92.5 99.8,75\"/></g><g class=\"sc-p s-a\"><rect class=\"s-g1 s-aol\" x=\"127.1\" y=\"89.5\" width=\"6\" height=\"6\" rx=\"1\"/><circle class=\"sxs-rip s-a\" cx=\"131.1\" cy=\"93.5\" r=\"9\"/><use href=\"#sxs-ptr\" x=\"131.1\" y=\"93.5\"/><g class=\"s-hud s-a\"><use href=\"#sxs-hud-sc\" x=\"154.1\" y=\"114.5\"/><clipPath id=\"sc-hw\"><rect x=\"160.1\" y=\"106.5\" width=\"48\" height=\"16\"/></clipPath><g clip-path=\"url(#sc-hw)\"><g class=\"sc-h sc-s s-a\"><use href=\"#sxs-rows-sc\" x=\"154.1\" y=\"114.5\"/></g></g></g></g>",
}
