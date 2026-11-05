// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The 3D mouse in the browser, end to end with a stand-in device (lib/space-mouse.ts): Settings, Controls, Connect asks
// for the device and turns the setting on, the device's reports move the view while the cap is pushed and stop when it
// is let go, its second button fits the view, and turning the setting off lets the device go.
import { journey, expect } from '../journey'
import { closeDialogs } from './lib/session'
import { viewportReady } from '../fixtures'
import { fakeHid, getState, hidOpened, openSection, sectionShots, send, setState, translation } from './lib/space-mouse'

type Cam = { target: number[]; azimuthDeg: number; elevationDeg: number; distanceMm: number }
const camera = (page: import('@playwright/test').Page) => page.evaluate(() => (window as unknown as { __vp: { getCamera(): Cam } }).__vp.getCamera())

/** The camera once it has stopped: two reads 200 ms apart agree (a fit eases in over half a second). */
async function settled(page: import('@playwright/test').Page): Promise<Cam> {
  let last = await camera(page)
  await expect
    .poll(async () => {
      await page.waitForTimeout(200)
      const now = await camera(page)
      const same = JSON.stringify(now) === JSON.stringify(last)
      last = now
      return same
    }, { timeout: 10_000 })
    .toBe(true)
  return last
}

/**
 * The camera once the view has stopped moving: ten drawn frames in a row leave it where it was. Counted in frames, not
 * time, since a busy test machine can go a few hundred milliseconds between frames while the view still glides.
 */
async function stoppedByFrames(page: import('@playwright/test').Page): Promise<Cam> {
  return page.evaluate(async () => {
    const vp = (window as unknown as { __vp: { getCamera(): Cam } }).__vp
    const frames = (n: number) =>
      new Promise<void>((done) => {
        let i = 0
        const step = () => (++i >= n ? done() : requestAnimationFrame(step))
        requestAnimationFrame(step)
      })
    for (let k = 0; k < 100; k++) {
      const was = JSON.stringify(vp.getCamera())
      await frames(10)
      if (JSON.stringify(vp.getCamera()) === was) return vp.getCamera()
    }
    throw new Error('the view kept moving after the cap was let go')
  })
}

journey('Connect turns the 3D mouse on, its reports move the view, its button fits it, and a later load finds it', async ({ page }, info) => {
  await fakeHid(page)
  const section = await openSection(page)
  const status = page.getByTestId('space-mouse-status')
  await expect(status).toHaveText('Off. Connect asks the browser for the device once.')
  await sectionShots(page, info, 'space-mouse-1440-off')
  const connect = page.getByTestId('space-mouse-connect')
  const toggle = section.getByRole('switch', { name: /Use a 3D mouse/ })
  const at = { toggle: (await toggle.boundingBox())!, status: (await status.boundingBox())! }
  await connect.click()
  await expect(status).toHaveText('Connected: SpaceMouse Compact.')
  await expect(section.getByRole('switch', { name: /Use a 3D mouse/ })).toBeChecked()
  // the switch and the status line stayed where they were; the new rows came in below
  expect((await toggle.boundingBox())!).toEqual(at.toggle)
  expect((await status.boundingBox())!.y).toBe(at.status.y)
  await expect(section.getByLabel('Sensitivity')).toBeVisible()
  await expect(section.getByRole('switch', { name: 'Invert zoom' })).not.toBeChecked()
  await sectionShots(page, info, 'space-mouse-1440-on')
  expect(((await getState(page)) as { spaceMouse: { enabled: boolean } }).spaceMouse.enabled).toBe(true)

  await closeDialogs(page)
  const before = await settled(page)
  // the cap pushed right for a moment: the view pans and keeps its angle and distance
  for (let i = 0; i < 12; i++) {
    await send(page, 1, translation(300))
    await page.waitForTimeout(40)
  }
  await send(page, 1, translation(0))
  await expect.poll(async () => Math.hypot(...(await camera(page)).target.map((v, i) => v - before.target[i]!)), { timeout: 5_000 }).toBeGreaterThan(5)
  const moved = await camera(page)
  expect(moved.azimuthDeg).toBeCloseTo(before.azimuthDeg, 3)
  expect(moved.distanceMm).toBeCloseTo(before.distanceMm, 1)
  // let go: it glides to a stop (space-drive.test.ts times the glide) and stays still
  const stopped = await stoppedByFrames(page)
  await page.waitForTimeout(300)
  expect((await camera(page)).target).toEqual(stopped.target)

  // the second button fits the view
  await setState(page, { camera: 'top' })
  await send(page, 3, [2])
  await send(page, 3, [0])
  await expect.poll(async () => ((await getState(page)) as { camera: string }).camera).toBe('fit')

  // a later load with the setting saved on finds the remembered device with no Connect
  await page.reload()
  await viewportReady(page)
  await expect.poll(() => hidOpened(page)).toBe(true)
  await openSection(page)
  await expect(status).toHaveText('Connected: SpaceMouse Compact.')

  // off: the device is let go, reports do nothing, and the status says so
  await section.getByRole('switch', { name: /Use a 3D mouse/ }).click()
  await expect(status).toHaveText('Off. Connect asks the browser for the device once.')
  expect(await hidOpened(page)).toBe(false)
  await closeDialogs(page)
  const off = await settled(page)
  for (let i = 0; i < 6; i++) await send(page, 1, translation(300))
  await page.waitForTimeout(300)
  expect((await camera(page)).target).toEqual(off.target)
  await setState(page, { spaceMouse: { enabled: false, sensitivity: 1, invert: { panX: false, panY: false, zoom: false, tilt: false, spin: false }, dominantAxis: false } })
})
