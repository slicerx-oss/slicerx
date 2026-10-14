// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Overlap between infill and walls: how far the infill reaches into the walls; with none, a gap is left between them.
import type { StageTool } from '@slicerx/ui'

export const loop: StageTool = {
  id: 'aio',
  readout: {rows: ["0 %","15 %"],w: 48},
  css: ".sxs .aio-s{animation-timing-function:steps(1,end)}.sxs .aio-a{animation-name:aio-a}@keyframes aio-a{0%{opacity:1}45.7%{opacity:0}94.3%{opacity:1}100%{opacity:1}}.sxs .aio-b{animation-name:aio-b}@keyframes aio-b{0%{opacity:0}45.7%{opacity:1}94.3%{opacity:0}100%{opacity:0}}.sxs .aio-h{animation-name:aio-h}@keyframes aio-h{0%{translate:0 0px}45.7%{translate:0 -14px}94.3%{translate:0 0px}100%{translate:0 0px}}",
  body: "<polygon class=\"s-f2 s-ol\" points=\"75.5,110 154.3,155.5 154.3,146.8 75.5,101.3\"/><polygon class=\"s-f3 s-ol\" points=\"202.8,127.5 154.3,155.5 154.3,146.8 202.8,118.8\"/><polygon class=\"s-f1 s-ol\" points=\"124,73.3 202.8,118.8 154.3,146.8 75.5,101.3\"/><path class=\"s-n\" style=\"stroke:var(--stage-t3,#6c7086);stroke-width:2.4\" d=\"M124 80.3l66.7 38.5-36.4 21-66.7-38.5z\"/><g class=\"aio-a aio-s s-a\"><polygon class=\"s-cf\" points=\"124,81.7 188.3,118.8 186.1,120 121.9,82.9\"/><polygon class=\"s-cf\" points=\"92.2,100 156.4,137.1 154.3,138.4 90.1,101.3\"/><path class=\"s-n\" style=\"stroke:var(--stage-t2,#9da1b6);stroke-width:1.4\" d=\"M129.5 87.6l-29.1 16.8M141.6 94.6l-29.1 16.8M153.7 101.6l-29.1 16.8M165.8 108.6l-29.1 16.8M178 115.6l-29.1 16.8\"/></g><g class=\"aio-b aio-s s-a\"><path class=\"s-n\" style=\"stroke:var(--stage-a1,#c9a6fb);stroke-width:1.4\" d=\"M133.1 85.5l-36.4 21M145.2 92.5l-36.4 21M157.3 99.5l-36.3 21M169.5 106.5l-36.4 21M181.6 113.5l-36.4 21\"/></g><g class=\" s-a\"><use href=\"#sxs-hud-aio\" x=\"218.8\" y=\"124.8\"/><clipPath id=\"aio-hw\"><rect x=\"224.8\" y=\"116.8\" width=\"38\" height=\"16\"/></clipPath><g clip-path=\"url(#aio-hw)\"><g class=\"aio-h aio-s s-a\"><use href=\"#sxs-rows-aio\" x=\"218.8\" y=\"124.8\"/></g></g></g>",
}
