// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Make overhangs printable: a flat underside that would hang in the air is reshaped into a slope that prints without support.
import type { StageTool } from '@slicerx/ui'

export const loop: StageTool = {
  id: 'amp',
  css: ".sxs .amp-s{animation-timing-function:steps(1,end)}.sxs .amp-a{animation-name:amp-a}@keyframes amp-a{0%{opacity:1}45.7%{opacity:0}94.3%{opacity:1}100%{opacity:1}}.sxs .amp-b{animation-name:amp-b}@keyframes amp-b{0%{opacity:0}45.7%{opacity:1}94.3%{opacity:0}100%{opacity:0}}",
  body: "<polygon class=\"s-f2 s-ol\" points=\"87.6,103 108.8,115.3 108.8,66.3 87.6,54\"/><polygon class=\"s-f3 s-ol\" points=\"139.2,97.8 108.8,115.3 108.8,66.3 139.2,48.8\"/><polygon class=\"s-f1 s-ol\" points=\"117.9,36.5 139.2,48.8 108.8,66.3 87.6,54\"/><g class=\"amp-b amp-s s-a\"><polygon class=\"s-g2 s-aol\" points=\"108.8,108.3 148.2,106.5 108.8,83.8\"/><polygon class=\"s-g3 s-aol\" points=\"178.6,89 148.2,106.5 108.8,108.3 139.2,90.8\"/></g><polygon class=\"s-f2 s-ol\" points=\"108.8,83.8 148.2,106.5 148.2,89 108.8,66.3\"/><polygon class=\"s-f3 s-ol\" points=\"178.6,89 148.2,106.5 148.2,89 178.6,71.5\"/><polygon class=\"s-f1 s-ol\" points=\"139.2,48.8 178.6,71.5 148.2,89 108.8,66.3\"/><g class=\"amp-a amp-s s-a\"><path class=\"s-n\" style=\"stroke:var(--stage-cut,#ff5555);stroke-width:2\" d=\"M108.8 83.8l39.4 22.7 30.4-17.5\"/></g>",
}
