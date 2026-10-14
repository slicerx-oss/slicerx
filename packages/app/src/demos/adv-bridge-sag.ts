// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Bridge: strands across a gap sag into the air, then print tight and flat with the right density, speed and flow.
import type { StageTool } from '@slicerx/ui'

export const loop: StageTool = {
  id: 'abg',
  css: ".sxs .abg-s{animation-timing-function:steps(1,end)}.sxs .abg-a{animation-name:abg-a}@keyframes abg-a{0%{opacity:1}45.7%{opacity:0}94.3%{opacity:1}100%{opacity:1}}.sxs .abg-b{animation-name:abg-b}@keyframes abg-b{0%{opacity:0}45.7%{opacity:1}94.3%{opacity:0}100%{opacity:0}}",
  body: "<polygon class=\"s-f2 s-ol\" points=\"84.6,104.8 105.8,117 105.8,85.5 84.6,73.3\"/><polygon class=\"s-f3 s-ol\" points=\"145.2,94.3 105.8,117 105.8,85.5 145.2,62.8\"/><polygon class=\"s-f1 s-ol\" points=\"124,50.5 145.2,62.8 105.8,85.5 84.6,73.3\"/><g class=\"abg-a abg-s s-a\"><path class=\"s-n\" style=\"stroke:var(--stage-cut,#ff5555);stroke-width:2\" d=\"M137.6 67.1Q161.9 98.6 186.1 95.1M130.1 71.5Q154.3 103 178.6 99.5M122.5 75.9Q146.7 107.4 171 103.9M114.9 80.3Q139.2 111.8 163.4 108.3\"/></g><g class=\"abg-b abg-s s-a\"><path class=\"s-n\" style=\"stroke:var(--stage-a1,#c9a6fb);stroke-width:2.2\" d=\"M137.6 67.1Q161.9 81.1 186.1 95.1M130.1 71.5Q154.3 85.5 178.6 99.5M122.5 75.9Q146.7 89.9 171 103.9M114.9 80.3Q139.2 94.3 163.4 108.3\"/></g><polygon class=\"s-f2 s-ol\" points=\"154.3,145 175.5,157.3 175.5,125.8 154.3,113.5\"/><polygon class=\"s-f3 s-ol\" points=\"214.9,134.5 175.5,157.3 175.5,125.8 214.9,103\"/><polygon class=\"s-f1 s-ol\" points=\"193.7,90.8 214.9,103 175.5,125.8 154.3,113.5\"/>",
}
