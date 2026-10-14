// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Timeline marker: steps run left to right. Move the marker back and the part shows as it was there; the steps after it are grayed.
import type { StageTool } from '@slicerx/ui'

export const loop: StageTool = {
  id: 'umtl',
  css: "",
  body: "<polygon class=\"s-f2 s-ol\" points=\"93.7,78.5 154.3,113.5 154.3,78.5 93.7,43.5\"/><polygon class=\"s-f3 s-ol\" points=\"196.7,89 154.3,113.5 154.3,78.5 196.7,54\"/><polygon class=\"s-f1 s-ol\" points=\"136.1,19 196.7,54 154.3,78.5 93.7,43.5\"/><path class=\"s-n\" style=\"stroke:var(--stage-a1,#c9a6fb);stroke-width:1.2\" d=\"M55.5 137C55.5 124 121.5 124 121.5 134\"/><path class=\"s-n\" style=\"stroke:var(--stage-a1,#c9a6fb);stroke-width:1.2\" d=\"M118.5 131L121.5 135L124.5 131\"/><rect class=\"sxs-pill\" x=\"28\" y=\"137\" width=\"55\" height=\"18\" rx=\"9\"/><text x=\"37\" y=\"149.7\">Sketch</text><rect class=\"sxs-pill\" x=\"91\" y=\"137\" width=\"61\" height=\"18\" rx=\"9\"/><text x=\"100\" y=\"149.7\">Extrude</text><g style=\"opacity:.4\"><rect class=\"sxs-pill\" x=\"172\" y=\"137\" width=\"55\" height=\"18\" rx=\"9\"/><text x=\"181\" y=\"149.7\">Fillet</text></g><g style=\"opacity:.4\"><rect class=\"sxs-pill\" x=\"235\" y=\"137\" width=\"49\" height=\"18\" rx=\"9\"/><text x=\"244\" y=\"149.7\">Shell</text></g><path class=\"s-n\" style=\"stroke:var(--stage-ol);stroke-width:4\" d=\"M162 130V160\"/><path class=\"s-n\" style=\"stroke:var(--stage-a1,#c9a6fb);stroke-width:2\" d=\"M162 130V160\"/><path style=\"fill:var(--stage-a1,#c9a6fb);stroke:var(--stage-ol);stroke-width:1\" d=\"M157 126H167L162 132Z\"/>",
}
