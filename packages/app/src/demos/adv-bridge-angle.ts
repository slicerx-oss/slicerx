// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Bridge angle: the bridge lines across an opening turned to the angle you set.
import type { StageTool } from '@slicerx/ui'

export const loop: StageTool = {
  id: 'aba',
  readout: {rows: ["0°","45°","90°"],w: 48},
  css: ".sxs .aba-s{animation-timing-function:steps(1,end)}.sxs .aba-h{animation-name:aba-h}@keyframes aba-h{0%{translate:0 0px}31.4%{translate:0 -14px}62.9%{translate:0 -28px}94.3%{translate:0 0px}100%{translate:0 0px}}.sxs .aba-0{animation-name:aba-0}@keyframes aba-0{0%{opacity:1}31.4%{opacity:0}94.3%{opacity:1}100%{opacity:1}}.sxs .aba-1{animation-name:aba-1}@keyframes aba-1{0%{opacity:0}31.4%{opacity:1}62.9%{opacity:0}100%{opacity:0}}.sxs .aba-2{animation-name:aba-2}@keyframes aba-2{0%{opacity:0}62.9%{opacity:1}94.3%{opacity:0}100%{opacity:0}}",
  body: "<polygon class=\"s-f2 s-ol\" points=\"75.5,110 154.3,155.5 154.3,146.8 75.5,101.3\"/><polygon class=\"s-f3 s-ol\" points=\"202.8,127.5 154.3,155.5 154.3,146.8 202.8,118.8\"/><polygon class=\"s-f1 s-ol\" points=\"124,73.3 202.8,118.8 154.3,146.8 75.5,101.3\"/><polygon class=\"s-hole\" points=\"136.1,94.3 166.4,111.8 142.2,125.8 111.9,108.3\"/><path class=\"aba-0 aba-s s-a s-n\" style=\"stroke:var(--stage-t3,#6c7086);stroke-width:1.8\" d=\"M133.7 95.6l30.3 17.5M128.9 98.4l30.3 17.5M124 101.2l30.3 17.5M119.2 104l30.3 17.5M114.3 106.8l30.3 17.5\"/><path class=\"aba-1 aba-s s-a s-n\" style=\"stroke:var(--stage-a1,#c9a6fb);stroke-width:1.8\" d=\"M159.7 107.9l0 7.7M152.9 103.9l0 15.7M146 100l0 23.5M139.2 96l0 28M132.3 96.5l0 23.5M125.5 100.4l0 15.7M118.6 104.4l0 7.7\"/><path class=\"aba-2 aba-s s-a s-n\" style=\"stroke:var(--stage-a1,#c9a6fb);stroke-width:1.8\" d=\"M165.8 111.4l-24.2 14M161 108.6l-24.3 14M156.1 105.8l-24.2 14M151.3 103l-24.3 14M146.4 100.2l-24.2 14M141.6 97.4l-24.3 14M136.7 94.6l-24.2 14\"/><g class=\" s-a\"><use href=\"#sxs-hud-aba\" x=\"218.8\" y=\"126.8\"/><clipPath id=\"aba-hw\"><rect x=\"224.8\" y=\"118.8\" width=\"38\" height=\"16\"/></clipPath><g clip-path=\"url(#aba-hw)\"><g class=\"aba-h aba-s s-a\"><use href=\"#sxs-rows-aba\" x=\"218.8\" y=\"126.8\"/></g></g></g>",
}
