// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Shell: a block's top face picked, then the block hollowed into a tray with even walls.
import type { StageTool } from '@slicerx/ui'

export const loop: StageTool = {
  id: 'sh',
  badge: {cut: 0.75},
  readout: {rows: ["Walls 2.5 mm"],w: 86},
  css: ".sxs .sh-f{animation-name:sh-f}.sxs .sh-o{animation-name:sh-o}.sxs .sh-w{animation-name:sh-w}@keyframes sh-o{0%{opacity:0}20%{opacity:0}21.4%{opacity:1}97.1%{opacity:1}98.6%{opacity:0}100%{opacity:0}}@keyframes sh-w{0%{opacity:0}14.9%{opacity:0}17.1%{opacity:1}51.4%{opacity:1}57.1%{opacity:0}100%{opacity:0}}@keyframes sh-f{0%{translate:0 0}21.4%{translate:0 0;animation-timing-function:cubic-bezier(.65,0,.35,1)}50%{translate:0 31.5px}88.6%{translate:0 31.5px;animation-timing-function:cubic-bezier(.65,0,.35,1)}98.6%{translate:0 0}100%{translate:0 0}}",
  body: "<polygon class=\"s-f2 s-ol\" points=\"75.5,110 142.2,148.5 142.2,106.5 75.5,68\"/><polygon class=\"s-f3 s-ol\" points=\"190.7,120.5 142.2,148.5 142.2,106.5 190.7,78.5\"/><polygon class=\"s-lit s-a s-ol\" points=\"124,40 190.7,78.5 142.2,106.5 75.5,68\"/><clipPath id=\"sh-c\"><polygon points=\"124,48.8 175.5,78.5 142.2,97.8 90.7,68\"/></clipPath><g class=\"sh-o s-a\"><g clip-path=\"url(#sh-c)\"><polygon class=\"s-f3 s-ol\" points=\"124,48.8 90.7,68 90.7,103 124,83.8\"/><polygon class=\"s-f2 s-ol\" points=\"124,48.8 175.5,78.5 175.5,113.5 124,83.8\"/><g class=\"sh-f s-a\"><polygon class=\"s-lit s-a s-ol\" points=\"124,48.8 175.5,78.5 142.2,97.8 90.7,68\"/></g></g></g><g class=\"sh-w s-a\"><g class=\"sh-f s-a\"><use href=\"#sxs-arw\" transform=\"translate(133.1 43.3) rotate(180)\"/></g></g><circle class=\"sxs-rip s-a\" cx=\"141.6\" cy=\"102\" r=\"9\"/><use href=\"#sxs-ptr\" x=\"141.6\" y=\"102\"/><g class=\"s-hud s-a\"><use href=\"#sxs-hud-sh\" x=\"165.6\" y=\"122\"/><clipPath id=\"sh-hw\"><rect x=\"171.6\" y=\"114\" width=\"76\" height=\"16\"/></clipPath><g clip-path=\"url(#sh-hw)\"><g class=\"\"><use href=\"#sxs-rows-sh\" x=\"165.6\" y=\"122\"/></g></g></g>",
}
