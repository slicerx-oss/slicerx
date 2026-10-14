// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Skirt distance: the skirt sits this far out from the part or its brim, here 2 mm.
import type { StageTool } from '@slicerx/ui'

export const loop: StageTool = {
  id: 'usdi',
  css: "",
  body: "<polygon class=\"s-af\" points=\"218.6,92.3 242.8,92.3 151.3,145.2 151.3,131.2\"/><path class=\"s-n\" style=\"stroke:var(--stage-ol);stroke-width:3.4000000000000004\" d=\"M136.1 54.2l66.1 38.1-50.9 29.4-66.1-38.1zM136.1 50.3l72.8 42-57.6 33.3-72.8-42zM136.1 46.5l79.4 45.8-64.2 37.1-79.4-45.8z\"/><path class=\"s-n\" style=\"stroke:var(--stage-t2,#9da1b6);stroke-width:1.8\" d=\"M136.1 54.2l66.1 38.1-50.9 29.4-66.1-38.1zM136.1 50.3l72.8 42-57.6 33.3-72.8-42zM136.1 46.5l79.4 45.8-64.2 37.1-79.4-45.8z\"/><path class=\"s-n\" style=\"stroke:var(--stage-ol);stroke-width:3.4000000000000004\" d=\"M136.1 29l109.7 63.3-94.5 54.6-109.7-63.3zM136.1 25.1l116.4 67.2-101.2 58.5-116.4-67.2z\"/><path class=\"s-n\" style=\"stroke:var(--stage-t2,#9da1b6);stroke-width:1.8\" d=\"M136.1 29l109.7 63.3-94.5 54.6-109.7-63.3zM136.1 25.1l116.4 67.2-101.2 58.5-116.4-67.2z\"/><polygon class=\"s-f2 s-ol\" points=\"96.7,83.8 151.3,115.3 151.3,94.3 96.7,62.8\"/><polygon class=\"s-f3 s-ol\" points=\"190.7,92.5 151.3,115.3 151.3,94.3 190.7,71.5\"/><polygon class=\"s-f1 s-ol\" points=\"136.1,40 190.7,71.5 151.3,94.3 96.7,62.8\"/><path class=\"s-n\" style=\"stroke:var(--stage-a1,#c9a6fb);stroke-width:1.4\" d=\"M177.3 116.1L189.5 123.1M180.4 114.4L174.3 117.9M192.5 121.4L186.4 124.9\"/><rect class=\"sxs-pill\" x=\"199.5\" y=\"121.1\" width=\"42\" height=\"18\" rx=\"9\"/><text x=\"208.5\" y=\"133.8\">2 mm</text>",
}
