// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A PrusaSlicer project made for another printer, opened on a desktop window: it stays on the printer the plate is on,
// its note offers the printer it was made for, closing the note keeps the plate there, and Switch to moves it to the
// project's printer (the person's own when they have one) with the project's settings. phone-project-printer.spec.ts
// runs the same steps on a phone.
import { offerKeepOrSwitch, switchToOwnPrinter } from './lib/project-printer'
import { sidebarDone, test } from './lib/shell'

test.skip(({ isMobile }) => isMobile, 'Runs at desktop width')

test.describe('the printer an opened project was made for', () => {
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
