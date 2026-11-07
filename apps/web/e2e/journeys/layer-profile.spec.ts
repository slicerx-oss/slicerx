// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A plate's own layer heights on a desktop window: the editor opens from the layer height picker on sleipnir's plan,
// edits apply as the plate's own, the plate slices with them, and a fixed height puts it back.
// phone-layer-profile.spec.ts runs the same steps on a phone.
import { editLayerHeights, leavesNothing } from './lib/layer-profile'
import { test } from './lib/shell'

test.skip(({ isMobile }) => isMobile, 'Runs at desktop width')

test.describe("a plate's own layer heights", () => {
  test('are edited on a graph, slice, open again and go with a fixed height', async ({ page }) => {
    test.slow()
    await leavesNothing(page, () => editLayerHeights(page))
  })
})
