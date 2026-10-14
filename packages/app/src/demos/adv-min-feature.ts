// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Min feature size: features thinner than this share of the nozzle are left out instead of printed.
import type { StageTool } from '@slicerx/ui'

export const loop: StageTool = {
  id: 'amf',
  readout: {rows: ["25 %","75 %"],w: 52},
  css: ".sxs .amf-s{animation-timing-function:steps(1,end)}.sxs .amf-a{animation-name:amf-a}@keyframes amf-a{0%{opacity:1}45.7%{opacity:0}94.3%{opacity:1}100%{opacity:1}}.sxs .amf-b{animation-name:amf-b}@keyframes amf-b{0%{opacity:0}45.7%{opacity:1}94.3%{opacity:0}100%{opacity:0}}.sxs .amf-h{animation-name:amf-h}@keyframes amf-h{0%{translate:0 0px}45.7%{translate:0 -14px}94.3%{translate:0 0px}100%{translate:0 0px}}",
  body: "<polygon class=\"s-f2 s-ol\" points=\"81.6,106.5 160.4,152 160.4,131 81.6,85.5\"/><polygon class=\"s-f3 s-ol\" points=\"202.8,127.5 160.4,152 160.4,131 202.8,106.5\"/><polygon class=\"s-f1 s-ol\" points=\"124,61 202.8,106.5 160.4,131 81.6,85.5\"/><g class=\"amf-a amf-s s-a\"><polygon class=\"s-g2 s-aol\" points=\"119.2,84.8 161.6,109.3 161.6,88.3 119.2,63.8\"/><polygon class=\"s-g3 s-aol\" points=\"163.4,108.3 161.6,109.3 161.6,88.3 163.4,87.3\"/><polygon class=\"s-g1 s-aol\" points=\"121,62.8 163.4,87.3 161.6,88.3 119.2,63.8\"/></g><g class=\"amf-b amf-s s-a\"><path class=\"s-ghost\" d=\"M119.2 84.8l0-21 42.4 24.5 0 21\"/></g><g class=\" s-a\"><use href=\"#sxs-hud-amf\" x=\"218.8\" y=\"112.5\"/><clipPath id=\"amf-hw\"><rect x=\"224.8\" y=\"104.5\" width=\"42\" height=\"16\"/></clipPath><g clip-path=\"url(#amf-hw)\"><g class=\"amf-h amf-s s-a\"><use href=\"#sxs-rows-amf\" x=\"218.8\" y=\"112.5\"/></g></g></g>",
}
