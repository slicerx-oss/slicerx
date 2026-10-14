// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Brim gap: a small gap between the part and its brim, here 0.1 mm, so the brim snaps off cleanly.
import type { StageTool } from '@slicerx/ui'

export const loop: StageTool = {
  id: 'ubga',
  css: "",
  body: "<polygon class=\"s-af\" points=\"190.7,92.3 199.2,92.3 151.3,120 151.3,115.1\"/><path class=\"s-n\" style=\"stroke:var(--stage-ol);stroke-width:3.4000000000000004\" d=\"M136.1 54.2l66.1 38.1-50.9 29.4-66.1-38.1zM136.1 50.3l72.8 42-57.6 33.3-72.8-42zM136.1 46.5l79.4 45.8-64.2 37.1-79.4-45.8z\"/><path class=\"s-n\" style=\"stroke:var(--stage-t2,#9da1b6);stroke-width:1.8\" d=\"M136.1 54.2l66.1 38.1-50.9 29.4-66.1-38.1zM136.1 50.3l72.8 42-57.6 33.3-72.8-42zM136.1 46.5l79.4 45.8-64.2 37.1-79.4-45.8z\"/><path class=\"s-n\" style=\"stroke:var(--stage-ol);stroke-width:3.4000000000000004\" d=\"M136.1 29l109.7 63.3-94.5 54.6-109.7-63.3zM136.1 25.1l116.4 67.2-101.2 58.5-116.4-67.2z\"/><path class=\"s-n\" style=\"stroke:var(--stage-t2,#9da1b6);stroke-width:1.8\" d=\"M136.1 29l109.7 63.3-94.5 54.6-109.7-63.3zM136.1 25.1l116.4 67.2-101.2 58.5-116.4-67.2z\"/><polygon class=\"s-f2 s-ol\" points=\"96.7,83.8 151.3,115.3 151.3,94.3 96.7,62.8\"/><polygon class=\"s-f3 s-ol\" points=\"190.7,92.5 151.3,115.3 151.3,94.3 190.7,71.5\"/><polygon class=\"s-f1 s-ol\" points=\"136.1,40 190.7,71.5 151.3,94.3 96.7,62.8\"/><path class=\"s-n\" style=\"stroke:var(--stage-a1,#c9a6fb);stroke-width:1.4\" d=\"M163.4 108.1L167.6 110.5M166.4 106.3L160.4 109.8M170.7 108.8L164.6 112.3\"/><rect class=\"sxs-pill\" x=\"199.5\" y=\"121.1\" width=\"55\" height=\"18\" rx=\"9\"/><text x=\"208.5\" y=\"133.8\">0.1 mm</text>",
}
