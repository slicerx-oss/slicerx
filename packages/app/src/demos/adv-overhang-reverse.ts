// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Overhang reverse: on every other layer the walls over an overhang run the other way, which keeps the edge from curling.
import type { StageTool } from '@slicerx/ui'

export const loop: StageTool = {
  id: 'aor',
  css: ".sxs .aor-s{animation-timing-function:steps(1,end)}.sxs .aor-a{animation-name:aor-a}@keyframes aor-a{0%{opacity:1}45.7%{opacity:0}94.3%{opacity:1}100%{opacity:1}}.sxs .aor-b{animation-name:aor-b}@keyframes aor-b{0%{opacity:0}45.7%{opacity:1}94.3%{opacity:0}100%{opacity:0}}",
  body: "<polygon class=\"s-f3 s-ol\" points=\"93.7,99.5 172.5,145 172.5,111.8 93.7,66.3\"/><polygon class=\"s-f3 s-ol\" points=\"202.8,127.5 172.5,145 172.5,111.8 202.8,94.3\"/><polygon class=\"s-f1 s-ol\" points=\"124,48.8 202.8,94.3 172.5,111.8 93.7,66.3\"/><g transform=\"matrix(3.031 1.75 0 -3.5 93.7 99.5)\"><rect class=\"s-f1\" x=\"1\" y=\"0.3\" width=\"24\" height=\"2.6\" rx=\".6\"/><rect class=\"s-f1\" x=\"1\" y=\"3.3\" width=\"24\" height=\"2.6\" rx=\".6\"/><rect class=\"s-f1\" x=\"1\" y=\"6.3\" width=\"24\" height=\"2.6\" rx=\".6\"/><g class=\"aor-a aor-s s-a\"><path class=\"s-n\" style=\"stroke:var(--stage-cut,#ff5555);stroke-width:0.6\" d=\"M5 0.6000000000000001l2 1l-2 1M12 0.6000000000000001l2 1l-2 1M19 0.6000000000000001l2 1l-2 1M5 3.5999999999999996l2 1l-2 1M12 3.5999999999999996l2 1l-2 1M19 3.5999999999999996l2 1l-2 1M5 6.6l2 1l-2 1M12 6.6l2 1l-2 1M19 6.6l2 1l-2 1\"/></g><g class=\"aor-b aor-s s-a\"><path class=\"s-n\" style=\"stroke:var(--stage-a1,#c9a6fb);stroke-width:0.6\" d=\"M5 0.6000000000000001l2 1l-2 1M12 0.6000000000000001l2 1l-2 1M19 0.6000000000000001l2 1l-2 1M7 3.5999999999999996l-2 1l2 1M14 3.5999999999999996l-2 1l2 1M21 3.5999999999999996l-2 1l2 1M5 6.6l2 1l-2 1M12 6.6l2 1l-2 1M19 6.6l2 1l-2 1\"/></g></g>",
}
