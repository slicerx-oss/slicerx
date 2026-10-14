// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Interlocking: where two materials meet, beams of each reach into the other on alternate layers so the joint holds.
import type { StageTool } from '@slicerx/ui'

export const loop: StageTool = {
  id: 'ail',
  css: ".sxs .ail-s{animation-timing-function:steps(1,end)}.sxs .ail-a{animation-name:ail-a}@keyframes ail-a{0%{opacity:1}45.7%{opacity:0}94.3%{opacity:1}100%{opacity:1}}.sxs .ail-b{animation-name:ail-b}@keyframes ail-b{0%{opacity:0}45.7%{opacity:1}94.3%{opacity:0}100%{opacity:0}}",
  body: "<polygon class=\"s-f3 s-ol\" points=\"93.7,99.5 172.5,145 172.5,110 93.7,64.5\"/><polygon class=\"s-f3 s-ol\" points=\"202.8,127.5 172.5,145 172.5,110 202.8,92.5\"/><polygon class=\"s-f1 s-ol\" points=\"124,47 202.8,92.5 172.5,110 93.7,64.5\"/><g transform=\"matrix(3.031 1.75 0 -3.5 93.7 99.5)\"><rect x=\"1\" y=\"0\" width=\"12\" height=\"10\" style=\"fill:var(--stage-a2,#a57ae8)\"/><rect x=\"13\" y=\"0\" width=\"12\" height=\"10\" style=\"fill:var(--cyan,#8be9fd)\"/><g class=\"ail-a ail-s s-a\"><path class=\"s-n\" style=\"stroke:var(--stage-cut,#ff5555);stroke-width:0.5\" d=\"M13 0V10\"/></g><g class=\"ail-b ail-s s-a\"><rect x=\"13\" y=\"0\" width=\"3\" height=\"2\" style=\"fill:var(--stage-a2,#a57ae8)\"/><rect x=\"10\" y=\"2\" width=\"3\" height=\"2\" style=\"fill:var(--cyan,#8be9fd)\"/><rect x=\"13\" y=\"4\" width=\"3\" height=\"2\" style=\"fill:var(--stage-a2,#a57ae8)\"/><rect x=\"10\" y=\"6\" width=\"3\" height=\"2\" style=\"fill:var(--cyan,#8be9fd)\"/><rect x=\"13\" y=\"8\" width=\"3\" height=\"2\" style=\"fill:var(--stage-a2,#a57ae8)\"/></g></g>",
}
