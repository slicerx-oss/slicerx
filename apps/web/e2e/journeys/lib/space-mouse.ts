// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A stand-in 3D mouse for the browser tests: WebHID as the app reads it, with one device that the picker hands over
// and that sends the reports a test asks for (the device's public report layout). The real navigator.hid is never
// asked, so no picker opens. Nothing changes until a test connects the device.
import { expect, type Page, type TestInfo } from '@playwright/test'
import { viewportReady } from '../../fixtures'
import { shotsDir, shotsOn } from './session'

type Sx = { getState(): Record<string, unknown>; setState(s: Record<string, unknown>): void }

/** Puts the stand-in in place before the app loads, then reloads so the app finds it. */
export async function fakeHid(page: Page): Promise<void> {
  await page.context().addInitScript(() => {
    class Device extends EventTarget {
      opened = false
      vendorId = 0x256f
      productId = 0xc635
      productName = 'SpaceMouse Compact'
      collections = [{ usagePage: 0x01, usage: 0x08 }]
      async open() {
        this.opened = true
      }
      async close() {
        this.opened = false
      }
    }
    const device = new Device()
    // the browser remembers a granted device across loads, as WebHID's getDevices does
    const hid = Object.assign(new EventTarget(), {
      getDevices: async () => (sessionStorage.getItem('sx-hid-granted') ? [device] : []),
      requestDevice: async () => {
        sessionStorage.setItem('sx-hid-granted', '1')
        return [device]
      },
    })
    ;(window as unknown as { __hidOpened(): boolean }).__hidOpened = () => device.opened
    Object.defineProperty(Navigator.prototype, 'hid', { configurable: true, get: () => hid })
    ;(window as unknown as { __hidSend(id: number, bytes: number[]): void }).__hidSend = (id, bytes) => {
      const e = Object.assign(new Event('inputreport'), { reportId: id, device, data: new DataView(Uint8Array.from(bytes).buffer) })
      device.dispatchEvent(e)
    }
  })
  await page.reload()
  await viewportReady(page)
}

/** Whether the app holds the stand-in device open. */
export const hidOpened = (page: Page) => page.evaluate(() => (window as unknown as { __hidOpened(): boolean }).__hidOpened())

/** Sends one report: its id and bytes. */
export const send = (page: Page, id: number, bytes: number[]) => page.evaluate(({ id, bytes }) => (window as unknown as { __hidSend(id: number, b: number[]): void }).__hidSend(id, bytes), { id, bytes })

/** A translation report: x, y and z as signed 16-bit counts. */
export const translation = (x: number, y = 0, z = 0): number[] => [x, y, z].flatMap((v) => [v & 0xff, (v >> 8) & 0xff])

export const setState = (page: Page, s: Record<string, unknown>) => page.evaluate((s) => (window as unknown as { __sx: Sx }).__sx.setState(s), s)
export const getState = (page: Page) => page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState())

/** Settings, Controls, scrolled to the 3D mouse section. */
export async function openSection(page: Page) {
  await setState(page, { settingsOpen: true, settingsSection: 'controls' })
  const section = page.getByTestId('space-mouse-settings')
  await section.scrollIntoViewIfNeeded()
  await expect(section).toBeVisible()
  return section
}

/** The section in both schemes, only with SX_SHOTS=1. */
export async function sectionShots(page: Page, info: TestInfo, name: string): Promise<void> {
  if (!shotsOn()) return
  const section = page.getByTestId('space-mouse-settings')
  for (const scheme of ['dark', 'light'] as const) {
    await setState(page, { scheme, themeFollowsSystem: false })
    await page.waitForTimeout(150)
    await section.scrollIntoViewIfNeeded()
    await page.screenshot({ path: `${shotsDir(info)}/${name}-${scheme}.png` })
  }
  await setState(page, { scheme: 'dark' })
}
