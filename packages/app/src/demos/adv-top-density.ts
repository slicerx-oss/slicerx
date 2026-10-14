// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Top surface density: a top printed below full density leaves pinholes; at full it closes.
import type { StageTool } from '@slicerx/ui'

export const loop: StageTool = {
  id: 'atd',
  css: "",
  body: "<polygon class=\"s-f2 s-ol\" points=\"81.6,106.5 172.5,159 172.5,150.3 81.6,97.8\"/><polygon class=\"s-f3 s-ol\" points=\"214.9,134.5 172.5,159 172.5,150.3 214.9,125.8\"/><polygon class=\"s-hole s-ol\" points=\"124,73.3 214.9,125.8 172.5,150.3 81.6,97.8\"/><path class=\"s-n\" style=\"stroke:var(--stage-t2,#9da1b6);stroke-width:1.4\" d=\"M123.4 77.1l39.4 22.8M118.5 79.9l39.4 22.8M113.7 82.7l39.4 22.8M108.8 85.5l39.4 22.8M104 88.3l39.4 22.8M99.1 91.1l39.4 22.8M94.3 93.9l39.4 22.8M89.4 96.7l39.4 22.8M84.6 99.5l39.4 22.8\"/><path class=\"s-n\" style=\"stroke:var(--stage-a1,#c9a6fb);stroke-width:1.6\" d=\"M168.9 103.4l39.4 22.7M166.4 104.8l39.4 22.7M164 106.2l39.4 22.7M161.6 107.6l39.4 22.7M159.2 109l39.4 22.7M156.7 110.4l39.4 22.7M154.3 111.8l39.4 22.7M151.9 113.2l39.4 22.7M149.5 114.6l39.4 22.7M147 116l39.4 22.7M144.6 117.4l39.4 22.7M142.2 118.8l39.4 22.7M139.8 120.2l39.4 22.7M137.3 121.6l39.4 22.7M134.9 123l39.4 22.7M132.5 124.4l39.4 22.7\"/>",
}
