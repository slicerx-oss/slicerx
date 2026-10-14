// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// One wall on top: the same top with 3 walls and with 1. With one wall the top lines reach almost to the edge.
import type { StageTool } from '@slicerx/ui'

export const loop: StageTool = {
  id: 'uowt',
  css: "",
  body: "<polygon class=\"s-f2 s-ol\" points=\"54.5,92.5 99.9,118.8 99.9,97.8 54.5,71.5\"/><polygon class=\"s-f3 s-ol\" points=\"145.4,92.5 99.9,118.8 99.9,97.8 145.4,71.5\"/><polygon class=\"s-hole s-ol\" points=\"99.9,45.3 145.4,71.5 99.9,97.8 54.5,71.5\"/><path class=\"s-n\" style=\"stroke:var(--stage-t2,#9da1b6);stroke-width:1.6\" d=\"M99.9 47.7l41.3 23.8-41.3 23.8-41.2-23.8zM99.9 51.6l34.6 19.9-34.6 20-34.5-20zM99.9 55.4l27.9 16.1-27.9 16.1-27.8-16.1z\"/><path class=\"s-n\" style=\"stroke:var(--stage-a1,#c9a6fb);stroke-width:1.2\" d=\"M120 70.1l0 2.8M115.3 67.4l0 8.2M110.6 64.7l0 13.6M105.9 62l0 19M101.2 59.2l0 24.6M96.4 60.6l0 21.8M91.7 63.3l0 16.4M87 66l0 11M82.3 68.7l0 5.6\"/><rect class=\"sxs-pill\" x=\"69.9\" y=\"125.8\" width=\"61\" height=\"18\" rx=\"9\"/><text x=\"78.9\" y=\"138.5\">3 walls</text><polygon class=\"s-f2 s-ol\" points=\"150.5,92.5 195.9,118.8 195.9,97.8 150.5,71.5\"/><polygon class=\"s-f3 s-ol\" points=\"241.4,92.5 195.9,118.8 195.9,97.8 241.4,71.5\"/><polygon class=\"s-hole s-ol\" points=\"195.9,45.3 241.4,71.5 195.9,97.8 150.5,71.5\"/><path class=\"s-n\" style=\"stroke:var(--stage-t2,#9da1b6);stroke-width:1.6\" d=\"M195.9 47.7l41.3 23.8-41.3 23.8-41.2-23.8z\"/><path class=\"s-n\" style=\"stroke:var(--stage-a1,#c9a6fb);stroke-width:1.2\" d=\"M229.4 70.1l0 2.8M224.6 67.4l0 8.2M219.9 64.7l0 13.6M215.2 62l0 19M210.5 59.2l0 24.6M205.8 56.5l0 30M201.1 53.8l0 35.4M196.3 51.1l0 40.8M191.6 53.3l0 36.4M186.9 56.1l0 30.8M182.2 58.8l0 25.4M177.5 61.5l0 20M172.8 64.2l0 14.6M168.1 67l0 9M163.3 69.7l0 3.6\"/><rect class=\"sxs-pill\" x=\"165.9\" y=\"125.8\" width=\"55\" height=\"18\" rx=\"9\"/><text x=\"174.9\" y=\"138.5\">1 wall</text>",
}
