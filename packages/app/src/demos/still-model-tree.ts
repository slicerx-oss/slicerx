// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Model tree: each entry in the tree is one thing in the view: a sketch lies on its plane, a body stands on the plate.
import type { StageTool } from '@slicerx/ui'

export const loop: StageTool = {
  id: 'umtr',
  css: "",
  body: "<path class=\"s-n\" style=\"stroke:var(--stage-a1,#c9a6fb);stroke-width:2\" d=\"M202.8 71.5l36.4 21-30.3 17.5-36.4-21z\"/><rect x=\"201.3\" y=\"70\" width=\"3\" height=\"3\" style=\"fill:var(--stage-t1);stroke:var(--stage-ol);stroke-width:.8\"/><rect x=\"237.7\" y=\"91\" width=\"3\" height=\"3\" style=\"fill:var(--stage-t1);stroke:var(--stage-ol);stroke-width:.8\"/><rect x=\"207.4\" y=\"108.5\" width=\"3\" height=\"3\" style=\"fill:var(--stage-t1);stroke:var(--stage-ol);stroke-width:.8\"/><rect x=\"171\" y=\"87.5\" width=\"3\" height=\"3\" style=\"fill:var(--stage-t1);stroke:var(--stage-ol);stroke-width:.8\"/><polygon class=\"s-f2 s-ol\" points=\"99.8,124 130.1,141.5 130.1,120.5 99.8,103\"/><polygon class=\"s-f3 s-ol\" points=\"160.4,124 130.1,141.5 130.1,120.5 160.4,103\"/><polygon class=\"s-f1 s-ol\" points=\"130.1,85.5 160.4,103 130.1,120.5 99.8,103\"/><path class=\"s-n\" style=\"stroke:var(--stage-a1,#c9a6fb);stroke-width:1.2\" d=\"M88 72L172.5 89M78 120L114.9 122.3\"/><rect class=\"sxs-pill\" x=\"10\" y=\"36\" width=\"84\" height=\"98\" rx=\"8\"/><text x=\"20\" y=\"55.7\" style=\"opacity:.6\">Sketches</text><text x=\"32\" y=\"75.7\">Sketch 1</text><text x=\"20\" y=\"103.7\" style=\"opacity:.6\">Bodies</text><text x=\"32\" y=\"123.7\">Body 1</text>",
}
