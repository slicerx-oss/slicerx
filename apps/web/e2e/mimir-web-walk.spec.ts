// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// mimir cloud in the browser build that only models, against a stubbed proxy: part chips and no printer plugins,
// the answer above a folded sources line, a reply even when the model ends silent, the conversation kept over a reload,
// and the save switch caption that reads its state. Shots at both widths go to the test output for review.
import { type Page, type Route } from '@playwright/test'
import { expect, test, viewportReady } from './fixtures'

type W = { __sx: { setState(p: unknown): void }; __sxMimirCloud(h: unknown, base: string): void; __sxBrowserMimirCloud(base: string, token: string | null): unknown }

const SESSION = 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJlMmUifQ.c2ln'

type Block = { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown }

/** One message as the Messages API streams it. */
function message(blocks: Block[]): string {
  const ev = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`
  const out = [ev('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [], stop_reason: null, usage: { input_tokens: 12, output_tokens: 1 } } })]
  blocks.forEach((b, index) => {
    if (b.type === 'text') {
      out.push(ev('content_block_start', { index, content_block: { type: 'text', text: '' } }), ev('content_block_delta', { index, delta: { type: 'text_delta', text: b.text } }))
    } else {
      out.push(ev('content_block_start', { index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } }), ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } }))
    }
    out.push(ev('content_block_stop', { index }))
  })
  const stop = blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn'
  out.push(ev('message_delta', { delta: { stop_reason: stop }, usage: { output_tokens: 9 } }), ev('message_stop', {}))
  return out.join('')
}

type Body = { messages: { role: string; content: unknown }[]; tool_choice?: { type: string }; system?: { text: string }[]; tools?: { name: string }[] }
const lastUserText = (b: Body): string => {
  const m = b.messages.at(-1)
  if (!m || m.role !== 'user') return ''
  return typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
}

/**
 * The proxy. "layer height" looks the answer up in the knowledge base, then answers naming the guide; "silent" ends
 * with nothing at all until it is asked for a reply with no tools; anything else gets a short answer.
 */
async function stubProxy(page: Page) {
  const bodies: Body[] = []
  await page.route('**/functions/v1/mimir/**', async (route: Route) => {
    const req = route.request()
    const at = new URL(req.url()).pathname.split('/mimir')[1] ?? ''
    if (at === '/quota') return route.fulfill({ json: { edition: 'slicerx-web', day: '2026-10-14', install_used: 0, install_cap: 250000, ip_used: 0, ip_cap: 1000000, edition_open: true } })
    if (at !== '/v1/messages') return route.fulfill({ status: 404, json: { type: 'error', error: { type: 'not_found_error', message: 'No such mimir route.' } } })
    const body = req.postDataJSON() as Body
    bodies.push(body)
    const sse = (blocks: Block[]) => route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: message(blocks) })
    const asked = lastUserText(body)
    if (body.tool_choice?.type === 'none') return sse([{ type: 'text', text: 'I could not build it in one go. Which wall should the ports go in?' }])
    if (asked.includes('tool_result')) return sse([{ type: 'text', text: 'Use 0.2 mm for a strong bracket, per the layer height guide in the knowledge base.' }])
    if (asked.includes('layer height')) return sse([{ type: 'tool_use', id: 'tu_1', name: 'kb__search', input: { query: 'layer height strength' } }])
    if (asked.includes('silent')) return sse([])
    return sse([{ type: 'text', text: 'A 20 mm cube, coming up.' }])
  })
  return bodies
}

async function open(page: Page, prefs: Record<string, unknown> = {}): Promise<void> {
  await page.addInitScript((prefs) => {
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.debug', '1')
    localStorage.setItem('slicerx.e2e.cadOnly', '1')
    localStorage.setItem('sx-mimir-dock', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'advanced', pilot: { mode: 'on', provider: 'mimir-cloud' }, mimirNotice: 2, ...prefs }))
  }, prefs)
  await page.goto('./')
  await viewportReady(page)
  await signIn(page)
}

/** The build's own browser cloud host, signed in, pointed at the stub. Again after each reload. */
async function signIn(page: Page): Promise<void> {
  await page.evaluate((token) => {
    const w = window as unknown as W
    const base = `${location.origin}/functions/v1/mimir`
    w.__sxMimirCloud(w.__sxBrowserMimirCloud(base, token), base)
  }, SESSION)
}

const ask = async (page: Page, text: string) => {
  const box = page.locator('.mimir-dock').getByRole('textbox', { name: /^Ask / })
  await box.fill(text)
  await box.press('Enter')
}

test.describe('mimir in the browser build that only models', () => {
  test('offers parts, answers above a folded sources line, and never ends silent', async ({ page }, info) => {
    const bodies = await stubProxy(page)
    await open(page)
    const dock = page.locator('.mimir-dock')
    // part chips, none about printers
    await expect(dock.getByRole('button', { name: 'Design a part' })).toBeVisible()
    await expect(dock.getByRole('button', { name: 'Check on a print' })).toHaveCount(0)
    await expect(dock.getByRole('textbox', { name: /^Ask / })).toHaveAttribute('placeholder', /Describe a part/)
    await dock.screenshot({ path: info.outputPath(`web-dock-empty-${info.project.name}.png`) })

    await ask(page, 'What layer height for a strong bracket?')
    await expect(dock).toContainText('Use 0.2 mm for a strong bracket', { timeout: 30_000 })
    // no plugins block, and the prompt is about parts in the browser
    await expect(dock.getByText('Plugins', { exact: true })).toHaveCount(0)
    expect(bodies[0]?.system?.map((s) => s.text).join(' ')).toMatch(/in the browser, where people design parts/)
    expect(bodies[0]?.tools?.some((t) => t.name.startsWith('printer'))).toBe(false)
    // sources fold to one line under the answer, which stays in view
    const head = dock.getByRole('button', { name: /^Sources \(\d\)$/ })
    await expect(head).toBeVisible()
    await expect(head).toHaveAttribute('aria-expanded', 'false')
    await expect(dock.getByText('Use 0.2 mm for a strong bracket')).toBeInViewport()
    await dock.screenshot({ path: info.outputPath(`web-dock-answer-${info.project.name}.png`) })

    // a model that ends with nothing is asked once more, with no tools, and its reply shows
    await ask(page, 'Pi case, stay silent')
    await expect(dock).toContainText('Which wall should the ports go in?', { timeout: 30_000 })
    expect(bodies.at(-1)?.tool_choice?.type).toBe('none')

    // a reload keeps the conversation
    await page.reload()
    await viewportReady(page)
    await signIn(page)
    await expect(dock).toContainText('Use 0.2 mm for a strong bracket')
    await expect(dock).toContainText('Which wall should the ports go in?')
    await dock.screenshot({ path: info.outputPath(`web-dock-reloaded-${info.project.name}.png`) })
    // and the next message carries it as context
    await ask(page, 'a 20 mm cube')
    await expect(dock).toContainText('A 20 mm cube, coming up.', { timeout: 30_000 })
    expect(JSON.stringify(bodies.at(-1)?.messages)).toContain('What layer height for a strong bracket?')
    // New conversation forgets it
    await dock.getByRole('button', { name: 'New conversation' }).click()
    await page.reload()
    await viewportReady(page)
    await expect(dock).not.toContainText('A 20 mm cube, coming up.')
  })

  test('the save switch caption reads its state', async ({ page }, info) => {
    test.skip(info.project.name === 'phone', 'the phone Settings tab row belongs to the phone layout work')
    await stubProxy(page)
    await open(page)
    await page.evaluate(() => (window as unknown as W).__sx.setState({ settingsOpen: true, settingsSection: 'pilot' }))
    const settings = page.getByRole('dialog', { name: 'Settings' })
    const sw = settings.getByTestId('mimir-share')
    const caption = settings.getByTestId('mimir-share-caption')
    await expect(sw).toHaveAttribute('aria-checked', 'true')
    await expect(caption.locator('[data-on]')).toHaveText(/^On: free mimir chats are saved for 30 days/)
    const before = await settings.getByTestId('danger-mimir-forget').boundingBox()
    await sw.click()
    await expect(caption.locator('[data-on]')).toHaveText(/^Off: nothing new is saved/)
    // the row keeps its height, so nothing under it moves
    expect(await settings.getByTestId('danger-mimir-forget').boundingBox()).toEqual(before)
    await page.locator('.pc-cloud-share').first().screenshot({ path: info.outputPath('web-save-switch-off.png') })
  })
})
