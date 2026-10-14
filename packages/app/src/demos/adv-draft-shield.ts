// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Draft shield: a draft chills the side of a part; a thin wall printed around it keeps the air off.
import type { StageTool } from '@slicerx/ui'

export const loop: StageTool = {
  id: 'ads',
  css: ".sxs .ads-s{animation-timing-function:steps(1,end)}.sxs .ads-a{animation-name:ads-a}@keyframes ads-a{0%{opacity:1}45.7%{opacity:0}94.3%{opacity:1}100%{opacity:1}}.sxs .ads-b{animation-name:ads-b}@keyframes ads-b{0%{opacity:0}45.7%{opacity:1}94.3%{opacity:0}100%{opacity:0}}.sxs .ads-w{animation:ads-w .6s linear infinite}@keyframes ads-w{from{stroke-dashoffset:12}to{stroke-dashoffset:0}}",
  body: "<polygon class=\"s-f2 s-ol\" points=\"99.8,117 142.2,141.5 142.2,106.5 99.8,82\"/><polygon class=\"s-f3 s-ol\" points=\"172.5,124 142.2,141.5 142.2,106.5 172.5,89\"/><polygon class=\"s-f1 s-ol\" points=\"130.1,64.5 172.5,89 142.2,106.5 99.8,82\"/><g class=\"ads-a ads-s s-a\"><polygon class=\"s-cf\" points=\"99.8,117 142.2,141.5 142.2,106.5 99.8,82\" style=\"stroke:var(--stage-cut,#ff5555);stroke-width:1.6\"/><path class=\"ads-w s-n\" style=\"stroke:var(--cyan,#8be9fd);stroke-width:2;stroke-dasharray:6 6\" d=\"M69.4 131l36.4-21M69.4 117l36.4-21M84.6 139.8l36.4-21M84.6 125.8l36.4-21M99.8 148.5l36.3-21M99.8 134.5l36.3-21\"/></g><g class=\"ads-b ads-s s-a\"><polygon class=\"s-af\" points=\"80,117.9 140.7,152.9 140.7,114.4 80,79.4\" style=\"stroke:var(--stage-a1,#c9a6fb);stroke-width:1.6\"/><path class=\"ads-w s-n\" style=\"stroke:var(--cyan,#8be9fd);stroke-width:2;stroke-dasharray:6 6\" d=\"M69.4 131l25.8-14.9M69.4 117l25.8-14.9M84.6 139.8l25.8-14.9M84.6 125.8l25.8-14.9M99.8 148.5l25.7-14.9M99.8 134.5l25.7-14.9\"/></g>",
}
