// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// More walls under overhangs: steep overhangs get extra wall loops so they hold their shape.
import type { StageTool } from '@slicerx/ui'

export const loop: StageTool = {
  id: 'aow',
  css: ".sxs .aow-s{animation-timing-function:steps(1,end)}.sxs .aow-a{animation-name:aow-a}@keyframes aow-a{0%{opacity:1}45.7%{opacity:0}94.3%{opacity:1}100%{opacity:1}}.sxs .aow-b{animation-name:aow-b}@keyframes aow-b{0%{opacity:0}45.7%{opacity:1}94.3%{opacity:0}100%{opacity:0}}",
  body: "<polygon class=\"s-f2 s-ol\" points=\"87.6,103 111.9,117 111.9,68 87.6,54\"/><polygon class=\"s-f3 s-ol\" points=\"136.1,103 111.9,117 111.9,68 136.1,54\"/><polygon class=\"s-f1 s-ol\" points=\"111.9,40 136.1,54 111.9,68 87.6,54\"/><polygon class=\"s-f2 s-ol\" points=\"111.9,85.5 154.3,110 154.3,92.5 111.9,68\"/><polygon class=\"s-f3 s-ol\" points=\"178.6,96 154.3,110 154.3,92.5 178.6,78.5\"/><polygon class=\"s-f1 s-ol\" points=\"136.1,54 178.6,78.5 154.3,92.5 111.9,68\"/><path class=\"s-n\" style=\"stroke:var(--stage-t3,#6c7086);stroke-width:1.4\" d=\"M111.9 82l42.4 24.5M111.9 71.5l42.4 24.5\"/><g class=\"aow-b aow-s s-a\"><path class=\"s-n\" style=\"stroke:var(--stage-a1,#c9a6fb);stroke-width:1.4\" d=\"M111.9 78.5l42.4 24.5M111.9 75l42.4 24.5\"/></g>",
}
