// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Files on a message in the docked chat, against a stubbed mimir proxy: a picture and a PDF drawing attach from the
// button, show as chips, and go out in the request as an image block and a document block with the text. A big
// picture is scaled down to 1568 px before it is sent, and a file that isn't a picture or a PDF is left out with a
// plain note. SX_SHOTS=1 saves the chips at this project's width in dark and light.
import { type Page, type Route } from '@playwright/test'
import { expect, test, viewportReady } from './fixtures'

type W = { __sx: { setState(p: unknown): void }; __sxMimirCloud(h: unknown, base: string): void; __sxBrowserMimirCloud(base: string, token: string | null): unknown }

const SESSION = 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJlMmUifQ.c2ln'
// a 1 by 1 PNG and a one page PDF
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF')

function reply(text: string): string {
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

type Block = { type: string; text?: string; title?: string; source?: { type: string; media_type: string; data: string } }
type Body = { messages: { role: string; content: string | Block[] }[] }

/** The proxy: every request is kept, and each answers with one line. */
async function stubProxy(page: Page): Promise<Body[]> {
  const bodies: Body[] = []
  await page.route('**/functions/v1/mimir/**', async (route: Route) => {
    const at = new URL(route.request().url()).pathname.split('/mimir')[1] ?? ''
    if (at === '/quota') return route.fulfill({ json: { edition: 'slicerx-web', day: '2026-10-14', install_used: 0, install_cap: 250000, ip_used: 0, ip_cap: 1000000, edition_open: true } })
    if (at !== '/v1/messages') return route.fulfill({ status: 404, json: { type: 'error', error: { type: 'not_found_error', message: 'No such mimir route.' } } })
    bodies.push(route.request().postDataJSON() as Body)
    return route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: reply('I can see the sketch and the drawing.') })
  })
  return bodies
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
  await page.evaluate((token) => {
    const w = window as unknown as W
    const base = `${location.origin}/functions/v1/mimir`
    w.__sxMimirCloud(w.__sxBrowserMimirCloud(base, token), base)
  }, SESSION)
}

const lastUser = (b: Body): Block[] => {
  const m = [...b.messages].reverse().find((x) => x.role === 'user')
  return !m ? [] : typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content
}

const shotsDir = () => process.env['SX_SHOTS_DIR'] ?? test.info().outputPath('shots')

async function shots(page: Page, project: string): Promise<void> {
  if (!process.env['SX_SHOTS']) return
  await page.addStyleTag({ content: '.sx-pilot .plugs { display: none !important; }' })
  const width = project === 'phone' ? 390 : 1440
  for (const s of ['dark', 'light'] as const) {
    await page.evaluate((v) => (window as unknown as W).__sx.setState({ scheme: v, themeFollowsSystem: false, toast: null }), s)
    await page.mouse.move(0, 0)
    await page.waitForTimeout(400)
    await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a instanceof CSSTransition).map((a) => a.finished.catch(() => undefined))))
    await page.screenshot({ path: `${shotsDir()}/attach-${s}-${width}.png` })
    if (project !== 'phone') await page.locator('.mimir-dock').screenshot({ path: `${shotsDir()}/attach-${s}-${width}-dock.png` })
  }
  await page.evaluate(() => (window as unknown as W).__sx.setState({ scheme: 'dark', themeFollowsSystem: false }))
}

test.describe('files on a message in the docked chat', () => {
  test('a picture and a PDF go to the model with the text', async ({ page }, info) => {
    const bodies = await stubProxy(page)
    await open(page)
    const dock = page.locator('.mimir-dock')
    await expect(dock.getByTestId('mimir-attach')).toBeVisible()
    await dock.getByTestId('mimir-attach-input').setInputFiles([
      { name: 'sketch.png', mimeType: 'image/png', buffer: PNG },
      { name: 'bracket.pdf', mimeType: 'application/pdf', buffer: PDF },
    ])
    const chips = dock.getByTestId('mimir-attachment')
    await expect(chips).toHaveCount(2)
    await expect(chips.nth(1)).toContainText('bracket.pdf')
    const box = dock.getByRole('textbox', { name: /^Ask / })
    await box.fill('Make a bracket that fits this.')
    await shots(page, info.project.name)
    await box.press('Enter')
    await expect(dock.getByText('I can see the sketch and the drawing.')).toBeVisible({ timeout: 30_000 })
    // the row is empty again, and the files show on the sent message
    await expect(dock.locator('.term-in').getByTestId('mimir-attachment')).toHaveCount(0)
    await expect(dock.locator('.term-out').getByTestId('mimir-attachment')).toHaveCount(2)

    const blocks = lastUser(bodies[0]!)
    expect(blocks).toContainEqual({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: PDF.toString('base64') }, title: 'bracket.pdf' })
    expect(blocks).toContainEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') } })
    const text = blocks.find((b) => b.type === 'text')?.text ?? ''
    expect(text).toContain('Make a bracket that fits this.')
    expect(text).toContain('Attached: sketch.png (picture), bracket.pdf (PDF)')
  })

  test('a big picture is scaled down to 1568 px before it is sent', async ({ page }) => {
    const bodies = await stubProxy(page)
    await open(page)
    const big = await page.evaluate(async () => {
      const c = document.createElement('canvas')
      c.width = 3000
      c.height = 2000
      const g = c.getContext('2d')!
      g.fillStyle = '#3a6'
      g.fillRect(0, 0, 3000, 2000)
      g.fillStyle = '#fff'
      g.fillRect(400, 400, 1200, 800)
      const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/png'))
      return Array.from(new Uint8Array(await blob.arrayBuffer()))
    })
    const dock = page.locator('.mimir-dock')
    await dock.getByTestId('mimir-attach-input').setInputFiles([{ name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from(big) }])
    await expect(dock.getByTestId('mimir-attachment')).toHaveCount(1)
    await dock.getByRole('textbox', { name: /^Ask / }).press('Enter')
    await expect.poll(() => bodies.length, { timeout: 30_000 }).toBeGreaterThan(0)
    const img = lastUser(bodies[0]!).find((b) => b.type === 'image')!
    expect(img.source!.media_type).toBe('image/jpeg')
    const size = await page.evaluate(async (data) => {
      const bmp = await createImageBitmap(await (await fetch(`data:image/jpeg;base64,${data}`)).blob())
      return [bmp.width, bmp.height]
    }, img.source!.data)
    expect(size).toEqual([1568, 1045])
  })

  test('a file that is not a picture or a PDF is left out with a note', async ({ page }) => {
    await stubProxy(page)
    await open(page)
    const dock = page.locator('.mimir-dock')
    await dock.getByTestId('mimir-attach-input').setInputFiles([{ name: 'part.stl', mimeType: 'model/stl', buffer: Buffer.from('solid x') }])
    await expect(dock.getByRole('status').filter({ hasText: "part.stl isn't an image or a PDF" })).toBeVisible()
    await expect(dock.getByTestId('mimir-attachment')).toHaveCount(0)
  })
})
