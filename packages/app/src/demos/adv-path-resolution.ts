// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Path resolution: a curve cut into long segments shows facets; cut finer it stays round, at the cost of more moves.
import type { StageTool } from '@slicerx/ui'

export const loop: StageTool = {
  id: 'apr',
  css: "",
  body: "<polygon class=\"s-f2 s-ol\" points=\"81.6,106.5 172.5,159 172.5,150.3 81.6,97.8\"/><polygon class=\"s-f3 s-ol\" points=\"214.9,134.5 172.5,159 172.5,150.3 214.9,125.8\"/><polygon class=\"s-f1 s-ol\" points=\"124,73.3 214.9,125.8 172.5,150.3 81.6,97.8\"/><path class=\"s-n\" style=\"stroke:var(--stage-cut,#ff5555);stroke-width:2\" d=\"M130.1 118.8l7.5-10.5-7.5-10.5-18.2-4.4-18.2 4.4\"/><path class=\"s-n\" style=\"stroke:var(--stage-cut,#ff5555);stroke-width:4\" style=\"stroke-linecap:round\" d=\"M130.1 118.8h0M137.6 108.3h0M130.1 97.8h0M111.9 93.4h0M93.7 97.8h0\"/><path class=\"s-n\" style=\"stroke:var(--stage-a1,#c9a6fb);stroke-width:2\" d=\"M172.5 143.3l2.2-1.5 1.9-1.6 1.5-1.8 1.1-1.8 .6-1.9 .2-1.9-.2-2-.6-1.9-1.1-1.8-1.5-1.8-1.9-1.6-2.2-1.4-2.5-1.3-2.8-1.1-3-.9-3.2-.6-3.3-.4-3.4-.1-3.3 .1-3.3 .4-3.2 .6-3 .9-2.8 1.1-2.6 1.3\"/>",
}
