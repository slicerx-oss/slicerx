// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Polyholes: a round hole prints a little small; turned into a polygon with flat sides, it comes out true and the pin fits.
import type { StageTool } from '@slicerx/ui'

export const loop: StageTool = {
  id: 'aph',
  css: ".sxs .aph-s{animation-timing-function:steps(1,end)}.sxs .aph-a{animation-name:aph-a}@keyframes aph-a{0%{opacity:1}45.7%{opacity:0}94.3%{opacity:1}100%{opacity:1}}.sxs .aph-b{animation-name:aph-b}@keyframes aph-b{0%{opacity:0}45.7%{opacity:1}94.3%{opacity:0}100%{opacity:0}}.sxs .aph-p{animation-name:aph-p}@keyframes aph-p{0%{translate:0 0}45.7%{translate:0 0}60%{translate:0 17.5px}91.4%{translate:0 17.5px}94.3%{translate:0 0}100%{translate:0 0}}",
  body: "<polygon class=\"s-f2 s-ol\" points=\"75.5,110 154.3,155.5 154.3,134.5 75.5,89\"/><polygon class=\"s-f3 s-ol\" points=\"202.8,127.5 154.3,155.5 154.3,134.5 202.8,106.5\"/><polygon class=\"s-f1 s-ol\" points=\"124,61 202.8,106.5 154.3,134.5 75.5,89\"/><g class=\"aph-a aph-s s-a\"><ellipse class=\"s-hole\" cx=\"139.2\" cy=\"97.8\" rx=\"15\" ry=\"8.7\" style=\"stroke:var(--stage-cut,#ff5555);stroke-width:1.6\"/><g class=\"\"><path class=\"s-cya s-aol\" d=\"M124.6 66.3V94.3A14.6 8.4 0 0 0 153.8 94.3V66.3A14.6 8.4 0 0 1 124.6 66.3Z\"/><ellipse class=\"s-g1 s-aol\" cx=\"139.2\" cy=\"66.3\" rx=\"14.6\" ry=\"8.4\"/></g></g><g class=\"aph-b aph-s s-a\"><path class=\"s-hole\" d=\"M145.7 106.9l-13.1 0-9.3-5.4 0-7.5 9.3-5.4 13.1 0 9.3 5.4 0 7.5z\"/><clipPath id=\"aph-k\"><rect x=\"0\" y=\"0\" width=\"296\" height=\"104.8\"/></clipPath><g clip-path=\"url(#aph-k)\"><g class=\"aph-p s-a\"><g class=\"\"><path class=\"s-cya s-aol\" d=\"M124.6 66.3V94.3A14.6 8.4 0 0 0 153.8 94.3V66.3A14.6 8.4 0 0 1 124.6 66.3Z\"/><ellipse class=\"s-g1 s-aol\" cx=\"139.2\" cy=\"66.3\" rx=\"14.6\" ry=\"8.4\"/></g></g></g></g>",
}
