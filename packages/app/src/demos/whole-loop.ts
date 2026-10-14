// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Whole loop: one top edge picked, then every edge around that face added.
import type { StageTool } from '@slicerx/ui'

export const loop: StageTool = {
  id: 'wh',
  css: ".sxs .wh-e{animation-name:wh-e}@keyframes wh-e{0%{stroke-dashoffset:100;opacity:0}14.3%{stroke-dashoffset:100;opacity:0}15.4%{stroke-dashoffset:96;opacity:1}17.1%{stroke-dashoffset:0}91.4%{opacity:1}97.1%{opacity:0}100%{opacity:0}}.sxs .wh-l{animation-name:wh-l}@keyframes wh-l{0%{stroke-dashoffset:100;opacity:0}34.3%{stroke-dashoffset:100;opacity:0}35.4%{stroke-dashoffset:96;opacity:1}54.3%{stroke-dashoffset:0}91.4%{opacity:1}97.1%{opacity:0}100%{opacity:0}}",
  body: "<polygon class=\"s-f2 s-ol\" points=\"81.6,106.5 148.2,145 148.2,117 81.6,78.5\"/><polygon class=\"s-f3 s-ol\" points=\"190.7,120.5 148.2,145 148.2,117 190.7,92.5\"/><polygon class=\"s-f1 s-ol\" points=\"124,54 190.7,92.5 148.2,117 81.6,78.5\"/><path class=\"wh-l s-a s-n\" pathLength=\"100\" style=\"stroke:var(--stage-a1,#c9a6fb);stroke-width:3;stroke-dasharray:100;filter:url(#sxs-glow)\" d=\"M148.2 117l42.5-24.5-66.7-38.5-42.4 24.5z\"/><path class=\"wh-e s-a s-n\" pathLength=\"100\" style=\"stroke:var(--stage-a1,#c9a6fb);stroke-width:3;stroke-dasharray:100;filter:url(#sxs-glow)\" d=\"M148.2 117l42.5-24.5\"/><circle class=\"sxs-rip s-a\" cx=\"167.2\" cy=\"109.2\" r=\"9\"/><use href=\"#sxs-ptr\" x=\"167.2\" y=\"109.2\"/>",
}
