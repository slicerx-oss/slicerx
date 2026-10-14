// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Prime tower spot: the tower is placed where the plate is clear, away from the parts and the no-go zones.
import type { StageTool } from '@slicerx/ui'

export const loop: StageTool = {
  id: 'ats',
  css: "",
  body: "<polygon class=\"s-cf\" points=\"45.2,99.5 87.6,124 57.3,141.5 14.9,117\" style=\"stroke:var(--stage-cut,#ff5555);stroke-dasharray:3 2\"/><polygon class=\"s-f2 s-ol\" points=\"93.7,99.5 124,117 124,96 93.7,78.5\"/><polygon class=\"s-f3 s-ol\" points=\"154.3,99.5 124,117 124,96 154.3,78.5\"/><polygon class=\"s-f1 s-ol\" points=\"124,61 154.3,78.5 124,96 93.7,78.5\"/><polygon class=\"s-f2 s-ol\" points=\"130.1,127.5 160.4,145 160.4,117 130.1,99.5\"/><polygon class=\"s-f3 s-ol\" points=\"190.7,127.5 160.4,145 160.4,117 190.7,99.5\"/><polygon class=\"s-f1 s-ol\" points=\"160.4,82 190.7,99.5 160.4,117 130.1,99.5\"/><polygon class=\"s-g2 s-aol\" points=\"218,132.8 233.1,141.5 233.1,92.5 218,83.8\"/><polygon class=\"s-g3 s-aol\" points=\"248.3,132.8 233.1,141.5 233.1,92.5 248.3,83.8\"/><polygon class=\"s-g1 s-aol\" points=\"233.1,75 248.3,83.8 233.1,92.5 218,83.8\"/>",
}
