// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Detect narrow internal solid infill: a thin strip is filled with long lines along it instead of short zigzags across it.
import type { StageTool } from '@slicerx/ui'

export const loop: StageTool = {
  id: 'ans',
  css: ".sxs .ans-s{animation-timing-function:steps(1,end)}.sxs .ans-a{animation-name:ans-a}@keyframes ans-a{0%{opacity:1}45.7%{opacity:0}94.3%{opacity:1}100%{opacity:1}}.sxs .ans-b{animation-name:ans-b}@keyframes ans-b{0%{opacity:0}45.7%{opacity:1}94.3%{opacity:0}100%{opacity:0}}",
  body: "<polygon class=\"s-f2 s-ol\" points=\"81.6,106.5 160.4,152 160.4,143.3 81.6,97.8\"/><polygon class=\"s-f3 s-ol\" points=\"202.8,127.5 160.4,152 160.4,143.3 202.8,118.8\"/><polygon class=\"s-f1 s-ol\" points=\"124,73.3 202.8,118.8 160.4,143.3 81.6,97.8\"/><path class=\"s-n\" style=\"stroke:var(--stage-t3,#6c7086);stroke-width:1.6\" d=\"M115.2 85.3l66.7 38.5-12.7 7.4-66.7-38.5z\"/><g class=\"ans-a ans-s s-a\"><path class=\"s-n\" style=\"stroke:var(--stage-cut,#ff5555);stroke-width:1.2\" d=\"M116.4 88.1l-6 7 12.1-3.5-6.1 7 12.1-3.5-6 7 12.1-3.5-6.1 7 12.2-3.5-6.1 7 12.1-3.5-6 7 12.1-3.5-6.1 7 12.2-3.5-6.1 7 12.1-3.5-6 7 12.1-3.5-6.1 7 12.1-3.5\"/></g><g class=\"ans-b ans-s s-a\"><path class=\"s-n\" style=\"stroke:var(--stage-a1,#c9a6fb);stroke-width:1.6\" d=\"M114.6 89.2l60.6 35M111.9 90.8l60.6 35M109.1 92.3l60.7 35\"/></g>",
}
