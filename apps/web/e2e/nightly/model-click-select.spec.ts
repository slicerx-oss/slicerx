// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The edge answer comes from a worker, and a click can land while it is still out. Real edge answers are held until the
// pointer has stopped inside the face, then released with no further move: the face must light under the resting pointer.
// It holds worker replies, so it times the app against the machine and runs in the nightly, on a page of its own.
import type { Page } from '@playwright/test'
import { bounds, openStudio } from '../cad-helpers'
import { expect, test } from '../fixtures'
import { bedToScreen, framedBox, nearFrontEdge } from '../journeys/lib/model'

/** Holds real edge answers until the pointer has stopped, in every browser engine. */
async function holdEdgeAnswers(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker
    let holding = false
    const pending: (() => void)[] = []
    window.Worker = class extends NativeWorker {
      private readonly edges = new Set<number>()
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options)
        this.addEventListener('message', (event: MessageEvent<{ id?: number }>) => {
          if (event.data?.id === undefined || !this.edges.delete(event.data.id) || !holding) return
          event.stopImmediatePropagation()
          pending.push(() => this.dispatchEvent(new MessageEvent('message', { data: event.data })))
        })
      }
      override postMessage(message: unknown, options: Transferable[] | StructuredSerializeOptions = []): void {
        const request = message as { id?: number; op?: string } | null
        if (request?.op === 'edge.pick' && typeof request.id === 'number') this.edges.add(request.id)
        if (Array.isArray(options)) super.postMessage(message, options)
        else super.postMessage(message, options)
      }
    }
    Object.assign(window, {
      __edgeAnswers: {
        hold: () => { holding = true },
        pending: () => pending.length,
        release: () => {
          holding = false
          for (const deliver of pending.splice(0)) deliver()
        },
      },
    })
  })
}

const edgeAnswers = (page: Page, action: 'hold' | 'pending' | 'release') => page.evaluate((action) =>
  (window as unknown as { __edgeAnswers: { hold(): void; pending(): number; release(): void } }).__edgeAnswers[action](), action)

test.describe('Model click to select, nightly', () => {
  test.skip(({ isMobile }) => isMobile, 'Needs a pointer')

  test('after a delayed edge answer, the face lights under the resting pointer', { tag: '@nightly' }, async ({ page }) => {
    test.slow()
    await holdEdgeAnswers(page)
    await openStudio(page)
    const id = await framedBox(page)
    const b = await bounds(page, id)
    const hover = () =>
      page.evaluate(() => {
        const vp = (window as unknown as { __vp: { edgeMarks: { lines: { hover: unknown[] } }; faceKey: string } }).__vp
        return { edge: vp.edgeMarks.lines.hover.length > 0, face: vp.faceKey !== '' }
      })
    try {
      for (let i = 0; i < 4; i++) {
        const near = await nearFrontEdge(page, b, 3)
        const [ix, iy] = await bedToScreen(page, [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, b.max[2]])
        await page.mouse.move(near.x, near.y - 30)
        await page.mouse.move(near.x, near.y, { steps: 3 })
        await expect.poll(hover).toEqual({ edge: true, face: false })
        // Keep the real answer pending while the pointer moves inside, then release it without another move.
        await edgeAnswers(page, 'hold')
        await page.mouse.move(ix, iy)
        await expect.poll(() => edgeAnswers(page, 'pending')).toBeGreaterThan(0)
        expect(await hover()).toEqual({ edge: true, face: false })
        await edgeAnswers(page, 'release')
        await expect.poll(hover, { timeout: 10_000 }).toEqual({ edge: false, face: true })
      }
    } finally {
      await edgeAnswers(page, 'release')
    }
  })
})
