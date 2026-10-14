// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Infill direction: the sparse infill lines turned to the angle you set.
import type { StageTool } from '@slicerx/ui'

export const loop: StageTool = {
  id: 'aid',
  readout: {rows: ["0°","45°","90°"],w: 48},
  css: ".sxs .aid-s{animation-timing-function:steps(1,end)}.sxs .aid-h{animation-name:aid-h}@keyframes aid-h{0%{translate:0 0px}31.4%{translate:0 -14px}62.9%{translate:0 -28px}94.3%{translate:0 0px}100%{translate:0 0px}}.sxs .aid-0{animation-name:aid-0}@keyframes aid-0{0%{opacity:1}31.4%{opacity:0}94.3%{opacity:1}100%{opacity:1}}.sxs .aid-1{animation-name:aid-1}@keyframes aid-1{0%{opacity:0}31.4%{opacity:1}62.9%{opacity:0}100%{opacity:0}}.sxs .aid-2{animation-name:aid-2}@keyframes aid-2{0%{opacity:0}62.9%{opacity:1}94.3%{opacity:0}100%{opacity:0}}",
  body: "<polygon class=\"s-f2 s-ol\" points=\"75.5,110 154.3,155.5 154.3,146.8 75.5,101.3\"/><polygon class=\"s-f3 s-ol\" points=\"202.8,127.5 154.3,155.5 154.3,146.8 202.8,118.8\"/><polygon class=\"s-f1 s-ol\" points=\"124,73.3 202.8,118.8 154.3,146.8 75.5,101.3\"/><path class=\"aid-0 aid-s s-a s-n\" style=\"stroke:var(--stage-t3,#6c7086);stroke-width:1.4\" d=\"M123.7 78.7l69.7 40.2M113.4 84.6l69.7 40.3M103.1 90.6l69.7 40.2M92.8 96.5l69.7 40.3\"/><path class=\"aid-1 aid-s s-a s-n\" style=\"stroke:var(--stage-a1,#c9a6fb);stroke-width:1.4\" d=\"M181.2 111.5l0 14.5M166.6 103.1l0 31.3M152.1 94.7l0 45.5M137.5 86.3l0 45.5M122.9 79.1l0 44.3M108.3 87.5l0 27.5M93.8 96l0 10.5\"/><path class=\"aid-2 aid-s s-a s-n\" style=\"stroke:var(--stage-a1,#c9a6fb);stroke-width:1.4\" d=\"M188.6 115.8l-39.4 22.7M178.3 109.8l-39.4 22.8M168 103.9l-39.4 22.7M157.7 97.9l-39.4 22.8M147.4 92l-39.4 22.7M137.1 86l-39.4 22.8M126.8 80.1l-39.4 22.7\"/><g class=\" s-a\"><use href=\"#sxs-hud-aid\" x=\"218.8\" y=\"126.8\"/><clipPath id=\"aid-hw\"><rect x=\"224.8\" y=\"118.8\" width=\"38\" height=\"16\"/></clipPath><g clip-path=\"url(#aid-hw)\"><g class=\"aid-h aid-s s-a\"><use href=\"#sxs-rows-aid\" x=\"218.8\" y=\"126.8\"/></g></g></g>",
}
