// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A reply that makes a part, against a stubbed mimir proxy: the real text_to_part call puts a cube on the plate, the
// reply shows it as a card read from the tool's result, Edit opens the part's editor, and the next steps under each
// reply act on that reply's part: a step under an older reply targets the older part, and a step for a deleted part
// says so instead of acting. The starters show only while the thread is empty. SX_SHOTS=1 saves shots for review.
import { type Page, type Route } from '@playwright/test'
import { expect, test, viewportReady } from './fixtures'

type W = { __sx: { setState(p: unknown): void; getState(): { plate: { id: string }[]; selection: string | null } }; __sxMimirCloud(h: unknown, base: string): void; __sxBrowserMimirCloud(base: string, token: string | null): unknown }

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
    for (const n of [20, 10])
      if (text.includes(`a ${n} mm cube`))
        return sse([
          { type: 'text', text: `Created a ${n} mm cube at the origin.` },
          { type: 'tool_use', id: `tu_${n}`, name: 'text_to_part', input: { name: `${n} mm cube`, solids: [{ type: 'box', sizeMm: [n, n, n] }] } },
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

const shotsDir = () => process.env['SX_SHOTS_DIR'] ?? test.info().outputPath('shots')

/** Sets the scheme with the hardware acceleration toast cleared; that toast over the chat is its own fix. */
async function scheme(page: Page, s: 'dark' | 'light'): Promise<void> {
  await page.evaluate((v) => (window as unknown as W).__sx.setState({ scheme: v, themeFollowsSystem: false, toast: null }), s)
  await page.mouse.move(0, 0)
  await page.waitForTimeout(400)
  // a loaded machine can still be mid color change; wait for the transitions to land
  await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a instanceof CSSTransition).map((a) => a.finished.catch(() => undefined))))
  await page.evaluate(() => (window as unknown as W).__sx.setState({ toast: null }))
  await expect(page.getByTestId('toast')).toHaveCount(0)
}

/** The card in dark and light at this project's width; the plugin lines at the top of a reply are their own fix (P1). */
async function shots(page: Page, project: string, name: string): Promise<void> {
  if (!process.env['SX_SHOTS']) return
  await page.addStyleTag({ content: '.sx-pilot .plugs { display: none !important; }' })
  const width = project === 'phone' ? 390 : 1440
  for (const s of ['dark', 'light'] as const) {
    await scheme(page, s)
    await page.screenshot({ path: `${shotsDir()}/${name}-${s}-${width}.png` })
    if (project !== 'phone') await page.locator('.mimir-dock').screenshot({ path: `${shotsDir()}/${name}-${s}-${width}-dock.png` })
  }
  await scheme(page, 'dark')
}

const plateIds = (page: Page) => page.evaluate(() => (window as unknown as W).__sx.getState().plate.map((e) => e.id))

