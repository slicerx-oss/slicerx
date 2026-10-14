// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Counterbore hole bridging: the ceiling of a wide step under a narrow hole sags into the air; bridged, it prints flat.
import type { StageTool } from '@slicerx/ui'

export const loop: StageTool = {
  id: 'acb',
  css: ".sxs .acb-s{animation-timing-function:steps(1,end)}.sxs .acb-a{animation-name:acb-a}@keyframes acb-a{0%{opacity:1}45.7%{opacity:0}94.3%{opacity:1}100%{opacity:1}}.sxs .acb-b{animation-name:acb-b}@keyframes acb-b{0%{opacity:0}45.7%{opacity:1}94.3%{opacity:0}100%{opacity:0}}",
  body: "<polygon class=\"s-f3 s-ol\" points=\"93.7,99.5 172.5,145 172.5,103 93.7,57.5\"/><polygon class=\"s-f3 s-ol\" points=\"202.8,127.5 172.5,145 172.5,103 202.8,85.5\"/><polygon class=\"s-f1 s-ol\" points=\"124,40 202.8,85.5 172.5,103 93.7,57.5\"/><g transform=\"matrix(3.031 1.75 0 -3.5 93.7 99.5)\" style=\"vector-effect:non-scaling-stroke\"><path class=\"s-hole\" d=\"M6 0V5H11V12H15V5H20V0Z\"/><g class=\"acb-a acb-s s-a\"><path class=\"s-n\" style=\"stroke:var(--stage-cut,#ff5555);stroke-width:1.8\" d=\"M6 5Q8.5 2.8 11 5M15 5Q17.5 2.8 20 5\"/></g><g class=\"acb-b acb-s s-a\"><path class=\"s-n\" style=\"stroke:var(--stage-a1,#c9a6fb);stroke-width:2.4\" d=\"M6 5Q8.5 5 11 5M15 5Q17.5 5 20 5\"/></g></g>",
}
