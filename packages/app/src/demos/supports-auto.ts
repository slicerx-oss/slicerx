// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Supports, Auto: a tree grows from the plate to hold the whole ledge.
import type { StageTool } from '@slicerx/ui'

export const loop: StageTool = {
  id: 'sa',
  css: ".sxs .sa-t{animation-name:sa-t}@keyframes sa-t{0%{stroke-dashoffset:100;opacity:0}11.4%{stroke-dashoffset:100;opacity:0}12.6%{stroke-dashoffset:96;opacity:1}40%{stroke-dashoffset:0}91.4%{opacity:1}97.1%{opacity:0}100%{opacity:0}}",
  body: "<polygon class=\"s-f2 s-ol\" points=\"87.6,103 108.8,115.3 108.8,59.3 87.6,47\"/><polygon class=\"s-f3 s-ol\" points=\"133.1,101.3 108.8,115.3 108.8,59.3 133.1,45.3\"/><polygon class=\"s-f1 s-ol\" points=\"111.9,33 133.1,45.3 108.8,59.3 87.6,47\"/><path class=\"sa-t s-a s-n\" pathLength=\"100\" style=\"stroke-dasharray:100;stroke:var(--stage-a2,#a57ae8);stroke-width:3.2\" d=\"M142.2 127.5l0-17.5M142.2 110Q133.9 92.9 125.5 75.9M142.2 110Q142.2 97.8 142.2 85.5M142.2 110Q150.5 102.6 158.9 95.1\"/><polygon class=\"s-f2 s-ol\" points=\"108.8,73.3 160.4,103 160.4,89 108.8,59.3\"/><polygon class=\"s-f3 s-ol\" points=\"184.6,89 160.4,103 160.4,89 184.6,75\"/><polygon class=\"s-f1 s-ol\" points=\"133.1,45.3 184.6,75 160.4,89 108.8,59.3\"/>",
}
