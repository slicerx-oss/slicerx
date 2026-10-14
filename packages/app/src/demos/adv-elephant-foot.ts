// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Elephant foot compensation: the first layers squash out into a lip; pulled in, the wall stays straight.
import type { StageTool } from '@slicerx/ui'

export const loop: StageTool = {
  id: 'aef',
  readout: {rows: ["0.00 mm","0.15 mm"],w: 70},
  css: ".sxs .aef-s{animation-timing-function:steps(1,end)}.sxs .aef-a{animation-name:aef-a}@keyframes aef-a{0%{opacity:1}45.7%{opacity:0}94.3%{opacity:1}100%{opacity:1}}.sxs .aef-b{animation-name:aef-b}@keyframes aef-b{0%{opacity:0}45.7%{opacity:1}94.3%{opacity:0}100%{opacity:0}}.sxs .aef-h{animation-name:aef-h}@keyframes aef-h{0%{translate:0 0px}45.7%{translate:0 -14px}94.3%{translate:0 0px}100%{translate:0 0px}}",
  body: "<g class=\"aef-a aef-s s-a\"><polygon class=\"s-cf s-cl\" points=\"77.3,104.8 145.2,144 145.2,137 77.3,97.8\"/><polygon class=\"s-cf s-cl\" points=\"191.9,117 145.2,144 145.2,137 191.9,110\"/><polygon class=\"s-f1 s-cl\" points=\"124,70.8 191.9,110 145.2,137 77.3,97.8\"/></g><g class=\"aef-b aef-s s-a\"><polygon class=\"s-g2 s-aol\" points=\"84.6,104.8 145.2,139.8 145.2,132.8 84.6,97.8\"/><polygon class=\"s-g3 s-aol\" points=\"184.6,117 145.2,139.8 145.2,132.8 184.6,110\"/><polygon class=\"s-g1 s-aol\" points=\"124,75 184.6,110 145.2,132.8 84.6,97.8\"/></g><polygon class=\"s-f2 s-ol\" points=\"84.6,97.8 145.2,132.8 145.2,97.8 84.6,62.8\"/><polygon class=\"s-f3 s-ol\" points=\"184.6,110 145.2,132.8 145.2,97.8 184.6,75\"/><polygon class=\"s-f1 s-ol\" points=\"124,40 184.6,75 145.2,97.8 84.6,62.8\"/><g class=\" s-a\"><use href=\"#sxs-hud-aef\" x=\"200.6\" y=\"96\"/><clipPath id=\"aef-hw\"><rect x=\"206.6\" y=\"88\" width=\"60\" height=\"16\"/></clipPath><g clip-path=\"url(#aef-hw)\"><g class=\"aef-h aef-s s-a\"><use href=\"#sxs-rows-aef\" x=\"200.6\" y=\"96\"/></g></g></g>",
}
