// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Supports, Off: the ledge's first layer prints into the air and sags.
import type { StageTool } from '@slicerx/ui'

export const loop: StageTool = {
  id: 'so',
  css: ".sxs .so-s{animation-name:so-s}@keyframes so-s{0%{opacity:0}5.7%{opacity:0}11.4%{opacity:1}91.4%{opacity:1}97.1%{opacity:0}100%{opacity:0}}",
  body: "<polygon class=\"s-f2 s-ol\" points=\"87.6,103 108.8,115.3 108.8,59.3 87.6,47\"/><polygon class=\"s-f3 s-ol\" points=\"133.1,101.3 108.8,115.3 108.8,59.3 133.1,45.3\"/><polygon class=\"s-f1 s-ol\" points=\"111.9,33 133.1,45.3 108.8,59.3 87.6,47\"/><g class=\"so-s s-a\"><path class=\"s-n s-smil\" d=\"M122.5 68.9Q146.7 82.9 171 96.9M117.3 71.9Q141.6 85.9 165.8 99.9M112.2 74.8Q136.4 88.8 160.7 102.8\" style=\"stroke:var(--stage-cut,#ff5555);stroke-width:2\"><animate attributeName=\"d\" dur=\"3.5s\" repeatCount=\"indefinite\" keyTimes=\"0;0.143;0.457;1\" values=\"M122.5 68.9Q146.7 82.9 171 96.9M117.3 71.9Q141.6 85.9 165.8 99.9M112.2 74.8Q136.4 88.8 160.7 102.8;M122.5 68.9Q146.7 82.9 171 96.9M117.3 71.9Q141.6 85.9 165.8 99.9M112.2 74.8Q136.4 88.8 160.7 102.8;M122.5 68.9Q146.7 103.9 171 96.9M117.3 71.9Q141.6 106.9 165.8 99.9M112.2 74.8Q136.4 109.8 160.7 102.8;M122.5 68.9Q146.7 103.9 171 96.9M117.3 71.9Q141.6 106.9 165.8 99.9M112.2 74.8Q136.4 109.8 160.7 102.8\"/></path><path class=\"s-n s-still\" d=\"M122.5 68.9Q146.7 103.9 171 96.9M117.3 71.9Q141.6 106.9 165.8 99.9M112.2 74.8Q136.4 109.8 160.7 102.8\" style=\"stroke:var(--stage-cut,#ff5555);stroke-width:2\"/></g><polygon class=\"s-f2 s-ol\" points=\"108.8,73.3 160.4,103 160.4,89 108.8,59.3\"/><polygon class=\"s-f3 s-ol\" points=\"184.6,89 160.4,103 160.4,89 184.6,75\"/><polygon class=\"s-f1 s-ol\" points=\"133.1,45.3 184.6,75 160.4,89 108.8,59.3\"/>",
}
