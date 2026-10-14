// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// One nozzle, many filaments: several filaments share one nozzle, loading one at a time and purging between colors.
import type { StageTool } from '@slicerx/ui'

export const loop: StageTool = {
  id: 'bqs8',
  css: "",
  body: "<path class=\"s-n\" style=\"stroke:var(--stage-a2,#a57ae8);stroke-width:1.6\" d=\"M130.1 29.5C148.2 47 142.2 71.5 154.3 92.5M111.9 40C130.1 57.5 142.2 71.5 154.3 92.5M93.7 50.5C111.9 68 142.2 71.5 154.3 92.5M75.5 61C93.7 78.5 142.2 71.5 154.3 92.5\"/><polygon class=\"s-f2 s-ol\" points=\"142.2,106.5 154.3,113.5 154.3,99.5 142.2,92.5\"/><polygon class=\"s-f3 s-ol\" points=\"166.4,106.5 154.3,113.5 154.3,99.5 166.4,92.5\"/><polygon class=\"s-f1 s-ol\" points=\"154.3,85.5 166.4,92.5 154.3,99.5 142.2,92.5\"/><polygon class=\"s-f2 s-ol\" points=\"154.3,116.3 147,106.5 161.6,106.5\"/><path class=\"s-cy s-ol\" d=\"M119 20.8V29.5A11.1 6.4 0 0 0 141.2 29.5V20.8A11.1 6.4 0 0 1 119 20.8Z\"/><ellipse class=\"s-f1 s-ol\" cx=\"130.1\" cy=\"20.8\" rx=\"11.1\" ry=\"6.4\"/><path class=\"s-cy s-ol\" d=\"M100.8 31.3V40A11.1 6.4 0 0 0 123 40V31.3A11.1 6.4 0 0 1 100.8 31.3Z\"/><ellipse class=\"s-f1 s-ol\" cx=\"111.9\" cy=\"31.3\" rx=\"11.1\" ry=\"6.4\"/><path class=\"s-cy s-ol\" d=\"M82.6 41.8V50.5A11.1 6.4 0 0 0 104.8 50.5V41.8A11.1 6.4 0 0 1 82.6 41.8Z\"/><ellipse class=\"s-f1 s-ol\" cx=\"93.7\" cy=\"41.8\" rx=\"11.1\" ry=\"6.4\"/><path class=\"s-cy s-ol\" d=\"M64.4 52.3V61A11.1 6.4 0 0 0 86.6 61V52.3A11.1 6.4 0 0 1 64.4 52.3Z\"/><ellipse class=\"s-f1 s-ol\" cx=\"75.5\" cy=\"52.3\" rx=\"11.1\" ry=\"6.4\"/>",
}
