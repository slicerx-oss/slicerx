// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Helpers the session journeys share (boot-session, mimir, vault and phone-session): the mimir cloud proxy stub the
// three mimir specs each carried a copy of, the first-run flows that run at desktop and phone widths, and the
// small checks that were repeated per spec.
import { type Page, type Route, type TestInfo } from '@playwright/test'
import { expect, goTab, plateReady, sliceCount, sliced, viewportReady } from '../../fixtures'

export type Sx = { setState(p: unknown): void; getState(): Record<string, unknown> }
type W = { __sx: Sx; __sxMimirCloud(h: unknown, base: string): void; __sxBrowserMimirCloud(base: string, token: string | null): unknown }

/** A printer by hand, so a spec starts past first-run setup with a printer (the shell journey starts the same way). */
export const A1_MINI = { id: 'e2e-a1-mini', name: 'Desk A1 mini', profileId: 'bambu-a1-mini', vendor: 'Bambu Lab', model: 'A1 mini', nozzleCount: 1 }

export async function noHorizontalScroll(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
}

/** Screenshots are for review only: SX_SHOTS=1 saves them to SX_SHOTS_DIR (the test's output folder by default). */
export const shotsOn = (): boolean => Boolean(process.env['SX_SHOTS'])
export const shotsDir = (info: TestInfo): string => process.env['SX_SHOTS_DIR'] ?? info.outputPath('shots')

/** Reaches the store as `__sx`. journey.ts sets the debug flag before every load, so the hook is there; a page that lost it reloads once. */
export async function debugOn(page: Page): Promise<void> {
  if (await page.evaluate(() => Boolean((window as unknown as Partial<W>).__sx))) return
  await page.evaluate(() => localStorage.setItem('slicerx.debug', '1'))
  // the 3D view only comes up on a tab that has one, and the app opens on the tab it was left on
  await goTab(page, 'prepare')
  await page.reload()
  await viewportReady(page)
}

export const setState = (page: Page, patch: Record<string, unknown>): Promise<void> => page.evaluate((p) => (window as unknown as W).__sx.setState(p), patch)

/* ------------------------------------------------------------------ mimir proxy stub */

/** The token the stub accepts: a stand-in session, checked only for being there. */
export const SESSION = 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJlMmUifQ.c2ln'

export type Block = { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown }
export type ContentBlock = { type: string; text?: string; title?: string; source?: { type: string; media_type: string; data: string } }
export interface ProxyBody {
  messages: { role: string; content: string | ContentBlock[] }[]
  tool_choice?: { type: string }
  system?: { text: string }[]
  tools?: { name: string }[]
}
/** A canned answer as a Messages API stream, or a refusal with a status and a body. */
export type ProxyReply = Block[] | { status: number; json: unknown }

