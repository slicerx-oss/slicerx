// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Journey (phone project): the phone legs of project-printer.spec.ts. A PrusaSlicer project made for another printer
// opens on the printer the plate is on; the note in the sheet offers the printer it was made for, closing it keeps the
// plate there, and Switch to moves it to the project's printer with the project's settings.
import { offerKeepOrSwitch, switchToOwnPrinter } from './lib/project-printer'
import { sidebarDone, test } from './lib/shell'

test.skip(({ isMobile }) => !isMobile, 'Phone layout')

test.describe('the printer an opened project was made for, on a phone', () => {
  test('is offered, not switched to: closing the note keeps the printer, Switch to takes the project to its own', async ({ page }) => {
    test.slow()
    try {
      await offerKeepOrSwitch(page)
    } finally {
      await sidebarDone(page)
    }
  })

  test("Switch to picks the person's own printer of that model", async ({ page }) => {
    test.slow()
    try {
      await switchToOwnPrinter(page)
    } finally {
      await sidebarDone(page)
    }
  })
})
