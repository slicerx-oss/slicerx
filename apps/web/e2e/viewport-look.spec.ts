// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The 3D view's look follows the theme: Dark precision on the dark theme, Light studio on the light one, switching with
// the scheme and no reload. Read back from the view itself (the slicerx.debug handle), so it checks what is drawn with.
import type { Page } from '@playwright/test'
import { openStudio } from './cad-helpers'
import { expect, test, viewportReady } from './fixtures'

type Look = { backdrop: { top: string | null; vignetteOnModels: boolean }; plate: { borderGlow: number; border: string | null }; lighting: { environment: number } }
const look = (page: Page) => page.evaluate(() => (window as unknown as { __vp: { look(): Look } }).__vp.look())
const setScheme = (page: Page, scheme: 'dark' | 'light') =>
  page.evaluate((s) => (window as unknown as { __sx: { setState(p: unknown): void } }).__sx.setState({ scheme: s, themeFollowsSystem: false }), scheme)

test('the 3D view takes the dark or light studio look with the theme', async ({ page }) => {
  await openStudio(page, { scheme: 'dark', themeFollowsSystem: false })
  await viewportReady(page)
  const dark = await look(page)
  expect(dark.backdrop).toMatchObject({ top: '#2a2e3a', vignetteOnModels: false })
  expect(dark.plate.border).toBeNull()
  expect(dark.plate.borderGlow).toBeLessThan(1)
  expect(dark.lighting.environment).toBeLessThan(1)

  await setScheme(page, 'light')
  await expect.poll(async () => (await look(page)).backdrop.top).toBe('#e3e6ea')
  expect((await look(page)).plate.borderGlow).toBe(dark.plate.borderGlow)

  await setScheme(page, 'dark')
  await expect.poll(async () => (await look(page)).backdrop.top).toBe('#2a2e3a')
})
