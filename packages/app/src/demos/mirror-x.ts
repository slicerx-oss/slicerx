// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Mirror along X: the mirror plane shows and the part flips across it, staying on the bed.
import type { StageTool } from '@slicerx/ui'

export const loop: StageTool = {
  id: 'mx',
  css: ".sxs .mx-p{animation-name:mx-p}@keyframes mx-p{0%{opacity:0}4.3%{opacity:0}10%{opacity:1}90%{opacity:1}95.7%{opacity:0}100%{opacity:0}}.sxs .mx-o{animation-name:mx-o}@keyframes mx-o{0%{opacity:1}25.7%{opacity:1}40%{opacity:0.18}90%{opacity:0.18}97.1%{opacity:1}100%{opacity:1}}.sxs .mx-n{animation-name:mx-n}@keyframes mx-n{0%{opacity:0}27.1%{opacity:0}37.1%{opacity:1}90%{opacity:1}100%{opacity:0}}",
  body: "<g class=\"mx-o s-a\"><polygon class=\"s-f2 s-ol\" points=\"93.7,99.5 142.2,127.5 142.2,113.5 93.7,85.5\"/><polygon class=\"s-f3 s-ol\" points=\"172.5,110 142.2,127.5 142.2,113.5 172.5,96\"/><polygon class=\"s-f1 s-ol\" points=\"124,68 172.5,96 142.2,113.5 93.7,85.5\"/><polygon class=\"s-f2 s-ol\" points=\"108.8,76.8 124,85.5 124,57.5 108.8,48.8\"/><polygon class=\"s-f3 s-ol\" points=\"139.2,76.8 124,85.5 124,57.5 139.2,48.8\"/><polygon class=\"s-f1 s-ol\" points=\"124,40 139.2,48.8 124,57.5 108.8,48.8\"/></g><g class=\"mx-n s-a\"><polygon class=\"s-f2 s-ol\" points=\"93.7,99.5 142.2,127.5 142.2,113.5 93.7,85.5\"/><polygon class=\"s-f3 s-ol\" points=\"172.5,110 142.2,127.5 142.2,113.5 172.5,96\"/><polygon class=\"s-f1 s-ol\" points=\"124,68 172.5,96 142.2,113.5 93.7,85.5\"/><polygon class=\"s-f2 s-ol\" points=\"142.2,96 157.3,104.8 157.3,76.8 142.2,68\"/><polygon class=\"s-f3 s-ol\" points=\"172.5,96 157.3,104.8 157.3,76.8 172.5,68\"/><polygon class=\"s-f1 s-ol\" points=\"157.3,59.3 172.5,68 157.3,76.8 142.2,68\"/></g><path class=\"mx-p s-a s-af\" style=\"stroke:var(--stage-a1,#c9a6fb);stroke-width:1.4;stroke-dasharray:4 3\" d=\"M157.3 90.8l-48.5 28 0-49 48.5-28z\"/>",
}
