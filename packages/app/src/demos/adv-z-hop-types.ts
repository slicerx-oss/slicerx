// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Z hop type: normal lifts straight up, slope lifts while it moves, spiral circles up, which can reduce strings.
import type { StageTool } from '@slicerx/ui'

export const loop: StageTool = {
  id: 'bwzt',
  readout: {rows: ["Normal","Slope","Spiral"],w: 72},
  css: ".bwzt0{animation-name:bwzt0;animation-timing-function:steps(1,end)}@keyframes bwzt0{0%{opacity:1}32.9%{opacity:0}98.6%{opacity:1}100%{opacity:1}}.bwzt1{animation-name:bwzt1;animation-timing-function:steps(1,end)}@keyframes bwzt1{0%{opacity:0}32.9%{opacity:1}65.7%{opacity:0}100%{opacity:0}}.bwzt2{animation-name:bwzt2;animation-timing-function:steps(1,end)}@keyframes bwzt2{0%{opacity:0}65.7%{opacity:1}98.6%{opacity:0}100%{opacity:0}}.bwzt-h{animation-name:bwzt-h;animation-timing-function:steps(1,end)}@keyframes bwzt-h{0%{translate:0 0px}32.9%{translate:0 -14px}65.7%{translate:0 -28px}98.6%{translate:0 0px}100%{translate:0 0px}}",
  body: "<polygon class=\"s-f2 s-ol\" points=\"81.6,106.5 160.4,152 160.4,138 81.6,92.5\"/><polygon class=\"s-f3 s-ol\" points=\"202.8,127.5 160.4,152 160.4,138 202.8,113.5\"/><polygon class=\"s-f1 s-ol\" points=\"124,68 202.8,113.5 160.4,138 81.6,92.5\"/><g class=\"bwzt0 s-a\"><path class=\"s-n\" style=\"stroke:var(--stage-a2,#a57ae8);stroke-width:2\" d=\"M111.9 84.8l0-16.8 60.6 35 0 16.8\"/></g><g class=\"bwzt1 s-a\"><path class=\"s-n\" style=\"stroke:var(--stage-a2,#a57ae8);stroke-width:2\" d=\"M111.9 84.8l18.2-6.3 42.4 24.5 0 16.8\"/></g><g class=\"bwzt2 s-a\"><path class=\"s-n\" style=\"stroke:var(--stage-a2,#a57ae8);stroke-width:2\" d=\"M111.9 84.8l1.5 .2 .5 .5-.5 .5-1.5 .2-2.2-.2-2.7-.7-2.6-1.4-2.2-1.9-1.5-2.3-.5-2.6 .5-2.6 1.5-2.3 2.2-1.9 2.6-1.4 2.7-.7 2.2-.2 60.6 35 0 16.8\"/></g><g class=\" s-a\"><use href=\"#sxs-hud-bwzt\" x=\"204\" y=\"40\"/><clipPath id=\"bwzt-hw\"><rect x=\"210\" y=\"32\" width=\"62\" height=\"16\"/></clipPath><g clip-path=\"url(#bwzt-hw)\"><g class=\"bwzt-h s-a\"><use href=\"#sxs-rows-bwzt\" x=\"204\" y=\"40\"/></g></g></g>",
}
