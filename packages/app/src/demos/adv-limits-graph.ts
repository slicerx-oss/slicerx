// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Machine limits: the speed a move asks for (dashed) and what the printer allows; the cap flattens the peak and the ramps follow the acceleration limit.
import type { StageTool } from '@slicerx/ui'

export const loop: StageTool = {
  id: 'bqs7',
  css: "",
  body: "<polygon class=\"s-f2 s-ol\" points=\"85.8,83.1 194.9,146.1 194.9,97.1 85.8,34.1\"/><polygon class=\"s-f3 s-ol\" points=\"196.7,145 194.9,146.1 194.9,97.1 196.7,96\"/><polygon class=\"s-f1 s-ol\" points=\"87.6,33 196.7,96 194.9,97.1 85.8,34.1\"/><path class=\"s-n\" stroke-dasharray=\"3 2.5\" style=\"stroke:var(--stage-t3,#6c7086);stroke-width:1.6\" d=\"M91.9 81.3l30.3-19.2 36.4 21 30.3 54.2\"/><path class=\"s-n\" style=\"stroke:var(--stage-cut,#ff5555);stroke-width:1.2\" d=\"M91.9 56.8l97 56\"/><path class=\"s-n\" style=\"stroke:var(--stage-a2,#a57ae8);stroke-width:2.4\" d=\"M91.9 81.3l22.1-11.7 52.7 30.4 22.2 37.3\"/>",
}
