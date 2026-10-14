// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Hollow: hollowing empties the inside and leaves an even wall all around, here 2 mm, which saves material and print time.
import type { StageTool } from '@slicerx/ui'

export const loop: StageTool = {
  id: 'uhol',
  css: "",
  body: "<polygon class=\"s-f3 s-ol\" points=\"66.4,66.3 151.3,115.3 151.3,69.8 66.4,20.8\"/><polygon class=\"s-f3 s-ol\" points=\"181.6,97.8 151.3,115.3 151.3,69.8 181.6,52.3\"/><polygon class=\"s-f1 s-ol\" points=\"96.7,3.3 181.6,52.3 151.3,69.8 66.4,20.8\"/><path style=\"fill:var(--stage-t1);stroke:var(--stage-ol);stroke-width:1.4\" d=\"M66.4 66.3L151.3 115.3L151.3 69.8L66.4 20.8Z\"/><polygon class=\"s-hole\" points=\"72.5,62.8 145.2,104.8 145.2,73.3 72.5,31.3\"/><path class=\"s-n\" style=\"stroke:var(--stage-ol);stroke-width:3.4\" d=\"M145.2 92.2L145.2 86.9L151.3 90.4L151.3 95.7\"/><path class=\"s-n\" style=\"stroke:var(--stage-a1,#c9a6fb);stroke-width:1.4\" d=\"M145.2 92.2L145.2 86.9L151.3 90.4L151.3 95.7\"/><path class=\"s-n\" style=\"stroke:var(--stage-a1,#c9a6fb);stroke-width:1.2\" d=\"M148.2 88.7L226 46\"/><rect class=\"sxs-pill\" x=\"226\" y=\"37\" width=\"42\" height=\"18\" rx=\"9\"/><text x=\"235\" y=\"49.7\">2 mm</text>",
}
