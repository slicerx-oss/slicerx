// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Mirror along Z: the mirror plane shows and the part flips across it, staying on the bed.
import type { StageTool } from '@slicerx/ui'

export const loop: StageTool = {
  id: 'mz',
  css: ".sxs .mz-p{animation-name:mz-p}@keyframes mz-p{0%{opacity:0}4.3%{opacity:0}10%{opacity:1}90%{opacity:1}95.7%{opacity:0}100%{opacity:0}}.sxs .mz-o{animation-name:mz-o}@keyframes mz-o{0%{opacity:1}25.7%{opacity:1}40%{opacity:0.18}90%{opacity:0.18}97.1%{opacity:1}100%{opacity:1}}.sxs .mz-n{animation-name:mz-n}@keyframes mz-n{0%{opacity:0}27.1%{opacity:0}37.1%{opacity:1}90%{opacity:1}100%{opacity:0}}",
  body: "<g class=\"mz-o s-a\"><polygon class=\"s-f2 s-ol\" points=\"93.7,99.5 142.2,127.5 142.2,113.5 93.7,85.5\"/><polygon class=\"s-f3 s-ol\" points=\"172.5,110 142.2,127.5 142.2,113.5 172.5,96\"/><polygon class=\"s-f1 s-ol\" points=\"124,68 172.5,96 142.2,113.5 93.7,85.5\"/><polygon class=\"s-f2 s-ol\" points=\"108.8,76.8 124,85.5 124,57.5 108.8,48.8\"/><polygon class=\"s-f3 s-ol\" points=\"139.2,76.8 124,85.5 124,57.5 139.2,48.8\"/><polygon class=\"s-f1 s-ol\" points=\"124,40 139.2,48.8 124,57.5 108.8,48.8\"/></g><g class=\"mz-n s-a\"><polygon class=\"s-f2 s-ol\" points=\"108.8,90.8 124,99.5 124,71.5 108.8,62.8\"/><polygon class=\"s-f3 s-ol\" points=\"139.2,90.8 124,99.5 124,71.5 139.2,62.8\"/><polygon class=\"s-f1 s-ol\" points=\"124,54 139.2,62.8 124,71.5 108.8,62.8\"/><polygon class=\"s-f2 s-ol\" points=\"93.7,71.5 142.2,99.5 142.2,85.5 93.7,57.5\"/><polygon class=\"s-f3 s-ol\" points=\"172.5,82 142.2,99.5 142.2,85.5 172.5,68\"/><polygon class=\"s-f1 s-ol\" points=\"124,40 172.5,68 142.2,85.5 93.7,57.5\"/></g><path class=\"mz-p s-a s-af\" style=\"stroke:var(--stage-a1,#c9a6fb);stroke-width:1.4;stroke-dasharray:4 3\" d=\"M124 50.5l66.7 38.5-48.5 28-66.7-38.5z\"/>",
}
