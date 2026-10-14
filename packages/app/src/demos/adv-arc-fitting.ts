// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Arc fitting: a curve written as many short straight moves is sent as one arc move instead, so the printer runs it smoothly.
import type { StageTool } from '@slicerx/ui'

export const loop: StageTool = {
  id: 'aaf',
  css: ".sxs .aaf-s{animation-timing-function:steps(1,end)}.sxs .aaf-a{animation-name:aaf-a}@keyframes aaf-a{0%{opacity:1}45.7%{opacity:0}94.3%{opacity:1}100%{opacity:1}}.sxs .aaf-b{animation-name:aaf-b}@keyframes aaf-b{0%{opacity:0}45.7%{opacity:1}94.3%{opacity:0}100%{opacity:0}}",
  body: "<polygon class=\"s-f2 s-ol\" points=\"75.5,110 154.3,155.5 154.3,146.8 75.5,101.3\"/><polygon class=\"s-f3 s-ol\" points=\"202.8,127.5 154.3,155.5 154.3,146.8 202.8,118.8\"/><polygon class=\"s-f1 s-ol\" points=\"124,73.3 202.8,118.8 154.3,146.8 75.5,101.3\"/><g class=\"aaf-a aaf-s s-a\"><path class=\"s-n\" style=\"stroke:var(--stage-t3,#6c7086);stroke-width:1.6\" d=\"M114.6 96.1l-1.6 4-.2 4.1 1 4 2.2 3.9 3.5 3.5 4.5 3.1 5.4 2.7 6.2 1.9 6.7 1.4 7 .5 7-.1 6.9-.9\"/><path class=\"s-n\" style=\"stroke:var(--stage-cut,#ff5555);stroke-width:4\" style=\"stroke-linecap:round\" d=\"M114.6 96.1h0M113 100.1h0M112.8 104.2h0M113.8 108.2h0M116 112.1h0M119.5 115.6h0M124 118.7h0M129.4 121.4h0M135.6 123.3h0M142.3 124.7h0M149.3 125.2h0M156.3 125.1h0M163.2 124.2h0\"/></g><g class=\"aaf-b aaf-s s-a\"><path class=\"s-n\" style=\"stroke:var(--stage-a1,#c9a6fb);stroke-width:2.4\" d=\"M114.6 96.1l-.5 1-.4 1-.4 1-.3 1-.2 1-.1 1 0 1 .1 1.1 .1 1 .2 1 .3 1 .4 1 .4 1 .5 1 .7 .9 .6 1 .8 .9 .8 .9 .9 .9 1 .8 1 .8 1.1 .8 1.2 .8 1.2 .7 1.3 .8 1.3 .6 1.4 .7 1.4 .6 1.5 .5 1.5 .5 1.6 .5 1.6 .4 1.6 .4 1.7 .4 1.7 .3 1.7 .3 1.7 .2 1.7 .1 1.8 .2 1.8 0 1.7 .1 1.8 0 1.8-.1 1.7-.1 1.8-.2 1.7-.2 1.7-.2 1.7-.3\"/><path class=\"s-n\" style=\"stroke:var(--stage-a1,#c9a6fb);stroke-width:5\" style=\"stroke-linecap:round\" d=\"M114.6 96.1h0M163.2 124.2h0\"/></g>",
}
