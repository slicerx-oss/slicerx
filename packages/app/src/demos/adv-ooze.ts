// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Ooze prevention: the idle nozzle drops in temperature while the other prints, so it does not drip onto the part.
import type { StageTool } from '@slicerx/ui'

export const loop: StageTool = {
  id: 'aoz',
  readout: {rows: ["0 °C","−40 °C"],w: 56},
  css: ".sxs .aoz-s{animation-timing-function:steps(1,end)}.sxs .aoz-a{animation-name:aoz-a}@keyframes aoz-a{0%{opacity:1}45.7%{opacity:0}94.3%{opacity:1}100%{opacity:1}}.sxs .aoz-b{animation-name:aoz-b}@keyframes aoz-b{0%{opacity:0}45.7%{opacity:1}94.3%{opacity:0}100%{opacity:0}}.sxs .aoz-h{animation-name:aoz-h}@keyframes aoz-h{0%{translate:0 0px}45.7%{translate:0 -14px}94.3%{translate:0 0px}100%{translate:0 0px}}.sxs .aoz-d{animation-name:aoz-d}@keyframes aoz-d{0%{translate:0 0;opacity:1}34.3%{translate:0 6px;opacity:1}42.9%{translate:0 6px;opacity:0}100%{translate:0 6px;opacity:0}}",
  body: "<polygon class=\"s-f2 s-ol\" points=\"75.5,110 154.3,155.5 154.3,141.5 75.5,96\"/><polygon class=\"s-f3 s-ol\" points=\"202.8,127.5 154.3,155.5 154.3,141.5 202.8,113.5\"/><polygon class=\"s-f1 s-ol\" points=\"124,68 202.8,113.5 154.3,141.5 75.5,96\"/><g class=\"\"><polygon class=\"s-g2 s-aol\" points=\"121,87.3 116,76.3 126,76.3\"/><rect class=\"s-g1 s-aol\" x=\"113\" y=\"66.3\" width=\"16\" height=\"10\" rx=\"2\"/></g><g class=\"\"><polygon class=\"s-g2 s-aol\" points=\"160.4,110 155.4,99 165.4,99\"/><rect class=\"s-g1 s-aol\" x=\"152.4\" y=\"89\" width=\"16\" height=\"10\" rx=\"2\"/></g><g class=\"aoz-a aoz-s s-a\"><path class=\"aoz-d s-a\" style=\"fill:var(--stage-cut,#ff5555)\" d=\"M160.4 110q-2.4 4.5 0 6.5q2.4-2 0-6.5Z\"/><ellipse cx=\"160.4\" cy=\"117\" rx=\"4\" ry=\"1.6\" style=\"fill:var(--stage-cut,#ff5555);fill-opacity:.55\"/></g><g class=\" s-a\"><use href=\"#sxs-hud-aoz\" x=\"218.8\" y=\"119.5\"/><clipPath id=\"aoz-hw\"><rect x=\"224.8\" y=\"111.5\" width=\"46\" height=\"16\"/></clipPath><g clip-path=\"url(#aoz-hw)\"><g class=\"aoz-h aoz-s s-a\"><use href=\"#sxs-rows-aoz\" x=\"218.8\" y=\"119.5\"/></g></g></g>",
}
