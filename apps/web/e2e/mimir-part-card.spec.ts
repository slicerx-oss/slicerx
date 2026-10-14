// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A reply that makes a part, against a stubbed mimir proxy: the real text_to_part call puts a cube on the plate, the
// reply shows it as a card read from the tool's result, and the next steps under the question send their request as
// typed. The starters show only while the thread is empty. SX_SHOTS=1 saves each card look for review.
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

type Body = { messages: { role: string; content: unknown }[] }
const lastUser = (b: Body): string => {
  const m = b.messages.at(-1)
  if (!m || m.role !== 'user') return ''
  return typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
}

/** The proxy: "cube" builds one with text_to_part and asks what next; anything else is acknowledged. */
async function stubProxy(page: Page) {
  const asked: string[] = []
  await page.route('**/functions/v1/mimir/**', async (route: Route) => {
    const at = new URL(route.request().url()).pathname.split('/mimir')[1] ?? ''
    if (at === '/quota') return route.fulfill({ json: { edition: 'slicerx-web', day: '2026-10-14', install_used: 0, install_cap: 250000, ip_used: 0, ip_cap: 1000000, edition_open: true } })
    if (at !== '/v1/messages') return route.fulfill({ status: 404, json: { type: 'error', error: { type: 'not_found_error', message: 'No such mimir route.' } } })
    const body = route.request().postDataJSON() as Body
    const text = lastUser(body)
    const sse = (blocks: Block[]) => route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: message(blocks) })
    if (text.includes('tool_result')) return sse([{ type: 'text', text: 'Want rounded edges, or a hole through it?' }])
    asked.push(text)
    if (text.includes('20 mm cube'))
      return sse([
        { type: 'text', text: 'A 20 mm cube is easy. I put one on the grid at the origin, 20 by 20 by 20 mm.' },
        { type: 'tool_use', id: 'tu_1', name: 'text_to_part', input: { name: '20 mm cube', solids: [{ type: 'box', sizeMm: [20, 20, 20] }] } },
      ])
    return sse([{ type: 'text', text: 'On it.' }])
  })
  return asked
}

async function open(page: Page): Promise<void> {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.debug', '1')
    localStorage.setItem('sx-mimir-dock', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'advanced', pilot: { mode: 'on', provider: 'mimir-cloud' }, mimirNotice: 2 }))
  })
  await page.goto('./')
  await viewportReady(page)
  await signIn(page)
}

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

/** The looks the owner picks from: the card (A to D) and where the next steps go (R under the reply, P in the prompt row). */
const LOOKS = {
  A: { icon: 'left', actions: 'edit', lines: 2, chips: 'reply' },
  B: { icon: 'left', actions: 'edit-select', lines: 2, chips: 'reply' },
  C: { icon: 'top', actions: 'edit', lines: 2, chips: 'reply' },
  D: { icon: 'left', actions: 'edit', lines: 1, chips: 'reply' },
  P: { icon: 'left', actions: 'edit', lines: 2, chips: 'prompt' },
} as const

/** Each look, in dark and light at this project's width. */
async function shots(page: Page, project: string): Promise<void> {
  if (!process.env['SX_SHOTS']) return
  const dir = process.env['SX_SHOTS_DIR'] ?? test.info().outputPath('shots')
  const schemes = project === 'phone' ? (['dark', 'light'] as const) : (['dark'] as const)
  const width = project === 'phone' ? 390 : 1440
  for (const [id, look] of Object.entries(LOOKS)) {
    await page.evaluate((l) => {
      localStorage.setItem('sx.mock.partLook', JSON.stringify(l))
      window.dispatchEvent(new Event('sx-mock-part-look'))
    }, look)
    for (const scheme of schemes) {
      // the hardware acceleration toast over the chat is its own fix (P3); it is cleared so the card shows
      await page.evaluate((s) => (window as unknown as W).__sx.setState({ scheme: s, themeFollowsSystem: false, toast: null }), scheme)
      await page.mouse.move(0, 0)
      await page.waitForTimeout(400)
      await page.evaluate(() => (window as unknown as W).__sx.setState({ toast: null }))
      await expect(page.getByTestId('toast')).toHaveCount(0)
      await page.screenshot({ path: `${dir}/part-${id}-${scheme}-${width}.png` })
      if (project !== 'phone') await page.locator('.mimir-dock').screenshot({ path: `${dir}/part-${id}-${scheme}-${width}-dock.png` })
    }
  }
}

test.describe('a reply that makes a part', () => {
  test('shows the part as a card, and its next steps send their request', async ({ page }, info) => {
    const asked = await stubProxy(page)
    await open(page)
    const dock = page.locator('.mimir-dock')
    const starters = dock.getByRole('group', { name: 'Suggestions' })
    await expect(starters).toBeVisible()

    await ask(page, 'a 20 mm cube')
    const card = dock.getByTestId('mimir-part')
    await expect(card).toBeVisible({ timeout: 30_000 })
    await expect(card).toContainText('Cube created')
    await expect(card).toContainText('Cube 20 x 20 x 20 mm')
    await expect(dock).toContainText('Want rounded edges, or a hole through it?')
    // the card reads the part the call put on the plate
    const id = await card.getAttribute('data-part')
    expect(id).toBe('20-mm-cube')
    // the starters are gone once the thread has a turn
    await expect(starters).toHaveCount(0)
    const next = dock.getByRole('group', { name: 'Next steps' })
    await expect(next.getByRole('button')).toHaveText(['Fillet edges', 'Center hole', 'Change size'])

    await shots(page, info.project.name)
    await page.evaluate(() => {
      localStorage.removeItem('sx.mock.partLook')
      window.dispatchEvent(new Event('sx-mock-part-look'))
    })
    // a reload brings the card back from the saved conversation
    await page.reload()
    await viewportReady(page)
    await expect(card).toContainText('Cube created')
    await signIn(page)

    await dock.getByRole('group', { name: 'Next steps' }).getByRole('button', { name: 'Fillet edges' }).click()
    await expect(dock).toContainText('On it.', { timeout: 30_000 })
    expect(asked.at(-1)).toMatch(/User request:\s*Fillet the edges of the cube by 2 mm$/)
    // the chip's request shows as the person's message
    await expect(dock.locator('.turn-user').last()).toContainText('Fillet the edges of the cube by 2 mm')
  })
})
