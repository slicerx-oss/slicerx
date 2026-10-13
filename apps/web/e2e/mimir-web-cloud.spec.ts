// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// mimir cloud in the browser build, against a stubbed proxy: signed in, the page sends the member's session token as
// authorization and mimir's answer streams into the dock; signed out, nothing reaches the proxy. The real proxy's session check and CORS rules are tested in supabase/functions/mimir.
import { type Page, type Route } from '@playwright/test'
import { expect, test, viewportReady } from './fixtures'

type W = { __sxMimirCloud(h: unknown, base: string): void; __sxBrowserMimirCloud(base: string, token: string | null): unknown }

// a stand-in session token: the stub checks only that it arrives
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

/** The proxy, on the page's own origin: what reached it. It answers only calls that carry the session. */
async function stubProxy(page: Page) {
  const seen: { route: string; auth: string | null; install: string | null }[] = []
  await page.route('**/functions/v1/mimir/**', async (route: Route) => {
    const req = route.request()
    const path = new URL(req.url()).pathname
    const at = path.slice(path.indexOf('/mimir') + '/mimir'.length)
    seen.push({ route: at, auth: (await req.headerValue('authorization')) ?? null, install: (await req.headerValue('x-sx-install')) ?? null })
    if ((await req.headerValue('authorization')) !== `Bearer ${SESSION}`) return route.fulfill({ status: 401, json: { type: 'error', error: { type: 'authentication_error', message: 'Sign in to use mimir.', reason: 'sign_in' } } })
    if (at === '/quota') return route.fulfill({ json: { edition: 'slicerx-web', day: '2026-10-13', install_used: 0, install_cap: 250000, ip_used: 0, ip_cap: 1000000, edition_open: true } })
    if (at === '/v1/messages') return route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: answer('A 20 mm cube, coming up.') })
    return route.fulfill({ status: 404, json: { type: 'error', error: { type: 'not_found_error', message: 'No such mimir route.' } } })
  })
  return seen
}

/** Opens the app with the build's own browser host pointed at the stub: signed in with `token`, or signed out. */
async function open(page: Page, token: string | null, pilot: unknown = { mode: 'unset' }): Promise<void> {
  await page.addInitScript((pilot) => {
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.debug', '1')
    localStorage.setItem('sx-mimir-dock', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'advanced', pilot }))
  }, pilot)
  await page.goto('./')
  await viewportReady(page)
  await page.evaluate((token) => {
    const w = window as unknown as W
    const base = `${location.origin}/functions/v1/mimir`
    w.__sxMimirCloud(w.__sxBrowserMimirCloud(base, token), base)
  }, token)
}

test.describe('mimir cloud in the browser', () => {
  test.skip(({ isMobile }) => isMobile, 'Desktop only: the dock and Settings layout under test')

  test('signed in, the answer streams with the session token and no install token', async ({ page }) => {
    const seen = await stubProxy(page)
    await open(page, SESSION, { mode: 'on', provider: 'mimir-cloud' })
    // the dock is open; hand the question over as Cmd+K does with free text
    await page.evaluate(() => (window as unknown as { __sx: { setState(p: unknown): void } }).__sx.setState({ pilotPrompt: 'a 20 mm cube' }))
    // the cloud notice comes first, once
    await page.getByTestId('mimir-notice-ok').click()
    await expect(page.locator('.mimir-dock')).toContainText('A 20 mm cube, coming up.', { timeout: 30_000 })
    expect(seen.filter((s) => s.route === '/v1/messages').length).toBeGreaterThan(0)
    expect(seen.every((s) => s.auth === `Bearer ${SESSION}` && s.install === null)).toBe(true)
    expect(seen.some((s) => s.route === '/register')).toBe(false)
  })

  test('signed out, the free card asks for sign-in and nothing reaches the proxy', async ({ page }) => {
    const seen = await stubProxy(page)
    await open(page, null)
    await page.evaluate(() => (window as unknown as { __sx: { setState(p: unknown): void } }).__sx.setState({ settingsOpen: true, settingsSection: 'pilot' }))
    await page.getByRole('dialog', { name: 'Settings' }).getByTestId('ms-choice-cloud').click()
    await expect(page.getByRole('dialog', { name: 'Settings' }).getByTestId('ms-cloud-signin')).toBeVisible()
    expect(seen).toHaveLength(0)
  })
})
