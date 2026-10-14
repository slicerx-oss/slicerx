// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Internal bridge: the first solid layer over sparse infill droops into the gaps; a thick bridge layer spans them flat.
import type { StageTool } from '@slicerx/ui'

export const loop: StageTool = {
  id: 'aib',
  css: ".sxs .aib-s{animation-timing-function:steps(1,end)}.sxs .aib-a{animation-name:aib-a}@keyframes aib-a{0%{opacity:1}45.7%{opacity:0}94.3%{opacity:1}100%{opacity:1}}.sxs .aib-b{animation-name:aib-b}@keyframes aib-b{0%{opacity:0}45.7%{opacity:1}94.3%{opacity:0}100%{opacity:0}}",
  body: "<polygon class=\"s-f3 s-ol\" points=\"93.7,99.5 172.5,145 172.5,110 93.7,64.5\"/><polygon class=\"s-f3 s-ol\" points=\"202.8,127.5 172.5,145 172.5,110 202.8,92.5\"/><polygon class=\"s-f1 s-ol\" points=\"124,47 202.8,92.5 172.5,110 93.7,64.5\"/><g transform=\"matrix(3.031 1.75 0 -3.5 93.7 99.5)\" style=\"vector-effect:non-scaling-stroke\"><rect class=\"s-f2\" x=\"3\" y=\"1\" width=\"1\" height=\"6.5\"/><rect class=\"s-f2\" x=\"9\" y=\"1\" width=\"1\" height=\"6.5\"/><rect class=\"s-f2\" x=\"15\" y=\"1\" width=\"1\" height=\"6.5\"/><rect class=\"s-f2\" x=\"21\" y=\"1\" width=\"1\" height=\"6.5\"/><g class=\"aib-a aib-s s-a\"><path class=\"s-n\" style=\"stroke:var(--stage-cut,#ff5555);stroke-width:1.6\" d=\"M0 7.5L4 7.5Q6.5 4.9 9 7.5L10 7.5Q12.5 4.9 15 7.5L16 7.5Q18.5 4.9 21 7.5L22 7.5Q24 4.9 26 7.5L26 7.5\"/></g><g class=\"aib-b aib-s s-a\"><path class=\"s-n\" style=\"stroke:var(--stage-a1,#c9a6fb);stroke-width:2.2\" d=\"M0 7.5L4 7.5Q6.5 7.5 9 7.5L10 7.5Q12.5 7.5 15 7.5L16 7.5Q18.5 7.5 21 7.5L22 7.5Q24 7.5 26 7.5L26 7.5\"/></g></g>",
}
