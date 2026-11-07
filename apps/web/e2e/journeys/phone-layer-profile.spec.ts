// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Journey (phone): the phone leg of layer-profile.spec.ts. The editor opens from the layer height picker in the
// sheet, edits apply as the plate's own, the plate slices with them, and a fixed height puts it back.
import { editLayerHeights, leavesNothing } from './lib/layer-profile'
import { test } from './lib/shell'

test.skip(({ isMobile }) => !isMobile, 'Phone layout')

test.describe("a plate's own layer heights, on a phone", () => {
  test('are edited on a graph, slice, open again and go with a fixed height', async ({ page }) => {
    test.slow()
    await leavesNothing(page, () => editLayerHeights(page))
  })
})
