// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Cool Plate temperature: too cold and the part's corner lifts as it shrinks; warm enough and it stays stuck.
import type { StageTool } from '@slicerx/ui'

export const loop: StageTool = {
  id: 'bwcp',
  readout: {rows: ["Cool plate 20 °C","Cool plate 35 °C"],w: 112},
  css: ".bwcp0{animation-name:bwcp0;animation-timing-function:steps(1,end)}@keyframes bwcp0{0%{opacity:1}50%{opacity:0}98.6%{opacity:1}100%{opacity:1}}.bwcp1{animation-name:bwcp1;animation-timing-function:steps(1,end)}@keyframes bwcp1{0%{opacity:0}50%{opacity:1}98.6%{opacity:0}100%{opacity:0}}.bwcp-h{animation-name:bwcp-h;animation-timing-function:steps(1,end)}@keyframes bwcp-h{0%{translate:0 0px}50%{translate:0 -14px}98.6%{translate:0 0px}100%{translate:0 0px}}.bwcp-w{animation-name:bwcp-w;transform-box:fill-box;transform-origin:0 100%}@keyframes bwcp-w{0%{rotate:0deg}8.6%{rotate:0deg}31.4%{rotate:-4deg}45.7%{rotate:-4deg}48.6%{rotate:0deg}100%{rotate:0deg}}",
  body: "<polygon class=\"s-f2 s-ol\" points=\"51.3,112.8 142.2,165.3 142.2,162.5 51.3,110\"/><polygon class=\"s-f3 s-ol\" points=\"214.9,123.3 142.2,165.3 142.2,162.5 214.9,120.5\"/><polygon class=\"s-f1 s-ol\" points=\"124,68 214.9,120.5 142.2,162.5 51.3,110\"/><g class=\"bwcp0 s-a\"><path class=\"s-n s-ghost\" style=\"stroke:var(--stage-cut,#ff5555);stroke-width:1.4\" d=\"M99.8 110l42.4 24.5 24.2-14\"/></g><g class=\"bwcp1 s-a\"><path class=\"s-n\" style=\"stroke:var(--stage-a1,#c9a6fb);stroke-width:1.6\" d=\"M63.4 113.5q3 -6 0 -12M93.7 131q3 -6 0 -12M136.1 148.5q3 -6 0 -12\"/></g><g class=\"bwcp-w s-a\"><polygon class=\"s-f2 s-ol\" points=\"99.8,110 142.2,134.5 142.2,85.5 99.8,61\"/><polygon class=\"s-f3 s-ol\" points=\"166.4,120.5 142.2,134.5 142.2,85.5 166.4,71.5\"/><polygon class=\"s-f1 s-ol\" points=\"124,47 166.4,71.5 142.2,85.5 99.8,61\"/></g><g class=\" s-a\"><use href=\"#sxs-hud-bwcp\" x=\"178\" y=\"40\"/><clipPath id=\"bwcp-hw\"><rect x=\"184\" y=\"32\" width=\"102\" height=\"16\"/></clipPath><g clip-path=\"url(#bwcp-hw)\"><g class=\"bwcp-h s-a\"><use href=\"#sxs-rows-bwcp\" x=\"178\" y=\"40\"/></g></g></g>",
}
