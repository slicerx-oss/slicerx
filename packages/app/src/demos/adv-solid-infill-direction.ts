// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Solid infill direction: the angle the solid infill lines start at.
import type { StageTool } from '@slicerx/ui'

export const loop: StageTool = {
  id: 'brsd',
  readout: {rows: ["45°","0°"],w: 64},
  css: ".brsd0{animation-name:brsd0;animation-timing-function:steps(1,end)}@keyframes brsd0{0%{opacity:1}50%{opacity:0}98.6%{opacity:1}100%{opacity:1}}.brsd1{animation-name:brsd1;animation-timing-function:steps(1,end)}@keyframes brsd1{0%{opacity:0}50%{opacity:1}98.6%{opacity:0}100%{opacity:0}}.brsd-h{animation-name:brsd-h;animation-timing-function:steps(1,end)}@keyframes brsd-h{0%{translate:0 0px}50%{translate:0 -14px}98.6%{translate:0 0px}100%{translate:0 0px}}",
  body: "<polygon class=\"s-f2 s-ol\" points=\"69.4,113.5 148.2,159 148.2,152 69.4,106.5\"/><polygon class=\"s-f3 s-ol\" points=\"202.8,127.5 148.2,159 148.2,152 202.8,120.5\"/><polygon class=\"s-f1 s-ol\" points=\"124,75 202.8,120.5 148.2,152 69.4,106.5\"/><g class=\"brsd0 s-a\"><path class=\"s-n\" style=\"stroke:var(--stage-a2,#a57ae8);stroke-width:1.3\" d=\"M196.4 118.5l0 3.3l-5.6 3.2l0-9.7l-5.6-3.2l0 16.1l-5.5 3.2l0-22.5l-5.6-3.2l0 28.9l-5.6 3.2l0-35.3l-5.6-3.3l0 41.9l-5.5 3.2l0-48.3l-5.6-3.2l0 54.7l-5.6 .9l0-58.8l-5.5-3.2l0 58.8l-5.6-3.2l0-58.8l-5.6-3.3l0 58.8l-5.6-3.2l0-58.7l-5.5 3.2l0 52.3l-5.6-3.2l0-45.9l-5.6 3.2l0 39.5l-5.5-3.3l0-32.9l-5.6 3.2l0 26.5l-5.6-3.2l0-20.1l-5.6 3.2l0 13.7l-5.5-3.2l0-7.3l-5.6 3.2l0 .9\"/></g><g class=\"brsd1 s-a\"><path class=\"s-n\" style=\"stroke:var(--stage-a2,#a57ae8);stroke-width:1.3\" d=\"M122 77.9l75.2 43.4l-3.9 2.3l-75.2-43.4l-4 2.2l75.2 43.4l-3.9 2.3l-75.2-43.4l-3.9 2.3l75.1 43.4l-3.9 2.3l-75.2-43.4l-3.9 2.2l75.2 43.4l-4 2.3l-75.2-43.4l-3.9 2.3l75.2 43.4l-4 2.3l-75.1-43.4l-4 2.2l75.2 43.4l-3.9 2.3l-75.2-43.4l-4 2.3l75.2 43.4\"/></g><g class=\" s-a\"><use href=\"#sxs-hud-brsd\" x=\"212\" y=\"40\"/><clipPath id=\"brsd-hw\"><rect x=\"218\" y=\"32\" width=\"54\" height=\"16\"/></clipPath><g clip-path=\"url(#brsd-hw)\"><g class=\"brsd-h s-a\"><use href=\"#sxs-rows-brsd\" x=\"212\" y=\"40\"/></g></g></g>",
}
