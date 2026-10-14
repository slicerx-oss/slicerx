// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Bed and clearance: the printable area on the bed, an excluded corner, and the room the toolhead needs around a finished part when printing one object at a time.
import type { StageTool } from '@slicerx/ui'

export const loop: StageTool = {
  id: 'bqs5',
  css: "",
  body: "<polygon class=\"s-f2 s-ol\" points=\"57.3,109.3 148.2,161.8 148.2,159 57.3,106.5\"/><polygon class=\"s-f3 s-ol\" points=\"214.9,123.3 148.2,161.8 148.2,159 214.9,120.5\"/><polygon class=\"s-f1 s-ol\" points=\"124,68 214.9,120.5 148.2,159 57.3,106.5\"/><path class=\"s-n\" style=\"stroke:var(--stage-cut,#ff5555);stroke-width:1.4\" d=\"M124 67.8l24.2 14-24.2 14-24.2-14z\"/><path class=\"s-n\" style=\"stroke:var(--stage-cut,#ff5555);stroke-width:1\" d=\"M128.2 70.3l-8.4 0M132.5 72.7l-17 0M136.7 75.2l-25.4 0M141 77.6l-34 0M145.2 80.1l-42.4 0\"/><polygon class=\"s-f2 s-ol\" points=\"127,125.8 145.2,136.3 145.2,108.3 127,97.8\"/><polygon class=\"s-f3 s-ol\" points=\"163.4,125.8 145.2,136.3 145.2,108.3 163.4,97.8\"/><polygon class=\"s-f1 s-ol\" points=\"145.2,87.3 163.4,97.8 145.2,108.3 127,97.8\"/><path class=\"s-ghost\" style=\"stroke:var(--stage-a1,#c9a6fb)\" d=\"M169.5 111.6l-4.6 2.2-5.2 1.7-5.6 1.2-5.9 .6-6 0-5.9-.6-5.6-1.2-5.2-1.7-4.5-2.2-3.9-2.7-3-3-2-3.2-1-3.4 0-3.5 1-3.3 2-3.3 3-3 3.9-2.6 4.5-2.2 5.2-1.8 5.6-1.1 5.9-.6 6 0 5.9 .6 5.6 1.1 5.2 1.8 4.6 2.2 3.8 2.6 3 3 2 3.3 1.1 3.3 0 3.5-1.1 3.4-2 3.2-3 3z\"/><polygon class=\"s-g2 s-aol\" points=\"133.1,90.8 145.2,97.8 145.2,80.3 133.1,73.3\"/><polygon class=\"s-g3 s-aol\" points=\"157.3,90.8 145.2,97.8 145.2,80.3 157.3,73.3\"/><polygon class=\"s-g1 s-aol\" points=\"145.2,66.3 157.3,73.3 145.2,80.3 133.1,73.3\"/>",
}
