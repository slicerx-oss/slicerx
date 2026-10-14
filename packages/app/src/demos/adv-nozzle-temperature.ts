// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Nozzle temperature: too cold and the line breaks into gaps; right, it is even; too hot and it strings and sags.
import type { StageTool } from '@slicerx/ui'

export const loop: StageTool = {
  id: 'ant',
  readout: {rows: ["190 °C","215 °C","240 °C"],w: 56},
  css: ".sxs .ant-s{animation-timing-function:steps(1,end)}.sxs .ant-h{animation-name:ant-h}@keyframes ant-h{0%{translate:0 0px}31.4%{translate:0 -14px}62.9%{translate:0 -28px}94.3%{translate:0 0px}100%{translate:0 0px}}.sxs .ant-0{animation-name:ant-0}@keyframes ant-0{0%{opacity:1}31.4%{opacity:0}94.3%{opacity:1}100%{opacity:1}}.sxs .ant-1{animation-name:ant-1}@keyframes ant-1{0%{opacity:0}31.4%{opacity:1}62.9%{opacity:0}100%{opacity:0}}.sxs .ant-2{animation-name:ant-2}@keyframes ant-2{0%{opacity:0}62.9%{opacity:1}94.3%{opacity:0}100%{opacity:0}}",
  body: "<polygon class=\"s-f2 s-ol\" points=\"75.5,110 154.3,155.5 154.3,145 75.5,99.5\"/><polygon class=\"s-f3 s-ol\" points=\"202.8,127.5 154.3,155.5 154.3,145 202.8,117\"/><polygon class=\"s-f1 s-ol\" points=\"124,71.5 202.8,117 154.3,145 75.5,99.5\"/><g class=\"ant-0 ant-s s-a\"><path class=\"s-n\" style=\"stroke:var(--stage-cut,#ff5555);stroke-width:2.6;stroke-dasharray:3 2.5\" d=\"M121 80.3l66.7 38.5M105.8 89l66.7 38.5M90.7 97.8l66.6 38.5\"/></g><g class=\"ant-1 ant-s s-a\"><path class=\"s-n\" style=\"stroke:var(--stage-a1,#c9a6fb);stroke-width:2.6\" d=\"M121 80.3l66.7 38.5M105.8 89l66.7 38.5M90.7 97.8l66.6 38.5\"/></g><g class=\"ant-2 ant-s s-a\"><path class=\"s-n\" style=\"stroke:var(--stage-cut,#ff5555);stroke-width:3.4\" d=\"M121 80.3l66.7 38.5M105.8 89l66.7 38.5M90.7 97.8l66.6 38.5\"/><path class=\"s-n\" style=\"stroke:var(--stage-cut,#ff5555);stroke-width:0.9\" d=\"M133.1 87.3Q128.5 82.9 114.9 94.3M142.2 110Q137.6 105.6 124 117M172.5 110Q168 105.6 154.3 117\"/></g><g class=\" s-a\"><use href=\"#sxs-hud-ant\" x=\"218.8\" y=\"125\"/><clipPath id=\"ant-hw\"><rect x=\"224.8\" y=\"117\" width=\"46\" height=\"16\"/></clipPath><g clip-path=\"url(#ant-hw)\"><g class=\"ant-h ant-s s-a\"><use href=\"#sxs-rows-ant\" x=\"218.8\" y=\"125\"/></g></g></g>",
}
