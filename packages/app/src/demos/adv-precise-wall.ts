// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Precise wall: the spacing between the outer and inner walls is set exactly, so no gap is left between them.
import type { StageTool } from '@slicerx/ui'

export const loop: StageTool = {
  id: 'apw',
  css: ".sxs .apw-s{animation-timing-function:steps(1,end)}.sxs .apw-a{animation-name:apw-a}@keyframes apw-a{0%{opacity:1}45.7%{opacity:0}94.3%{opacity:1}100%{opacity:1}}.sxs .apw-b{animation-name:apw-b}@keyframes apw-b{0%{opacity:0}45.7%{opacity:1}94.3%{opacity:0}100%{opacity:0}}",
  body: "<polygon class=\"s-f2 s-ol\" points=\"75.5,110 154.3,155.5 154.3,146.8 75.5,101.3\"/><polygon class=\"s-f3 s-ol\" points=\"202.8,127.5 154.3,155.5 154.3,146.8 202.8,118.8\"/><polygon class=\"s-f1 s-ol\" points=\"124,73.3 202.8,118.8 154.3,146.8 75.5,101.3\"/><path class=\"s-n\" style=\"stroke:var(--stage-t3,#6c7086);stroke-width:4\" d=\"M124 77.5l71.5 41.3-41.2 23.8-71.5-41.3z\"/><g class=\"apw-a apw-s s-a\"><path class=\"s-n\" style=\"stroke:var(--stage-t2,#9da1b6);stroke-width:4\" d=\"M124 83.8l60.6 35-30.3 17.5-60.6-35z\"/><path class=\"s-n\" style=\"stroke:var(--stage-cut,#ff5555);stroke-width:0.8\" d=\"M124 80.6l66.1 38.2-35.8 20.6-66.1-38.1z\"/></g><g class=\"apw-b apw-s s-a\"><path class=\"s-n\" style=\"stroke:var(--stage-a1,#c9a6fb);stroke-width:4\" d=\"M124 81.3l64.9 37.5-34.6 19.9-64.9-37.4z\"/></g>",
}
