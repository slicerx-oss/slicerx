// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Skirt type: one skirt around all the parts, or one around each part.
import type { StageTool } from '@slicerx/ui'

export const loop: StageTool = {
  id: 'brkt',
  readout: {rows: ["Combined","Per object"],w: 84},
  css: ".brkt0{animation-name:brkt0;animation-timing-function:steps(1,end)}@keyframes brkt0{0%{opacity:1}50%{opacity:0}98.6%{opacity:1}100%{opacity:1}}.brkt1{animation-name:brkt1;animation-timing-function:steps(1,end)}@keyframes brkt1{0%{opacity:0}50%{opacity:1}98.6%{opacity:0}100%{opacity:0}}.brkt-h{animation-name:brkt-h;animation-timing-function:steps(1,end)}@keyframes brkt-h{0%{translate:0 0px}50%{translate:0 -14px}98.6%{translate:0 0px}100%{translate:0 0px}}",
  body: "<polygon class=\"s-f2 s-ol\" points=\"90.7,101.3 114.9,115.3 114.9,90.8 90.7,76.8\"/><polygon class=\"s-f3 s-ol\" points=\"139.2,101.3 114.9,115.3 114.9,90.8 139.2,76.8\"/><polygon class=\"s-f1 s-ol\" points=\"114.9,62.8 139.2,76.8 114.9,90.8 90.7,76.8\"/><polygon class=\"s-f2 s-ol\" points=\"145.2,118.8 169.5,132.8 169.5,108.3 145.2,94.3\"/><polygon class=\"s-f3 s-ol\" points=\"193.7,118.8 169.5,132.8 169.5,108.3 193.7,94.3\"/><polygon class=\"s-f1 s-ol\" points=\"169.5,80.3 193.7,94.3 169.5,108.3 145.2,94.3\"/><g class=\"brkt0 s-a\"><path class=\"s-n\" style=\"stroke:var(--stage-a1,#c9a6fb);stroke-width:1.6\" d=\"M127 69.1l84.9 49-54.6 31.5-84.8-49z\"/></g><g class=\"brkt1 s-a\"><path class=\"s-n\" style=\"stroke:var(--stage-a1,#c9a6fb);stroke-width:1.6\" d=\"M114.9 77.8l39.4 22.8-39.4 22.7-39.4-22.7zM169.5 95.3l39.4 22.8-39.4 22.7-39.4-22.7z\"/></g><g class=\" s-a\"><use href=\"#sxs-hud-brkt\" x=\"196\" y=\"40\"/><clipPath id=\"brkt-hw\"><rect x=\"202\" y=\"32\" width=\"74\" height=\"16\"/></clipPath><g clip-path=\"url(#brkt-hw)\"><g class=\"brkt-h s-a\"><use href=\"#sxs-rows-brkt\" x=\"196\" y=\"40\"/></g></g></g>",
}