test.describe('a reply that makes a part', () => {
  test('shows the part as a card, and its next steps send their request', async ({ page }, info) => {
    const asked = await stubProxy(page)
    await open(page)
    const dock = page.locator('.mimir-dock')
    await expect(dock.getByRole('textbox', { name: 'Ask mimir' })).toHaveAttribute('placeholder', 'Ask mimir')
    const starters = dock.getByRole('group', { name: 'Suggestions' })
    await expect(starters).toBeVisible()

    await ask(page, 'a 20 mm cube')
    const card = dock.getByTestId('mimir-part')
    await expect(card).toBeVisible({ timeout: 30_000 })
    await expect(card).toContainText('Cube created')
    await expect(card).toContainText('Cube 20 x 20 x 20 mm')
    await expect(dock).toContainText('Created a 20 mm cube at the origin.')
    await expect(dock).toContainText('Want rounded edges, or a hole through it?')
    // the card reads the part the call put on the plate, and the permission line gives way to it
    expect(await card.getAttribute('data-part')).toBe('20-mm-cube')
    await expect(dock).not.toContainText('set to Allow in Permissions')
    // the starters are gone once the thread has a turn
    await expect(starters).toHaveCount(0)
    const next = dock.getByRole('group', { name: 'Next steps' })
    await expect(next.getByRole('button')).toHaveText(['Fillet edges, 2 mm', 'Center hole, 5 mm', 'Change size'])
    await shots(page, info.project.name, 'part')

    // Change size asks for the size first; nothing is sent until Resize
    await next.getByRole('button', { name: 'Change size' }).click()
    const sizing = dock.getByRole('group', { name: 'Change size' })
    await expect(sizing).toBeVisible()
    const before = asked.length
    await sizing.getByRole('textbox', { name: /X/ }).fill('30')
    await sizing.getByRole('textbox', { name: /X/ }).press('Enter')
    expect(asked.length).toBe(before)
    await shots(page, info.project.name, 'part-size')
    await sizing.getByRole('button', { name: 'Resize' }).click()
    await expect(dock).toContainText('On it.', { timeout: 30_000 })
    expect(asked.at(-1)).toMatch(/User request:\s*Change the size of the 20 mm cube to 30 x 20 x 20 mm$/)

    await next.first().getByRole('button', { name: 'Fillet edges, 2 mm' }).click()
    await expect.poll(() => asked.at(-1)).toMatch(/User request:\s*Fillet the edges of the 20 mm cube by 2 mm$/)
    // the chip's request shows as the person's message
    await expect(dock.locator('.turn-user').last()).toContainText('Fillet the edges of the 20 mm cube by 2 mm')

    // a reload brings the card back from the saved conversation
    await page.reload()
    await viewportReady(page)
    await expect(card).toContainText('Cube created')
  })

  test('Edit opens the part for editing, and the card body selects it', async ({ page, isMobile }) => {
    await stubProxy(page)
    await open(page)
    await ask(page, 'a 20 mm cube')
    const card = page.locator('.mimir-dock').getByTestId('mimir-part')
    await expect(card).toBeVisible({ timeout: 30_000 })
    await page.evaluate(() => (window as unknown as W).__sx.setState({ selection: null, selectedIds: [] }))
    await card.getByRole('button', { name: 'Select the 20 mm cube' }).click()
    await expect.poll(() => page.evaluate(() => (window as unknown as W).__sx.getState().selection)).toBe('20-mm-cube')
    // a phone has no modeling tools, so its card has no Edit
    if (isMobile) return expect(card.getByRole('button', { name: 'Edit the 20 mm cube' })).toHaveCount(0)
    await card.getByRole('button', { name: 'Edit the 20 mm cube' }).click()
    const transform = page.getByRole('dialog', { name: 'Transform' })
    await expect(transform).toBeVisible()
    await expect(transform.getByRole('group', { name: /Size/ })).toBeVisible()
    await shots(page, test.info().project.name, 'part-edit')
  })

  test('a step under an older reply acts on that reply\'s part, and a deleted part says so', async ({ page }) => {
    const asked = await stubProxy(page)
    await open(page)
    const dock = page.locator('.mimir-dock')
    await ask(page, 'a 20 mm cube')
    await expect(dock.getByTestId('mimir-part')).toHaveCount(1, { timeout: 30_000 })
    await expect(dock.getByRole('group', { name: 'Next steps' })).toHaveCount(1)
    await ask(page, 'a 10 mm cube')
    await expect(dock.getByTestId('mimir-part')).toHaveCount(2, { timeout: 30_000 })
    const groups = dock.getByRole('group', { name: 'Next steps' })
    await expect(groups).toHaveCount(2)
    expect(await plateIds(page)).toEqual(expect.arrayContaining(['20-mm-cube', '10-mm-cube']))

    // the newer cube is selected; the older reply's step still targets the older cube
    await groups.first().getByRole('button', { name: 'Center hole, 5 mm' }).click()
    await expect.poll(() => asked.at(-1)).toMatch(/User request:\s*Add a 5 mm hole through the center of the 20 mm cube$/)
    await expect.poll(() => page.evaluate(() => (window as unknown as W).__sx.getState().selection)).toBe('20-mm-cube')
    await expect(dock).toContainText('On it.', { timeout: 30_000 })

    // delete the older cube: its step explains instead of acting on the selection
    await page.evaluate(() => {
      const sx = (window as unknown as W).__sx
      sx.setState({ plate: sx.getState().plate.filter((e) => e.id !== '20-mm-cube'), selection: '10-mm-cube', selectedIds: ['10-mm-cube'] })
    })
    const sent = asked.length
    await groups.first().getByRole('button', { name: 'Fillet edges, 2 mm' }).click()
    await expect(groups.first().locator('..').getByRole('status')).toHaveText('The 20 mm cube is no longer in the project, so this step has nothing to change.')
    expect(asked.length).toBe(sent)
    expect(await page.evaluate(() => (window as unknown as W).__sx.getState().selection)).toBe('10-mm-cube')
  })
})
