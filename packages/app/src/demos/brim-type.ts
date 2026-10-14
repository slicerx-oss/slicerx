// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Brim type: the same block, an all-around brim, then mouse ears: small discs under the corners only.
import type { StageTool } from '@slicerx/ui'

export const loop: StageTool = {
  id: 'bt',
  css: ".sxs .bt-r{animation-name:bt-r}@keyframes bt-r{0%{opacity:0}4.3%{opacity:0}10%{opacity:1}44.3%{opacity:1}50%{opacity:0}100%{opacity:0}}.sxs .bt-e{animation-name:bt-e}@keyframes bt-e{0%{opacity:0;scale:.3}48.6%{opacity:0;scale:.3}57.1%{opacity:1;scale:1}91.4%{opacity:1}97.1%{opacity:0}100%{opacity:0}}.sxs .bt-e{transform-box:fill-box;transform-origin:center}",
  body: "<path class=\"bt-r s-a s-n\" style=\"stroke:var(--stage-a1,#c9a6fb);stroke-width:1.6\" d=\"M127 91.5l53.4 30.8-35.2 20.3-53.3-30.8zM127 88l59.4 34.3-41.2 23.8-59.4-34.3zM127 84.5l65.5 37.8-47.3 27.3-65.5-37.8zM127 81l71.6 41.3-53.4 30.8-71.5-41.3zM127 77.5l77.6 44.8-59.4 34.3-77.6-44.8z\"/><ellipse class=\"bt-e s-a s-af\" cx=\"127\" cy=\"94.3\" rx=\"15\" ry=\"8.7\" style=\"stroke:var(--stage-a1,#c9a6fb);stroke-width:1.6\"/><ellipse class=\"bt-e s-a s-af\" cx=\"175.5\" cy=\"122.3\" rx=\"15\" ry=\"8.7\" style=\"stroke:var(--stage-a1,#c9a6fb);stroke-width:1.6\"/><ellipse class=\"bt-e s-a s-af\" cx=\"145.2\" cy=\"139.8\" rx=\"15\" ry=\"8.7\" style=\"stroke:var(--stage-a1,#c9a6fb);stroke-width:1.6\"/><ellipse class=\"bt-e s-a s-af\" cx=\"96.7\" cy=\"111.8\" rx=\"15\" ry=\"8.7\" style=\"stroke:var(--stage-a1,#c9a6fb);stroke-width:1.6\"/><polygon class=\"s-f2 s-ol\" points=\"96.7,111.8 145.2,139.8 145.2,108.3 96.7,80.3\"/><polygon class=\"s-f3 s-ol\" points=\"175.5,122.3 145.2,139.8 145.2,108.3 175.5,90.8\"/><polygon class=\"s-f1 s-ol\" points=\"127,62.8 175.5,90.8 145.2,108.3 96.7,80.3\"/>",
}
