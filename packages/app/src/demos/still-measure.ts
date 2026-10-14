// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Measure: pick two places: the panel gives the distance between them and how far apart they are along X, Y and Z.
import type { StageTool } from '@slicerx/ui'

export const loop: StageTool = {
  id: 'umea',
  css: "",
  body: "<polygon class=\"s-f2 s-ol\" points=\"87.6,89 148.2,124 148.2,92.5 87.6,57.5\"/><polygon class=\"s-f3 s-ol\" points=\"178.6,106.5 148.2,124 148.2,92.5 178.6,75\"/><polygon class=\"s-f1 s-ol\" points=\"117.9,40 178.6,75 148.2,92.5 87.6,57.5\"/><path class=\"s-n\" style=\"stroke:var(--stage-aol);stroke-width:4\" d=\"M117.9 40l60.7 35-30.4 17.5 0 31.5\"/><path class=\"s-n\" style=\"stroke:var(--stage-a1,#c9a6fb);stroke-width:2\" d=\"M117.9 40l60.7 35-30.4 17.5 0 31.5\"/><path class=\"s-n\" style=\"stroke:var(--stage-a1,#c9a6fb);stroke-width:1.4;stroke-dasharray:4 3\" d=\"M117.9 40l30.3 84\"/><circle cx=\"117.9\" cy=\"40\" r=\"7\" style=\"fill:var(--stage-pill);stroke:var(--stage-a1,#c9a6fb);stroke-width:1.4\"/><text x=\"114.9\" y=\"43.7\">1</text><circle cx=\"148.2\" cy=\"124\" r=\"7\" style=\"fill:var(--stage-pill);stroke:var(--stage-a1,#c9a6fb);stroke-width:1.4\"/><text x=\"145.2\" y=\"127.7\">2</text><path class=\"s-n\" style=\"stroke:var(--stage-a1,#c9a6fb);stroke-width:1.2\" d=\"M133.1 82L134 140\"/><rect class=\"sxs-pill\" x=\"158.2\" y=\"28.5\" width=\"61\" height=\"18\" rx=\"9\"/><text x=\"167.2\" y=\"41.2\">X 20 mm</text><rect class=\"sxs-pill\" x=\"177.4\" y=\"74.8\" width=\"61\" height=\"18\" rx=\"9\"/><text x=\"186.4\" y=\"87.5\">Y 10 mm</text><rect class=\"sxs-pill\" x=\"160.2\" y=\"111.3\" width=\"55\" height=\"18\" rx=\"9\"/><text x=\"169.2\" y=\"124\">Z 9 mm</text><rect class=\"sxs-pill\" x=\"12\" y=\"131\" width=\"122\" height=\"18\" rx=\"9\"/><text x=\"21\" y=\"143.7\">Distance 24.10 mm</text>",
}
