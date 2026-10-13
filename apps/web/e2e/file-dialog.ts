// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// File dialogs in the specs. Playwright turns dialog interception on when a page gets its first filechooser listener
// and does not wait for the browser to apply it. A wait set up just before the press or click that opens the dialog
// can lose that race on a busy machine: the dialog then opens for real, the headless browser cancels it a few
// milliseconds later, and no filechooser event ever comes. So a page keeps one listener from before its first load,
// and each open takes the next dialog that listener saw.
import { expect, type FileChooser, type Page } from '@playwright/test'

const dialogs = new WeakMap<Page, FileChooser[]>()

/** Intercepts every file dialog the page opens from now on. Call it before the page's first `goto`. */
export function interceptFileDialogs(page: Page): void {
  if (dialogs.has(page)) return
  const seen: FileChooser[] = []
  dialogs.set(page, seen)
  page.on('filechooser', (c) => seen.push(c))
}

/** The file dialogs the page has opened since `interceptFileDialogs`, oldest first. */
export function fileDialogs(page: Page): FileChooser[] {
  const seen = dialogs.get(page)
  if (!seen) throw new Error('interceptFileDialogs(page) must run before the page loads')
  return seen
}

/** Runs `open` once and expects exactly one new file dialog from it within `timeout`, which it returns. */
export async function expectFileDialog(page: Page, open: () => Promise<unknown>, timeout = 60_000): Promise<FileChooser> {
  const seen = fileDialogs(page)
  const before = seen.length
  await open()
  await expect.poll(() => seen.length, { message: 'the file dialog opened once', timeout }).toBe(before + 1)
  return seen[before]!
}
