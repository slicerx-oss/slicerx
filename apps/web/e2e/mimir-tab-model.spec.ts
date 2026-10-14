// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The mimir tab on a model: with mimir cloud set up (a stubbed proxy on the page's origin), a message goes to the model
// with the design prompt and the design tools, the reply streams into the tab's chat, and the scripted tag is gone.
// With no model set up, the tab says it plays scripted replies. Screenshots in both themes go to the test output.
import { type Page, type Route } from '@playwright/test'
import { expect, test, viewportReady } from './fixtures'

type W = { __sxMimirCloud(h: unknown, base: string): void; __sxBrowserMimirCloud(base: string, token: string | null): unknown }

const SESSION = 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJlMmUifQ.c2ln'

/** One short answer, as the Messages API streams it. */
function answer(text: string): string {
  const ev = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`
  return [
    ev('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [], stop_reason: null, usage: { input_tokens: 12, output_tokens: 1 } } }),
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
    ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text } }),
    ev('content_block_stop', { index: 0 }),
    ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } }),
    ev('message_stop', {}),
  ].join('')
}

/** The proxy: records each model request's body and answers with one line. */
async function stubProxy(page: Page) {
  const bodies: { model: string; system: unknown; tools?: { name: string }[] }[] = []
  await page.route('**/functions/v1/mimir/**', async (route: Route) => {
    const req = route.request()
    const path = new URL(req.url()).pathname
    const at = path.slice(path.indexOf('/mimir') + '/mimir'.length)
    if (at === '/quota') return route.fulfill({ json: { edition: 'slicerx-web', day: '2026-10-15', install_used: 0, install_cap: 250000, ip_used: 0, ip_cap: 1000000, edition_open: true } })
    if (at === '/v1/messages') {
      bodies.push(JSON.parse(req.postData() ?? '{}'))
      return route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: answer('I will sketch the base and extrude it 20 mm.') })
    }
    return route.fulfill({ status: 404, json: { type: 'error', error: { type: 'not_found_error', message: 'No such mimir route.' } } })
  })
  return bodies
}

async function open(page: Page, scheme: 'dark' | 'light', pilot: unknown, cloud: boolean): Promise<void> {
  await page.addInitScript(
    ([scheme, pilot]) => {
      if (sessionStorage.getItem('sx-e2e')) return
      sessionStorage.setItem('sx-e2e', '1')
      localStorage.setItem('slicerx.debug', '1')
      localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'advanced', pilot, scheme, themeFollowsSystem: false }))
    },
    [scheme, pilot] as const,
  )
  await page.goto('./')
  await viewportReady(page)
  if (cloud)
    await page.evaluate((token) => {
      const w = window as unknown as W
      const base = `${location.origin}/functions/v1/mimir`
      w.__sxMimirCloud(w.__sxBrowserMimirCloud(base, token), base)
    }, SESSION)
  await page.evaluate(() => (window as unknown as { __sx: { setState(p: unknown): void } }).__sx.setState({ plate: [], selection: null, selectedIds: [] }))
  await page.getByTestId('tab-mimir').click()
  await expect(page.getByTestId('mimir-chat')).toBeVisible()
}

async function send(page: Page, text: string): Promise<void> {
  const composer = page.getByTestId('mimir-composer')
  await composer.getByRole('textbox').fill(text)
  await composer.getByRole('button', { name: 'Send' }).click()
}

test.describe('the mimir tab on a model', () => {
  test.skip(({ isMobile }) => isMobile, 'Desktop only: phones have no modeling tabs')

  test('with no model set up, the tab says it plays scripted replies', async ({ page }) => {
    await open(page, 'dark', { mode: 'off' }, false)
    await expect(page.locator('.mimir-chat-scripted')).toHaveText('Scripted replies')
  })

  for (const scheme of ['dark', 'light'] as const) {
    test(`on mimir cloud, a message goes to the model with the design tools and the reply lands in the tab (${scheme})`, async ({ page }) => {
      const bodies = await stubProxy(page)
      await open(page, scheme, { mode: 'on', provider: 'mimir-cloud' }, true)
      // the cloud notice comes first, once
      await page.getByTestId('mimir-notice-ok').click()
      await expect(page.locator('.mimir-chat-scripted')).toHaveCount(0)
      await send(page, 'A 40 x 30 mm plate, 20 mm tall')
      await expect(page.getByTestId('mimir-transcript')).toContainText('I will sketch the base and extrude it 20 mm.', { timeout: 30_000 })
      expect(bodies.length).toBeGreaterThan(0)
      const first = bodies[0]!
      expect(first.model).toBe('claude-haiku-5-5')
      expect(JSON.stringify(first.system)).toContain('one feature at a time')
      const tools = (first.tools ?? []).map((t) => t.name)
      expect(tools.some((n) => /^geom(__|\.)extrude$/.test(n))).toBe(true)
      expect(tools.some((n) => /^design(__|\.)new$/.test(n))).toBe(true)
      expect(tools.some((n) => /text_to_part|make_model/.test(n))).toBe(false)
      await expect(page.locator('.mimir-chat-scripted')).toHaveCount(0)
      for (const [w, h] of [[1440, 900], [390, 844]] as const) {
        await page.setViewportSize({ width: w, height: h })
        await page.screenshot({ path: test.info().outputPath(`tab-model-${w}-${scheme}.png`) })
      }
    })
  }
})
