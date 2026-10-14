// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Drop to bed: a part floating over the plate lowered until it rests on it.
import type { StageTool } from '@slicerx/ui'

export const loop: StageTool = {
  id: 'dr',
  css: ".sxs .dr-z{animation-name:dr-z}@keyframes dr-z{0%{translate:0px -31.5px;animation-timing-function:cubic-bezier(.65,0,.35,1)}14.3%{translate:0px -31.5px;animation-timing-function:cubic-bezier(.65,0,.35,1)}34.3%{translate:0 0}88.6%{translate:0 0;opacity:1}94.3%{translate:0 0;opacity:0}94.9%{translate:0px -31.5px;opacity:0}100%{translate:0px -31.5px;opacity:1}}.sxs .dr-f{animation-name:dr-f}@keyframes dr-f{0%{opacity:0}4.3%{opacity:1}32.9%{opacity:1}38.6%{opacity:0}100%{opacity:0}}.sxs .dr-w{animation-name:dr-w}@keyframes dr-w{0%{opacity:0}5.7%{opacity:1}28.6%{opacity:1}34.3%{opacity:0}100%{opacity:0}}",
  body: "<path class=\"dr-f s-a s-n\" style=\"stroke:var(--stage-a1,#c9a6fb);stroke-width:1.4;stroke-dasharray:3 2.5\" d=\"M130.1 96l36.3 21-30.3 17.5-36.3-21z\"/><g class=\"dr-z s-a\"><polygon class=\"s-f2 s-ol\" points=\"99.8,113.5 136.1,134.5 136.1,106.5 99.8,85.5\"/><polygon class=\"s-f3 s-ol\" points=\"166.4,117 136.1,134.5 136.1,106.5 166.4,89\"/><polygon class=\"s-f1 s-ol\" points=\"130.1,68 166.4,89 136.1,106.5 99.8,85.5\"/></g><g class=\"dr-w s-a\"><use href=\"#sxs-arw\" transform=\"translate(179.1 81.3) rotate(180)\"/></g>",
}
