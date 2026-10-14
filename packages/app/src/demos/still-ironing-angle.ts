// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Ironing angle: with a fixed angle, ironing runs at that angle, here 0°, instead of along the top lines.
import type { StageTool } from '@slicerx/ui'

export const loop: StageTool = {
  id: 'uira',
  css: "",
  body: "<polygon class=\"s-f2 s-ol\" points=\"81.3,92.5 147.9,131 147.9,110 81.3,71.5\"/><polygon class=\"s-f3 s-ol\" points=\"214.6,92.5 147.9,131 147.9,110 214.6,71.5\"/><polygon class=\"s-hole s-ol\" points=\"147.9,33 214.6,71.5 147.9,110 81.3,71.5\"/><path class=\"s-n\" style=\"stroke:var(--stage-t2,#9da1b6);stroke-width:1.1\" d=\"M207.6 69.5l0 4M200.7 65.6l0 11.8M193.8 61.6l0 19.8M187 57.6l0 27.8M180.1 53.7l0 35.6M173.3 49.7l0 43.6M166.4 45.8l0 51.4M159.6 41.8l0 59.4M152.7 37.8l0 67.4M145.8 36.3l0 70.4M139 40.3l0 62.4M132.1 44.2l0 54.6M125.3 48.2l0 46.6M118.4 52.2l0 38.6M111.5 56.1l0 30.8M104.7 60.1l0 22.8M97.8 64l0 15M91 68l0 7\"/><path class=\"s-n\" style=\"stroke:var(--stage-a1,#c9a6fb);stroke-width:1\" d=\"M115.2 54l63.1 36.4M112.8 55.4l63 36.4M110.4 56.8l63 36.4M107.9 58.2l63.1 36.4M105.5 59.6l63.1 36.4M103.1 61l63 36.4M100.7 62.4l63 36.4M98.2 63.8l63.1 36.4M95.8 65.2l63.1 36.4M93.4 66.6l63 36.4M91 68l63 36.4M88.5 69.4l63.1 36.4M86.1 70.8l63.1 36.4\"/><rect class=\"sxs-pill\" x=\"165.9\" y=\"98\" width=\"30\" height=\"18\" rx=\"9\"/><text x=\"174.9\" y=\"110.7\">0°</text>",
}
