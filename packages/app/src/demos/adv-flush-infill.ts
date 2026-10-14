// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Flush into infill: some of the old color is purged into the part's infill, so the prime tower stays smaller.
import type { StageTool } from '@slicerx/ui'

export const loop: StageTool = {
  id: 'afl',
  css: ".sxs .afl-s{animation-timing-function:steps(1,end)}.sxs .afl-a{animation-name:afl-a}@keyframes afl-a{0%{opacity:1}45.7%{opacity:0}94.3%{opacity:1}100%{opacity:1}}.sxs .afl-b{animation-name:afl-b}@keyframes afl-b{0%{opacity:0}45.7%{opacity:1}94.3%{opacity:0}100%{opacity:0}}",
  body: "<polygon class=\"s-f2 s-ol\" points=\"81.6,106.5 136.1,138 136.1,117 81.6,85.5\"/><polygon class=\"s-f3 s-ol\" points=\"178.6,113.5 136.1,138 136.1,117 178.6,92.5\"/><polygon class=\"s-f1 s-ol\" points=\"124,61 178.6,92.5 136.1,117 81.6,85.5\"/><g class=\"afl-a afl-s s-a\"><path class=\"s-n\" style=\"stroke:var(--stage-t3,#6c7086);stroke-width:1.6\" d=\"M130.1 68l-36.4 21M142.2 75l-36.4 21M154.3 82l-36.4 21M166.4 89l-36.3 21M114.9 69.8l48.5 28M102.8 76.8l48.5 28M90.7 83.8l48.5 28\"/><polygon class=\"s-g2 s-aol\" points=\"169.5,132.8 184.6,141.5 184.6,92.5 169.5,83.8\"/><polygon class=\"s-g3 s-aol\" points=\"199.8,132.8 184.6,141.5 184.6,92.5 199.8,83.8\"/><polygon class=\"s-g1 s-aol\" points=\"184.6,75 199.8,83.8 184.6,92.5 169.5,83.8\"/></g><g class=\"afl-b afl-s s-a\"><path class=\"s-n\" style=\"stroke:var(--cyan,#8be9fd);stroke-width:1.6\" d=\"M130.1 68l-36.4 21M142.2 75l-36.4 21M154.3 82l-36.4 21M166.4 89l-36.3 21M114.9 69.8l48.5 28M102.8 76.8l48.5 28M90.7 83.8l48.5 28\"/><polygon class=\"s-g2 s-aol\" points=\"169.5,132.8 184.6,141.5 184.6,117 169.5,108.3\"/><polygon class=\"s-g3 s-aol\" points=\"199.8,132.8 184.6,141.5 184.6,117 199.8,108.3\"/><polygon class=\"s-g1 s-aol\" points=\"184.6,99.5 199.8,108.3 184.6,117 169.5,108.3\"/></g>",
}
