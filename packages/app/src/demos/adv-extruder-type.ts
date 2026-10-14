// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Extruder type: direct drive carries the motor on the toolhead; Bowden keeps it on the frame and pushes filament through a long tube.
import type { StageTool } from '@slicerx/ui'

export const loop: StageTool = {
  id: 'bqs6',
  css: "",
  body: "<polygon class=\"s-f2 s-ol\" points=\"81.6,92.5 93.7,99.5 93.7,85.5 81.6,78.5\"/><polygon class=\"s-f3 s-ol\" points=\"105.8,92.5 93.7,99.5 93.7,85.5 105.8,78.5\"/><polygon class=\"s-f1 s-ol\" points=\"93.7,71.5 105.8,78.5 93.7,85.5 81.6,78.5\"/><polygon class=\"s-f2 s-ol\" points=\"93.7,102.3 86.4,92.5 101,92.5\"/><polygon class=\"s-g2 s-aol\" points=\"78.5,78.5 93.7,87.3 93.7,73.3 78.5,64.5\"/><polygon class=\"s-g3 s-aol\" points=\"108.8,78.5 93.7,87.3 93.7,73.3 108.8,64.5\"/><polygon class=\"s-g1 s-aol\" points=\"93.7,55.8 108.8,64.5 93.7,73.3 78.5,64.5\"/><polygon class=\"s-f2 s-ol\" points=\"136.1,117 148.2,124 148.2,110 136.1,103\"/><polygon class=\"s-f3 s-ol\" points=\"160.4,117 148.2,124 148.2,110 160.4,103\"/><polygon class=\"s-f1 s-ol\" points=\"148.2,96 160.4,103 148.2,110 136.1,103\"/><polygon class=\"s-f2 s-ol\" points=\"148.2,126.8 141,117 155.5,117\"/><polygon class=\"s-f2 s-ol\" points=\"172.5,124 184.6,131 184.6,103 172.5,96\"/><polygon class=\"s-f3 s-ol\" points=\"196.7,124 184.6,131 184.6,103 196.7,96\"/><polygon class=\"s-f1 s-ol\" points=\"184.6,89 196.7,96 184.6,103 172.5,96\"/><polygon class=\"s-g2 s-aol\" points=\"169.5,96 184.6,104.8 184.6,90.8 169.5,82\"/><polygon class=\"s-g3 s-aol\" points=\"199.8,96 184.6,104.8 184.6,90.8 199.8,82\"/><polygon class=\"s-g1 s-aol\" points=\"184.6,73.3 199.8,82 184.6,90.8 169.5,82\"/><path class=\"s-n\" style=\"stroke:var(--stage-a2,#a57ae8);stroke-width:2.4\" d=\"M184.6 82C184.6 54 148.2 68 148.2 103\"/>",
}