const sseEvent = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`

/** One message as the Messages API streams it. */
export function message(blocks: Block[]): string {
  const out = [sseEvent('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [], stop_reason: null, usage: { input_tokens: 12, output_tokens: 1 } } })]
  blocks.forEach((b, index) => {
    if (b.type === 'text') {
      out.push(sseEvent('content_block_start', { index, content_block: { type: 'text', text: '' } }), sseEvent('content_block_delta', { index, delta: { type: 'text_delta', text: b.text } }))
    } else {
      out.push(sseEvent('content_block_start', { index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } }), sseEvent('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } }))
    }
    out.push(sseEvent('content_block_stop', { index }))
  })
  const stop = blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn'
  out.push(sseEvent('message_delta', { delta: { stop_reason: stop }, usage: { output_tokens: 9 } }), sseEvent('message_stop', {}))
  return out.join('')
}

/** A reply of one line of text. */
export const answer = (text: string): Block[] => [{ type: 'text', text }]

/** What the person last sent, as text (tool results come back as JSON text). */
export function lastUserText(b: ProxyBody): string {
  const m = b.messages.at(-1)
  if (!m || m.role !== 'user') return ''
  return typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
}

/** The blocks of the last user message, a plain string being one text block. */
export function lastUserBlocks(b: ProxyBody): ContentBlock[] {
  const m = [...b.messages].reverse().find((x) => x.role === 'user')
  return !m ? [] : typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content
}

export const QUOTA_OPEN = { edition: 'slicerx-web', day: '2026-10-14', install_used: 0, install_cap: 250000, ip_used: 0, ip_cap: 1000000, edition_open: true }

interface Proxy {
  handler: (body: ProxyBody) => ProxyReply | Promise<ProxyReply>
  quota: unknown
  bodies: ProxyBody[]
}
const proxies = new WeakMap<Page, Proxy>()

/**
 * The mimir proxy on the page's own origin, for a page that lives across tests: the route goes in once and each call
 * swaps the handler, so routes do not pile up. Every message request is kept in the returned array (a new one per
 * call), the quota answers `opts.quota`, and any other path is a 404.
 */
export async function stubProxy(page: Page, handler: Proxy['handler'], opts: { quota?: unknown } = {}): Promise<ProxyBody[]> {
  let p = proxies.get(page)
  if (!p) {
    const state: Proxy = { handler: () => answer('...'), quota: QUOTA_OPEN, bodies: [] }
    p = state
    proxies.set(page, state)
    await page.route('**/functions/v1/mimir/**', async (route: Route) => {
      const at = new URL(route.request().url()).pathname.split('/mimir')[1] ?? ''
      if (at === '/quota') return route.fulfill({ json: state.quota })
      if (at !== '/v1/messages') return route.fulfill({ status: 404, json: { type: 'error', error: { type: 'not_found_error', code: 'not_found', message: 'No such mimir route.' } } })
      const body = route.request().postDataJSON() as ProxyBody
      state.bodies.push(body)
      const reply = await state.handler(body)
      if (!Array.isArray(reply)) return route.fulfill({ status: reply.status, json: reply.json })
      return route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: message(reply) })
    })
  }
  p.handler = handler
  p.quota = opts.quota ?? QUOTA_OPEN
  p.bodies = []
  return p.bodies
}

/** The build's own browser cloud host, signed in with the stand-in session and pointed at the stub. */
export async function signIn(page: Page): Promise<void> {
  await page.evaluate((token) => {
    const w = window as unknown as W
    const base = `${location.origin}/functions/v1/mimir`
    w.__sxMimirCloud(w.__sxBrowserMimirCloud(base, token), base)
  }, SESSION)
}

/** A stand-in cloud shell with no proxy behind it: the quota, and a forget that counts its calls and deleted three chats. */
export async function standIn(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as W & { __forgets?: number }
    w.__forgets = 0
    const quota = { edition: 'slicerx', day: '2026-10-12', installUsed: 0, installCap: 500000, ipUsed: 0, ipCap: 2000000, editionOpen: true }
    w.__sxMimirCloud({ quota: async () => quota, forget: async () => ((w.__forgets = (w.__forgets ?? 0) + 1), 3), register: async () => undefined }, 'http://127.0.0.1:9/functions/v1/mimir')
  })
}

/** off: turned off. cloud: mimir cloud. unset: not connected yet. scripted: a provider with no key, so the tab plays its scripts. */
export type PilotMode = 'off' | 'cloud' | 'unset' | 'scripted'

/** Puts mimir in the state a test starts from: the connection, the one-time notice (read, or not yet) and the save switch on. */
export async function setPilot(page: Page, mode: PilotMode, opts: { notice?: boolean } = {}): Promise<void> {
  const pilot = mode === 'off' ? { mode: 'off' } : mode === 'cloud' ? { mode: 'on', provider: 'mimir-cloud' } : mode === 'scripted' ? { mode: 'on', provider: 'anthropic' } : { mode: 'unset' }
  await page.evaluate(([pilot, noticeRead]) => (window as unknown as W).__sx.setState({ pilot, mimirNotice: noticeRead ? 2 : null, mimirShare: true }), [pilot, opts.notice ?? true] as const)
}

/** Puts away whatever dialog an earlier test left open. */
export async function closeDialogs(page: Page): Promise<void> {
  for (let i = 0; i < 3 && (await page.getByRole('dialog').first().isVisible()); i++) await page.keyboard.press('Escape')
}

/** The mimir tab, empty: the plate cleared, a new conversation, and the camera looking down on the grid. */
export async function emptyMimirTab(page: Page): Promise<void> {
  await closeDialogs(page)
  // the "hardware acceleration" notice can lie over the chat's controls; it is its own fix. Clearing the store's toast
  // leaves the card to run out its own reading time (about 7.5 s for that notice, once a worker), so the notice is
  // closed by its close mark instead.
  await setState(page, { toast: null })
  await expect(async () => {
    for (const mark of await page.getByTestId('toast-close').all()) await mark.click({ timeout: 1_000 })
    await expect(page.getByTestId('toast')).toHaveCount(0, { timeout: 1_000 })
  }).toPass({ timeout: 15_000 })
  // from another tab, so the tab turns the camera to the top view as it opens; the whole turn again if a refit of the
  // old plate landed after it
  await expect(async () => {
    await goTab(page, 'prepare')
    await setState(page, { plate: [], selection: null, selectedIds: [] })
    await expect.poll(() => page.evaluate(() => (window as unknown as { __vp: { objects: Map<string, unknown> } }).__vp.objects.size)).toBe(0)
    await page.getByTestId('tab-mimir').click()
    await expect(page.getByTestId('mimir-chat')).toBeVisible()
    await expect.poll(() => page.evaluate(() => {
      const p = (window as unknown as { __vp: { camera: { position: { x: number; y: number; z: number } } } }).__vp.camera.position
      return Math.abs(p.y) / Math.hypot(p.x, p.y, p.z)
    }), { timeout: 5_000 }).toBeGreaterThan(0.95)
  }).toPass({ timeout: 45_000 })
  const again = page.getByTestId('mimir-chat').getByRole('button', { name: 'New conversation' })
  if (await again.isVisible()) await again.click()
}

/** Types into the mimir tab's composer and sends. */
export async function askTab(page: Page, text: string): Promise<void> {
  const composer = page.getByTestId('mimir-composer')
  await composer.getByRole('textbox').fill(text)
  await composer.getByRole('button', { name: 'Send' }).click()
}

/* ------------------------------------------------------------------ the app, up (desktop and phone) */

/** Slice runs and shows the layers in place, with the legend shut to its chip; a phone picks the color from Cmd+K. */
export async function sliceAndColorBy(page: Page, phone: boolean): Promise<void> {
  await goTab(page, 'prepare')
  await plateReady(page)
  const before = await sliceCount(page)
  // Slice plate, or Slice again when an earlier test left a current slice
  await page.getByTestId('slice-estimate-slice').first().click()
  await expect(sliced(page, before)).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole('group', { name: 'Layers and moves' })).toBeVisible()
  if (phone) {
    // A phone keeps the view clear: the legend is its chip, and the color choice is in Cmd+K as well.
    await expect(page.getByTestId('legend-color-by')).toBeVisible()
    await expect(page.getByRole('list', { name: 'Toolpath legend' })).toBeHidden()
    await page.keyboard.press('ControlOrMeta+k')
    await page.keyboard.type('Color toolpaths by Layer time')
    await page.locator('.sx-palette-item', { hasText: 'Color toolpaths by Layer time' }).click()
    await expect(page.getByTestId('legend-color-by')).toContainText('Layer time')
    return
  }
  await page.getByTestId('legend-color-by').click()
  await page.getByRole('menuitem', { name: 'Layer time' }).click()
  await expect(page.getByRole('button', { name: 'Color by Layer time' })).toBeVisible()
}

/** Printers shows the demo fleet, groups it by bay, and opens a printer's live view from the keyboard. */
export async function printersFleet(page: Page): Promise<void> {
  await goTab(page, 'printers')
  // an earlier run of this test may have left a printer's live view open
  const back = page.getByRole('button', { name: 'Back to all printers' })
  if (await back.isVisible()) await back.click()
  await expect(page.getByRole('heading', { name: 'Printers', exact: true })).toBeVisible()
  await expect(page.locator('.pcard')).toHaveCount(6)
  await expect(page.getByRole('list', { name: 'Printers by state' }).getByRole('listitem')).toHaveCount(5)
  await noHorizontalScroll(page)
  // By bay puts printers with no bay under Unassigned; All printers is one grid again.
  await page.getByRole('radio', { name: 'By bay' }).click()
  await expect(page.getByRole('heading', { name: 'Unassigned' })).toBeVisible()
  await noHorizontalScroll(page)
  await page.getByRole('radio', { name: 'All printers' }).click()
  await expect(page.getByRole('heading', { name: 'Unassigned' })).toHaveCount(0)
  // The whole tile is one button: Enter on it opens the printer's live view.
  await page.locator('.pcard .wall-open').first().focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('region', { name: / live view$/ })).toBeVisible()
  await page.getByRole('button', { name: 'Back to all printers' }).click()
  await expect(page.locator('.pcard')).toHaveCount(6)
}

/** The Vault shows a featured design and rows, opens creators, and switches between Feed and Saved. */
export async function vaultFeed(page: Page): Promise<void> {
  await goTab(page, 'feed')
  await expect(page.locator('.lib-hero h2')).toBeVisible()
  await expect(page.locator('.lib-hero').getByRole('button', { name: /^Open in / })).toBeVisible()
  await expect.poll(() => page.locator('.lib-row').count()).toBeGreaterThanOrEqual(3)
  // Search shows the grid, and a nonsense word empties it.
  await page.getByLabel('Search models', { exact: true }).fill('zzzzqx')
  await expect(page.getByText('No models match')).toBeVisible()
  await page.getByLabel('Search models', { exact: true }).fill('')
  await expect(page.locator('.lib-hero')).toBeVisible()
  // See all opens the full sorted grid; the back button returns to the rows.
  await page.getByRole('region', { name: 'Most popular' }).getByRole('button', { name: 'See all' }).click()
  await expect.poll(() => page.locator('.lib-grid-cards .lib-mini').count()).toBeGreaterThan(2)
  await page.locator('.lib-grid-h').getByRole('button', { name: 'Vault' }).click()
  // The uploader opens the creator sheet, with About and Uploads tabs; Escape closes it.
  await page.locator('.lib-hero .lib-who').click()
  const sheet = page.getByRole('dialog', { name: /creator page$/ })
  await expect(sheet.getByRole('tab', { name: 'About' })).toBeVisible()
  await sheet.getByRole('tab', { name: /Uploads/ }).click()
  await expect.poll(() => sheet.locator('.cs-thumb').count()).toBeGreaterThan(0)
  await page.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)
  await noHorizontalScroll(page)
  // The Vault switch is Feed | Saved; My models has no tab of its own here.
  await expect(page.locator('.sx-tab', { hasText: 'My models' })).toHaveCount(0)
  const vault = page.getByRole('radiogroup', { name: 'Vault' })
  await expect(vault.getByRole('radio')).toHaveText(['Feed', 'Saved'])
  await vault.getByRole('radio', { name: 'Saved' }).click()
  await expect(page.getByRole('heading', { name: /^Saved/ })).toBeVisible()
  await vault.getByRole('radio', { name: 'Feed' }).click()
  await noHorizontalScroll(page)
}

/** Settings opens with Account and Phone access. A phone opens it on its list of sections, one section at a time. */
export async function settingsAccount(page: Page): Promise<void> {
  await goTab(page, 'prepare')
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await expect(dialog).toBeVisible()
  const list = dialog.getByTestId('settings-list')
  if (await list.isVisible()) await list.getByRole('button', { name: 'Account' }).click()
  await expect(dialog.getByRole('heading', { name: 'Account' })).toBeVisible()
  if (await dialog.getByTestId('settings-back').isVisible()) await dialog.getByTestId('settings-back').click()
  await dialog.getByRole('button', { name: 'Phone access' }).click()
  const sw = dialog.getByRole('switch', { name: /Phone access on this network/ })
  await expect(sw).toHaveAttribute('aria-checked', 'false')
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
}

/* ------------------------------------------------------------------ first run */

/** Steps in setup: the theme, the printer, the slicer you use now, what the plate tab opens in, and mimir. A phone has no modeling, so it skips "Opens in". */
export const setupSteps = (phone: boolean): number => (phone ? 4 : 5)

/** A fresh install: nothing stored, so setup opens by itself on the theme. Leaves it on the printer step. */
export async function freshSetup(page: Page, phone = false): Promise<void> {
  await page.goto('./')
  await expect(page.getByRole('heading', { name: 'Pick a theme' })).toBeVisible()
  await expect(page.locator('#fr-step-label')).toHaveText(`Step 1 of ${setupSteps(phone)}`)
  await page.locator('.fr-foot').getByRole('button', { name: 'Next' }).click()
  await expect(page.getByRole('heading', { name: 'Find your printer' })).toBeVisible()
  await expect(page.locator('#fr-step-label')).toHaveText(`Step 2 of ${setupSteps(phone)}`)
}

/**
 * Setup from a fresh install: Escape asks before leaving, adding a printer by hand names a failed test's step and
 * cause and goes on without it, and leaving setup from the slicer screen is undone from Settings (Cmd+K). Ends with
 * setup open again on the slicer screen.
 */
export async function escapeAndHandAdd(page: Page, phone: boolean): Promise<void> {
  await freshSetup(page, phone)
  await page.keyboard.press('Escape')
  const dialog = page.getByRole('dialog', { name: 'Leave setup?' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('You can finish it later from Settings.')
  await dialog.getByRole('button', { name: 'Stay' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.locator('#fr-step-label')).toHaveText(`Step 2 of ${setupSteps(phone)}`)

  await page.getByRole('button', { name: 'Not listed? Add it by hand' }).click()
  await expect(page.getByRole('heading', { name: 'Add your printer' })).toBeVisible()
  await page.getByRole('textbox', { name: 'Search brand or model' }).fill('voron 2.4')
  await page.locator('.fr-hits .fr-hit').first().click()
  await expect(page.getByRole('radio', { name: /Moonraker/ })).toHaveAttribute('aria-checked', 'true')
  await page.getByRole('textbox', { name: /IP address/ }).fill('192.0.2.77')
  await page.getByRole('button', { name: 'Test connection' }).first().click()
  await expect(page.locator('.fr-test-bad-h')).toContainText('No answer from 192.0.2.77.')
  await expect(page.locator('.fr-foot').getByRole('button', { name: 'Test again' })).toBeVisible()
  await page.getByRole('button', { name: 'Continue without testing' }).click()
  await expect(page.getByRole('heading', { name: 'Which slicer do you use now?' })).toBeVisible()

  await page.keyboard.press('Escape')
  await page.getByRole('dialog', { name: 'Leave setup?' }).getByRole('button', { name: 'Leave' }).click()
  await expect(page.locator('.fr')).toHaveCount(0)
  await page.keyboard.press('ControlOrMeta+k')
  await page.keyboard.type('change look and feel')
  await page.keyboard.press('Enter')
  await expect(page.locator('#fr-step-label')).toHaveText(`Step 3 of ${setupSteps(phone)}`)
}

/** With setup closed and no model connected, mimir offers the connect step, a question waits in it, and Settings holds the rest. */
export async function mimirConnectSteps(page: Page, phone: boolean): Promise<void> {
  // a phone opens the mimir tab from its tab bar, a desktop from the top bar's button; before a model is connected the
  // chat is the setup
  await page.locator(phone ? '[data-testid="phone-tabs"] [data-tab="mimir"]' : '.mimir-btn').click()
  const connect = page.getByTestId('mimir-connect')
  await expect(connect).toContainText('Nothing is sent until you connect')
  await expect(connect.getByRole('radiogroup', { name: 'Model provider' })).toBeVisible()
  await expect(page.getByTestId('mimir-composer').getByRole('button', { name: 'Send' })).toBeDisabled()
  // the first tab leaves it
  await page.locator(phone ? '.phone-tab >> nth=0' : '.sx-tab >> nth=1').click()
  await expect(page.getByTestId('mimir-chat')).toBeHidden()
  // A question offers mimir, and choosing it opens the tab with the question waiting.
  await page.keyboard.press('ControlOrMeta+k')
  await page.keyboard.type('why is my first layer rough')
  await page.locator('.sx-palette-item', { hasText: 'Ask mimir: why is my first layer rough' }).click()
  await expect(connect).toContainText('why is my first layer rough')
  await page.keyboard.press('ControlOrMeta+k')
  await page.keyboard.type('connect mimir')
  await page.locator('.sx-palette-item', { hasText: 'Connect mimir' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await expect(dialog.getByRole('heading', { name: 'mimir' })).toBeVisible()
  await expect(dialog.getByRole('radiogroup', { name: 'Model provider' })).toBeVisible()
}

/**
 * The theme step, then Settings > Look and feel on the same page. Every theme is a card, the mode and flavors apply at
 * once and stay after a reload; Settings carries the same choices and keeps the slicing ones on their own page.
 */
export async function themeAndLookAndFeel(page: Page): Promise<void> {
  await page.goto('./')
  await expect(page.getByRole('heading', { name: 'Pick a theme' })).toBeVisible()
  const cards = page.getByRole('radiogroup', { name: 'Theme' }).locator('.th-card')
  await expect(cards).toHaveCount(13)
  await expect(page.getByTestId('theme-subban')).toHaveAttribute('aria-checked', 'true')
  await expect(page.locator('html')).toHaveAttribute('data-sx-theme', 'subban-dark')
  await noHorizontalScroll(page)

  // Catppuccin: one card, the dark flavor picked inside it, Latte as its light mode.
  await page.getByTestId('theme-catppuccin').click()
  await expect(page.locator('html')).toHaveAttribute('data-sx-theme', 'catppuccin-mocha')
  await page.getByRole('button', { name: 'Catppuccin flavors' }).click()
  await page.getByRole('menuitemcheckbox', { name: 'Frappe' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-sx-theme', 'catppuccin-frappe')
  await page.getByRole('radiogroup', { name: 'Theme mode' }).getByRole('radio', { name: 'Light' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-sx-theme', 'catppuccin-latte')

  // Subban light is the Nocturne Bright palette.
  await page.getByTestId('theme-subban').click()
  await expect(page.locator('html')).toHaveAttribute('data-sx-theme', 'subban-light')
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ink-0').trim())).toBe('#f7f7f9')

  // The quick reading options apply at once.
  const easy = page.getByRole('region', { name: 'Easier to read' })
  await easy.getByRole('radio', { name: 'Larger' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-text-size', 'larger')
  await easy.getByRole('radio', { name: 'Red-green' }).click()
  await noHorizontalScroll(page)

  await page.getByRole('button', { name: 'Skip, use defaults' }).click()
  await expect(page.locator('.fr')).toHaveCount(0)
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-sx-theme', 'subban-light')
  await expect(page.locator('html')).toHaveAttribute('data-text-size', 'larger')
  const prefs = JSON.parse((await page.evaluate(() => localStorage.getItem('slicerx.prefs.v1'))) ?? '{}') as { themeIds: { dark: string; light: string }; appearance: { colorVision: string }; firstRun: { version: number } }
  expect(prefs.themeIds).toEqual({ dark: 'subban-dark', light: 'subban-light' })
  expect(prefs.appearance.colorVision).toBe('redgreen')
  expect(prefs.firstRun.version).toBe(4)

  // Settings, Look and feel: theme, accent, text and accessibility; Slicing and modeling holds auto slice.
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  const nav = dialog.getByRole('navigation', { name: 'Settings sections' })
  await nav.getByRole('button', { name: 'Look and feel' }).click()
  // the theme step left the light mode on; Nord is judged in its dark mode, as a fresh install has it
  await dialog.getByRole('radiogroup', { name: 'Theme mode' }).getByRole('radio', { name: 'Dark' }).click()
  await dialog.getByTestId('theme-nord').click()
  await expect(page.locator('html')).toHaveAttribute('data-sx-theme', 'nord')
  await dialog.getByRole('radiogroup', { name: 'Contrast' }).getByRole('radio', { name: 'Higher' }).click()
  await dialog.getByRole('radiogroup', { name: 'Color vision' }).getByRole('radio', { name: 'Blue-yellow' }).click()
  await dialog.getByRole('radiogroup', { name: 'Text size' }).getByRole('radio', { name: 'Large', exact: true }).click()
  await dialog.getByRole('radiogroup', { name: 'Font weight' }).getByRole('radio', { name: 'Medium' }).click()
  await dialog.getByRole('radiogroup', { name: 'Accent color' }).getByRole('radio', { name: 'Green' }).click()
  await dialog.getByRole('radiogroup', { name: 'Density' }).getByRole('radio', { name: 'Roomy' }).click()
  const root = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement)
    return { scale: cs.getPropertyValue('--text-scale').trim(), weight: cs.getPropertyValue('--fw-regular').trim(), accentIsGreen: cs.getPropertyValue('--accent').trim() === cs.getPropertyValue('--green').trim(), density: document.documentElement.dataset['density'], contrast: cs.getPropertyValue('--line').trim() }
  })
  expect(root).toMatchObject({ scale: '1.14', weight: '500', accentIsGreen: true, density: 'roomy' })
  // Higher contrast draws Nord's borders stronger than the file's #4c566a.
  expect(root.contrast).not.toBe('#4c566a')
  await expect(dialog.getByText('Body text at 16 px.', { exact: false })).toBeVisible()
  await noHorizontalScroll(page)
  // Auto slice, the electricity price and the drawing tools moved to their own page.
  await expect(dialog.getByRole('radiogroup', { name: 'Auto slice' })).toHaveCount(0)
  // a phone shows one section at a time: back to the list first
  if (await dialog.getByTestId('settings-back').isVisible()) await dialog.getByTestId('settings-back').click()
  await nav.getByRole('button', { name: 'Slicing and modeling' }).click()
  await expect(dialog.getByRole('radiogroup', { name: 'Auto slice' })).toBeVisible()
  await expect(dialog.getByText('Drawing tools')).toBeVisible()
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-sx-theme', 'nord')
}

/**
 * The CAD-only studio (SLICERX_WEB_SLICING=0, as slicerx.app/studio is built), opened on the test build: no printer, no
 * slicer question and no open step, then the plate on Model. The made-up demo printers never show.
 */
export async function cadOnlyStudio(page: Page, phone: boolean): Promise<void> {
  await page.addInitScript(() => localStorage.setItem('slicerx.e2e.cadOnly', '1'))
  await page.goto('./')
  await expect(page.getByRole('heading', { name: 'Pick a theme' })).toBeVisible()
  await expect(page.locator('#fr-step-label')).toHaveText('Step 1 of 2')
  await noHorizontalScroll(page)
  await page.locator('.fr-foot').getByRole('button', { name: 'Next' }).click()
  await expect(page.getByRole('heading', { name: 'Set up mimir' })).toBeVisible()
  await expect(page.locator('#fr-step-label')).toHaveText('Step 2 of 2')
  // A browser cannot download or run a model, and this build carries no mimir cloud host.
  const choices = page.getByRole('radiogroup', { name: 'How mimir gets a model' }).getByRole('radio')
  await expect(choices).toHaveText([/Use your own API key/, /Skip for now/])
  // Skip is one of the choices, so the footer has no Skip of its own
  await choices.first().click()
  await expect(page.getByTestId('setup-skip')).toHaveCount(0)
  await expect(page.locator('.pc-provider').first()).toHaveAttribute('aria-checked', 'true')
  await expect(page.locator('.pc-provider').first()).toContainText('Anthropic')
  await noHorizontalScroll(page)
  await page.locator('.fr-foot').getByRole('button', { name: 'Open the plate' }).click()
  await expect(page.locator('.fr')).toHaveCount(0)
  if (!phone) await expect(page.locator('.sx-tab[data-mode="slice"]')).toHaveCount(0)
  await expect(page.getByText(/demo network|192\.0\.2\./)).toHaveCount(0)
  await noHorizontalScroll(page)
}

/* ------------------------------------------------------------------ boot */

/**
 * The workspace's code never downloads: the page says so once, in the workspace, with no toast over it. The message
 * fills the window down to the gutter; a phone has no gutter, and the frame is the whole screen.
 */
export async function workspaceNeverDownloads(page: Page, phone: boolean): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'advanced', pilot: { mode: 'off' } }))
  })
  // Every fetch fails: the one reload does not help. A reset, not a lost network: a lost network would have the fixtures
  // reload the page too, and that reload races the app's own one.
  await page.route(/\/static\/studio-[^/]+\.js$/, (route) => route.abort('connectionreset'))
  await page.goto('./')
  await expect(page.getByRole('heading', { name: /did not load/ })).toBeVisible({ timeout: 60_000 })
  await expect(page.getByRole('button', { name: 'Reload' })).toBeVisible()
  // The toast waits a moment for the workspace, then stays away.
  await page.waitForTimeout(1_500)
  await expect(page.getByTestId('toast')).toHaveCount(0)
  const frame = (await page.locator('.sx-frame').boundingBox())!
  expect(Math.round(page.viewportSize()!.height - (frame.y + frame.height))).toBe(phone ? 0 : 16)
}

/** The visible icons still waiting for the full table, as "name (what holds it)". */
export async function blankIcons(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = []
    for (const svg of Array.from(document.querySelectorAll('svg[data-icon-pending]'))) {
      const r = svg.getBoundingClientRect()
      if (r.width < 1 || r.height < 1 || r.right < 0 || r.left > innerWidth || r.bottom < 0 || r.top > innerHeight) continue
      if (getComputedStyle(svg).visibility === 'hidden') continue
      const host = svg.closest('button, a, [role], li, label') ?? svg.parentElement
      const what = (host?.getAttribute('aria-label') ?? host?.textContent ?? '').trim().slice(0, 30)
      out.push(`${svg.getAttribute('data-icon-pending')} (${what})`)
    }
    return [...new Set(out)].sort()
  })
}

/** The shell loads only the startup icons; with the full table held back, the first frame has every icon on screen drawn. */
export async function iconsWithoutTable(page: Page, info: TestInfo): Promise<void> {
  // The full icon table never arrives in this test.
  await page.route(/\/icon-paths-[^/]*\.js$/, (route) => route.abort())
  await page.addInitScript(() => {
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', pilot: { mode: 'off' } }))
  })
  await page.goto('./')
  await expect(page.locator(':is(.sx-tab, .phone-tab)[aria-current=page]')).toBeVisible()
  await viewportReady(page)
  if (shotsOn()) await page.screenshot({ path: info.outputPath('prepare-first-frame.png') })
  expect(await blankIcons(page)).toEqual([])
  // The rail and the app bar are there and carry icons.
  expect(await page.locator('svg.sx-ic').count()).toBeGreaterThan(10)
}

/* ------------------------------------------------------------------ vault */

/** The first design row: how many cards fit whole, the cover size, and how far the cards reach across the row. */
export async function measureRow(page: Page) {
  return page.evaluate(() => {
    const rail = document.querySelector<HTMLElement>('.lib-rail[data-kind=designs]')
    if (!rail) throw new Error('no design row')
    const box = rail.getBoundingClientRect()
    const items = [...rail.querySelectorAll<HTMLElement>('.lib-rail-item')].map((el) => el.getBoundingClientRect())
    const thumb = rail.querySelector<HTMLElement>('.lib-thumb')?.getBoundingClientRect()
    const whole = items.filter((r) => r.left >= box.left - 1 && r.right <= box.right + 1).length
    const reach = Math.max(...items.map((r) => Math.min(r.right, box.right))) - box.left
    return { whole, count: items.length, coverW: thumb?.width ?? 0, coverH: thumb?.height ?? 0, rowW: box.width, reach, scrolls: rail.scrollWidth > rail.clientWidth + 1 }
  })
}

/** Opens the Vault on the page the journey shares and waits for its hero and first row. */
export async function openVault(page: Page): Promise<void> {
  await goTab(page, 'feed')
  await expect(page.locator('.lib-hero h2')).toBeVisible()
  await expect.poll(() => page.locator('#lib-popular-h').count()).toBe(1)
}

/**
 * The Vault's featured cover shows the whole drawing, centered. The demo catalog has no cover pictures, so this puts
 * one in the hero the way the app does (an img in .lib-hero-art), at the size the starters' covers are drawn (800 by
 * 600), and measures what is on screen.
 */
export async function expectHeroCoverFits(page: Page): Promise<void> {
  const r = await page.evaluate(async () => {
    const art = document.querySelector('.lib-hero-art') as HTMLElement
    const c = document.createElement('canvas')
    c.width = 800
    c.height = 600
    const g = c.getContext('2d')!
    g.fillStyle = '#bd93f9'
    g.fillRect(0, 0, 800, 600)
    const img = document.createElement('img')
    img.alt = ''
    img.src = c.toDataURL('image/png')
    await img.decode()
    art.replaceChildren(img)
    const a = art.getBoundingClientRect()
    const i = img.getBoundingClientRect()
    // What object-fit draws inside the img box: contain scales the whole picture in; cover fills the box and crops.
    const fit = getComputedStyle(img).objectFit
    const s = fit === 'cover' ? Math.max(i.width / 800, i.height / 600) : Math.min(i.width / 800, i.height / 600)
    const w = 800 * s
    const h = 600 * s
    const x = i.left + (i.width - w) / 2
    const y = i.top + (i.height - h) / 2
    return { art: { l: a.left, t: a.top, r: a.right, b: a.bottom }, drawn: { l: x, t: y, r: x + w, b: y + h }, box: { l: i.left, t: i.top, r: i.right, b: i.bottom }, fit }
  })
  // The whole picture is on screen: the drawn picture is inside the img box (nothing cropped), and the box inside the hero.
  for (const [inner, outer] of [[r.drawn, r.box], [r.box, r.art]] as const) {
    expect(inner.l).toBeGreaterThanOrEqual(outer.l - 0.5)
    expect(inner.t).toBeGreaterThanOrEqual(outer.t - 0.5)
    expect(inner.r).toBeLessThanOrEqual(outer.r + 0.5)
    expect(inner.b).toBeLessThanOrEqual(outer.b + 0.5)
  }
  // Centered both ways, and as large as the hero lets it be.
  expect(Math.abs((r.drawn.l + r.drawn.r) / 2 - (r.art.l + r.art.r) / 2)).toBeLessThan(1)
  expect(Math.abs((r.drawn.t + r.drawn.b) / 2 - (r.art.t + r.art.b) / 2)).toBeLessThan(1)
  const fills = Math.max((r.drawn.r - r.drawn.l) / (r.art.r - r.art.l), (r.drawn.b - r.drawn.t) / (r.art.b - r.art.t))
  expect(fills).toBeGreaterThan(0.8)
}

