// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Lightning infill: thin branching trees inside the part hold up only the top surface; the angles set how far they spread.
import type { StageTool } from '@slicerx/ui'

export const loop: StageTool = {
  id: 'alt',
  readout: {rows: ["45°","30°"],w: 48},
  css: ".sxs .alt-s{animation-timing-function:steps(1,end)}.sxs .alt-a{animation-name:alt-a}@keyframes alt-a{0%{opacity:1}45.7%{opacity:0}94.3%{opacity:1}100%{opacity:1}}.sxs .alt-b{animation-name:alt-b}@keyframes alt-b{0%{opacity:0}45.7%{opacity:1}94.3%{opacity:0}100%{opacity:0}}.sxs .alt-h{animation-name:alt-h}@keyframes alt-h{0%{translate:0 0px}45.7%{translate:0 -14px}94.3%{translate:0 0px}100%{translate:0 0px}}",
  body: "<polygon class=\"s-hole s-ol\" points=\"93.7,99.5 172.5,145 172.5,103 93.7,57.5\"/><polygon class=\"s-f3 s-ol\" points=\"202.8,127.5 172.5,145 172.5,103 202.8,85.5\"/><polygon class=\"s-f1 s-ol\" points=\"124,40 202.8,85.5 172.5,103 93.7,57.5\"/><g transform=\"matrix(3.031 1.75 0 -3.5 93.7 99.5)\"><rect x=\"0\" y=\"11\" width=\"26\" height=\"1\" class=\"s-f1\"/><g class=\"alt-a alt-s s-a\"><path class=\"s-n\" style=\"stroke:var(--stage-a1,#c9a6fb);stroke-width:0.6\" d=\"M7 0V5M7 5L4 11M7 5L5.8 11M7 5L10 11M7 5L8.2 11M19 0V5M19 5L16 11M19 5L17.8 11M19 5L22 11M19 5L20.2 11\"/></g><g class=\"alt-b alt-s s-a\"><path class=\"s-n\" style=\"stroke:var(--stage-a1,#c9a6fb);stroke-width:0.6\" d=\"M7 0V5M7 5L1.5 11M7 5L4.8 11M7 5L12.5 11M7 5L9.2 11M19 0V5M19 5L13.5 11M19 5L16.8 11M19 5L24.5 11M19 5L21.2 11\"/></g></g><g class=\" s-a\"><use href=\"#sxs-hud-alt\" x=\"218.8\" y=\"106.5\"/><clipPath id=\"alt-hw\"><rect x=\"224.8\" y=\"98.5\" width=\"38\" height=\"16\"/></clipPath><g clip-path=\"url(#alt-hw)\"><g class=\"alt-h alt-s s-a\"><use href=\"#sxs-rows-alt\" x=\"218.8\" y=\"106.5\"/></g></g></g>",
}
