// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Journey: the app against a real sx-link and the mock printers, end to end: pair, list, camera, send with preflight and
// approval on a Klipper printer, the bridge's settings, and, in the Bambu Lab describe, the Print sheet for an A1 with
// an AMS lite and an A1 mini with only the external spool (slot choice, the .gcode.3mf start, a client's queue send
// over MCP with its matched slots, a refused start with its reason and the plain G-code offer) and the camera guard, and, in the Snapmaker U1 describe, the Print sheet's toolhead choices.
// The live view of one printer (printer-hud) runs first, on the demo fleet, before the page pairs, and the Print sheet
// rows and the bridge section that need no hub follow it ('on the demo fleet'). The order is for speed only: every test
// pairs the page itself when it is not paired, and loads it again when it needs the demo fleet.
// The flows every brand shares are checked against each brand's driver in packages/connect/tests/drivers.rs; Bambu Lab
// is checked on real printers.
// The harness, with this file's own hub on a free loopback port, is in e2e/bridge-hub.ts. The page is shared by the
// file's tests (journey.ts): it pairs once, the tests after it find it paired, and the one box on the plate is sliced
// once per printer (`sheetOn`). Needs SX_LINK_BIN (a built sx-link); the tests skip without it.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PrinterHost } from '@slicerx/contracts'
import { type Locator, type Page, type WebSocketRoute } from '@playwright/test'
import { ONBOARDING_VERSION } from '../../../../packages/app/src/first-run/onboarding.ts'
import type { ApprovalDone } from '../../../../packages/connect/link-client/src/index.ts'
import { bridgeOn, connectApp, ctl, hub, logOf, mockLog, reportHand, resumeFromCard, sawToast, seed, start, useBridge } from '../bridge-hub'
import { plateReady } from '../fixtures'
import { expect, journey as test } from '../journey'
import { boxOnPlate, calm, command, debugHooks, layeredX, patch, printerHud, sliceLayered, startSlice, toSlice } from './lib/slice'

// Setup already done, as after any first launch: printer setup opened by a test then records no unfinished onboarding
// that a reload would open again (bridge-hub.ts seed).
test.use({ journeyPrefs: { workspace: 'prepare', settingsMode: 'advanced', cadTools: true, firstRun: { completedAt: '2026-10-01T00:00:00.000Z', step: 'done', look: { id: 'slicerx' }, printerId: null, version: ONBOARDING_VERSION } } })

/** The describe the Bambu Lab printers belong to. addBambu refuses to run outside it. */
const BAMBU = 'Bambu Lab'

/** The hub's printers changed since the page paired, and the page reads its list when it pairs. */
let printersChanged = false

// Not serial: no test here consumes what the one before it left. Each one pairs (`paired`), puts the mocks in the state
// it needs and puts them back in a finally, so a failure costs that test only and the rest start on a new hub. The one
// order the file keeps is that the Authorization Control step comes before the unsigned one, whose refusal leaves the
// hub's reading of the printer with the Developer Mode flag; a hub that has not read it yet is what that step needs,
// and file order gives it that, as a new hub after a failure does.
useBridge(['moonraker', 'bambu', 'snapmaker-u1'], async (ctl) => {
  // The Bambu mock as an A1 with an AMS lite and white PLA on the side holder.
  await ctl('/bambu', { model: 'N2S', ams: 'lite', external: { type: 'PLA', color: '#FFFFFF' } })
  await hub.admin.addPrinter({ id: 'voron', name: 'Voron', plugin: 'moonraker', host: '127.0.0.1', port: hub.ports['moonraker'] ?? 0 }, { vendor: 'Voron', model: '2.4' })
}, { serial: false })

test.beforeAll(async ({ app }) => {
  await debugHooks(app)
})

/** Puts the Bambu mock back to idle and waits until the hub has seen it. */
async function idleAgain(id: string): Promise<void> {
  // A job the hub just started stays busy for the hub until it has read the printer running (a reading right after a
  // start may still show the state before it), so a job ended before that would refuse the next start as busy.
  const mock = (await ctl('/state'))['bambu'] as { state?: string } | undefined
  const running = ['printing', 'paused', 'preparing']
  if (running.includes(mock?.state ?? '')) await expect.poll(async () => running.includes((await hub.admin.status(id)).state), { timeout: 20_000 }).toBe(true)
  await ctl('/set', { mock: 'bambu', state: 'idle' })
  await expect.poll(async () => (await hub.admin.status(id)).state, { timeout: 20_000 }).toBe('idle')
}

/**
 * Adds a Bambu Lab printer on the Bambu mock. Only the Bambu Lab describe may: the flows every brand shares run on the
 * simulated brands, and a new test that reaches for Bambu by default fails here.
 */
async function addBambu(id: string, name: string, model: string): Promise<void> {
  if (!test.info().titlePath.includes(BAMBU)) throw new Error(`addBambu is for the "${BAMBU}" describe only: shared flows belong in packages/connect/tests/drivers.rs, one case per brand driver`)
  const { MOCK_SERIAL, MOCK_ACCESS_CODE } = await import('../../../../packages/connect/mock-printers/src/bambu.ts')
  await hub.admin.setSecret(`${id}-code`, MOCK_ACCESS_CODE)
  await hub.admin.addPrinter(
    { id, name, plugin: 'bambu-lan', host: '127.0.0.1', port: hub.ports['bambu'], serial: MOCK_SERIAL, credentialRef: `${id}-code`, ftpPort: hub.ports['bambu-ftp'], cameraPort: hub.ports['bambu-camera'], pollMs: 200 },
    { vendor: 'Bambu Lab', model },
  )
  printersChanged = true
}

/** A tool's answer over MCP, as a client reads it. */
interface McpAnswer {
  isError?: boolean
  content: unknown[]
  structuredContent?: Record<string, unknown>
}

/**
 * An MCP client on the hub, set up the way a partner app runs slicerx-mcp: the server from this checkout over stdio, on
 * the hub's pairing code as an agent, slicing with the same sx the app uses, and its tools called over MCP. `model` is
 * an STL the server may read.
 */
async function mcpClient(): Promise<{ call(tool: string, args: Record<string, unknown>): Promise<McpAnswer>; model: string; close(): Promise<void> }> {
  const { createRequire } = await import('node:module')
  const { pathToFileURL } = await import('node:url')
  const { copyFileSync, existsSync, mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const repo = join(import.meta.dirname, '../../../..')
  const mcpDir = join(repo, 'packages/mcp')
  // The SDK and tsx are the MCP package's dependencies, so they resolve from there.
  const from = createRequire(join(mcpDir, 'package.json'))
  type McpClient = { connect(t: unknown): Promise<void>; callTool(p: { name: string; arguments: Record<string, unknown> }, schema?: unknown, opts?: { timeout?: number }): Promise<unknown>; close(): Promise<void> }
  const { Client } = (await import(pathToFileURL(from.resolve('@modelcontextprotocol/sdk/client/index.js')).href)) as { Client: new (info: { name: string; version: string }) => McpClient }
  const { StdioClientTransport } = (await import(pathToFileURL(from.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href)) as { StdioClientTransport: new (p: { command: string; args: string[]; cwd: string; env?: Record<string, string>; stderr?: 'pipe' | 'inherit' | 'ignore' }) => unknown }
  const sxBin = process.env['SX_CLI_BIN'] || join(repo, 'target/release', process.platform === 'win32' ? 'sx.exe' : 'sx')
  if (!existsSync(sxBin)) throw new Error(`the client slices with the native sx (${sxBin}); set SX_CLI_BIN`)
  const dir = mkdtempSync(join(tmpdir(), 'sx-e2e-mcp-'))
  const model = join(dir, 'x-mark.stl')
  copyFileSync(join(repo, 'packages/core/bench/models/x-mark.stl'), model)
  // Its own policy, so a policy file in the home folder never changes the run.
  const policy = join(dir, 'policy.json')
  writeFileSync(policy, JSON.stringify({ classes: { slice: 'allow', queue: 'ask', start: 'ask', profile: 'ask' } }))
  const args = [from.resolve('tsx/cli'), 'src/cli.ts', '--engine', 'sx', '--sx-bin', sxBin, '--printers', 'link', '--link-url', hub.linkUrl, '--no-app', '--allow-dir', dir, '--out-dir', join(dir, 'out'), '--profiles-dir', join(dir, 'profiles'), '--policy', policy]
  // The pairing code goes in the environment, never on the command line, as the server asks.
  const env = { ...(Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === 'string'))), SLICERX_MCP_LINK_CODE: hub.code }
  const transport = new StdioClientTransport({ command: process.execPath, args, cwd: mcpDir, env, stderr: 'inherit' })
  const client = new Client({ name: 'e2e-partner', version: '0.0.0' })
  await client.connect(transport)
  return {
    call: async (tool, args) => (await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 90_000 })) as McpAnswer,
    model,
    close: async () => {
      await client.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

const PAIRED = '__sxPairedPort'

/** Notes on the page that it is paired with this file's hub, until it loads again. */
async function mark(page: Page): Promise<void> {
  await page.evaluate(([key, port]) => Object.assign(window, { [key]: port }), [PAIRED, hub.port] as const)
}

/** Loads the app and pairs it with the hub, which opens a new connection: for a test that routes the connection. */
async function repair(page: Page): Promise<void> {
  await toSlice(page)
  await connectApp(page)
  await mark(page)
}

/**
 * The page paired with this file's hub on the Slice tab with no dialog open. It pairs only when it is not, since a
 * reload ends a pairing, and a test that did not reload finds it as the one before left it.
 */
async function paired(page: Page): Promise<void> {
  const port = await page.evaluate((key) => (window as unknown as Record<string, unknown>)[key], PAIRED)
  if (port !== hub.port || printersChanged) {
    printersChanged = false
    return repair(page)
  }
  await page.keyboard.press('Escape')
  await calm(page, 'advanced', { keepPrinter: true })
  // The toasts the page has drawn so far (bridge-hub.ts keeps them for sawToast) are the earlier tests': a test waits for its own.
  await page.evaluate(() => (window as unknown as { __toasts?: string[] }).__toasts?.splice(0))
}

type Sheet = { printer: string; plate: unknown; result: unknown }

/**
 * Puts one 20 mm box on the plate for `printer`, slices it, and opens the Print sheet. The slice is kept per printer:
 * the next test on the same printer, with the plate and the slice as they were, opens its sheet without slicing again.
 */
async function sheetOn(page: Page, printer: string): Promise<Locator> {
  await paired(page)
  const chip = page.getByTestId('slice-machine-printer')
  if (((await chip.locator('.printer-name').textContent()) ?? '').trim() !== printer) {
    await chip.click()
    await page.getByRole('list', { name: 'Choose a printer' }).getByRole('button', { name: new RegExp(`^${printer}\\b`) }).first().click()
  }
  const current = await page.evaluate((printer) => {
    const w = window as unknown as { __sx: { getState(): { plate: unknown[]; slice: { status: string; stale?: boolean; result?: unknown } } }; __sheet?: Sheet }
    const s = w.__sx.getState()
    const c = w.__sheet
    return !!c && c.printer === printer && s.plate.length === 1 && s.plate[0] === c.plate && s.slice.status === 'done' && !s.slice.stale && s.slice.result === c.result
  }, printer)
  if (!current) {
    await boxOnPlate(page)
    await startSlice(page)
    await page.evaluate((printer) => {
      const w = window as unknown as { __sx: { getState(): { plate: unknown[]; slice: { result?: unknown } } }; __sheet?: Sheet }
      const s = w.__sx.getState()
      w.__sheet = { printer, plate: s.plate[0], result: s.slice.result }
    }, printer)
  }
  await command(page, `Print the plate on ${printer}`)
  const sheet = page.locator('dialog.print-sheet[open]')
  await expect(sheet).toBeVisible()
  await expect(sheet.locator('.ps-file[data-checked]')).toBeVisible({ timeout: 30_000 })
  return sheet
}

test('a printer opens in its live view with drawers, and Pause asks first', async ({ page, isMobile }) => {
  // A page no bridge is paired with shows the demo fleet.
  await page.goto('./')
  await plateReady(page)
  await printerHud(page, isMobile)
})

/**
 * The demo fleet, as a first launch shows it: a page that paired with the hub lists the hub's printers instead, and a
 * reload ends the pairing, so that page loads again. The tests on it come before the first pairing, and a page that
 * has not paired in this load is used as it is.
 */
async function demoFleet(page: Page): Promise<void> {
  const paired = await page.evaluate((key) => (window as unknown as Record<string, unknown>)[key] !== undefined, PAIRED)
  if (paired) {
    await page.goto('./')
    await plateReady(page)
  }
  await debugHooks(page)
  await calm(page, 'advanced')
}

/** The Print sheet of the sliced Layered X plate on the demo fleet, open. The slice is the one this load already holds when it is current. */
async function demoSheet(page: Page): Promise<Locator> {
  await demoFleet(page)
  await sliceLayered(page)
  await command(page, 'Print the plate on')
  const sheet = page.locator('dialog.print-sheet[open]')
  await expect(sheet).toBeVisible()
  return sheet
}

test.describe('on the demo fleet', () => {
  test('the printer bridge section asks for a code and says plainly when sx-link is not running', async ({ page }) => {
    // The hub is up for the other tests of this file; here nothing answers at its address. The app opens its connection
    // as it loads, so the route is in place first and the page loads again behind it.
    let unreachable = true
    await page.routeWebSocket(hub.route, (ws) => {
      if (unreachable) void ws.close()
      else ws.connectToServer()
    })
    try {
      await page.goto('./')
      await plateReady(page)
      await demoFleet(page)
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Printer bridge' }).click()
      const connect = page.getByRole('button', { name: 'Connect', exact: true })
      await expect(connect).toBeDisabled()
      await page.getByLabel('Pairing code').fill('abcd-2345')
      await expect(connect).toBeEnabled()
      await connect.click()
      await expect(page.getByRole('alert')).toContainText(/Cannot reach sx-link/)
    } finally {
      unreachable = false
      await page.keyboard.press('Escape')
    }
  })

  test('queue for later uploads and waits', async ({ page }) => {
    test.slow()
    const sheet = await demoSheet(page)
    await sheet.getByRole('button', { name: 'More ways to send' }).click()
    await sheet.getByRole('menuitemcheckbox', { name: 'Queue for later' }).click()
    await sheet.getByLabel('Not before (optional)').fill('2030-01-01T02:00')
    await expect(sheet).toContainText('adds it to the queue')
    await expect(sheet.getByRole('button', { name: /Bed is clear/ })).toHaveCount(0)
    await expect(sheet.getByRole('button', { name: 'Add to queue' })).toBeVisible()
    await sheet.getByRole('button', { name: 'Cancel' }).click()
  })

  test('send shows each filament on its printer slot as text when every filament has one', async ({ page }) => {
    test.slow()
    const sheet = await demoSheet(page)
    await expect(sheet.locator('.ps-file[data-checked]')).toBeVisible()
    const fils = sheet.getByRole('list', { name: 'Filaments' }).locator('.ps-fil')
    expect(await fils.count()).toBeGreaterThanOrEqual(1)
    await expect(fils.first()).toContainText(/AMS |Slot |External spool|Not loaded/)
    // A slot is picked on the sheet only when no loaded slot fits a filament.
    const picker = sheet.getByRole('group', { name: 'Pick a slot' })
    if (await picker.count()) await expect(sheet.getByRole('button', { name: /^Bed is clear, start/ })).toBeDisabled()
    else await expect(sheet.getByRole('combobox')).toHaveCount(0)
    await sheet.getByRole('button', { name: 'Cancel' }).click()
  })

  test('send to several printers walks each one through its own send step', async ({ page }) => {
    test.slow()
    await demoFleet(page)
    await sliceLayered(page)
    await page.getByRole('button', { name: 'Printers', exact: true }).click()
    await page.getByRole('button', { name: 'Several' }).click()
    const pick = page.getByRole('dialog', { name: 'Print on several printers' })
    const boxes = pick.getByRole('checkbox')
    expect(await boxes.count()).toBeGreaterThan(1)
    await expect(pick.getByRole('button', { name: 'Continue' })).toBeDisabled()
    await boxes.nth(0).check()
    await boxes.nth(1).check()
    await pick.getByRole('button', { name: /Continue with 2 printers/ }).click()
    const first = page.locator('dialog.print-sheet[open]')
    await expect(first).toBeVisible()
    const titles = () => page.locator('dialog.print-sheet[open] .ps-printer-name').allInnerTexts().then((t) => t.join('|'))
    const firstTitle = await titles()
    expect(firstTitle.length).toBeGreaterThan(0)
    await first.getByRole('button', { name: 'Cancel' }).click()
    // The next printer's sheet opens with its own name.
    await expect.poll(async () => { const t = await titles(); return t.length > 0 && t !== firstTitle }).toBe(true)
    await page.locator('dialog.print-sheet[open]').getByRole('button', { name: 'Cancel' }).click()
    await expect(page.locator('dialog.print-sheet[open]')).toHaveCount(0)
  })

  test('a slot links to a Spoolman spool, and the plate can be subtracted from it with approval', async ({ page }) => {
    test.slow()
    await demoFleet(page)
    await layeredX(page)
    try {
      await page.locator('[data-testid="slice-filament-slot"][data-slot="1"]').click({ button: 'right' })
      await page.getByTestId('slice-filament-edit').click()
      const dialog = page.getByRole('dialog', { name: /Filament 1/ })
      // The spool picker is a list with a search and a vendor filter; the first row is Not linked.
      const spools = dialog.getByRole('listbox', { name: 'Spools' }).getByRole('option')
      await expect(spools.first()).toBeVisible()
      expect(await spools.count()).toBeGreaterThan(2)
      await spools.nth(1).getByRole('button').click()
      await expect(spools.nth(1)).toHaveAttribute('aria-selected', 'true')
      await dialog.getByRole('button', { name: 'Done' }).click()
      await startSlice(page)
      await page.getByRole('button', { name: 'Record use in Spoolman' }).click()
      const approve = page.locator('dialog.approve-dialog[open]')
      await expect(approve).toContainText('Subtract this print from your spools in Spoolman?')
      await approve.getByRole('button', { name: 'Deny' }).click()
    } finally {
      await patch(page, { slotSetup: {} })
    }
  })
})

test('pairs with the bridge and lists its printer', async ({ page }) => {
  await repair(page)
  await page.getByRole('button', { name: 'Printers', exact: true }).first().click()
  await expect(page.getByText('Voron').first()).toBeVisible()
})

test('printer setup asks the bridge to search the network only when Search my network is pressed', async ({ page }) => {
  // Every call the app makes on the hub, read on the way through.
  const calls: string[] = []
  await page.routeWebSocket(hub.route, (ws) => {
    const server = ws.connectToServer()
    ws.onMessage((m) => {
      if (typeof m === 'string') {
        try {
          const method = (JSON.parse(m) as { method?: unknown }).method
          if (typeof method === 'string') calls.push(method)
        } catch {
          // Not a call: the handshake.
        }
      }
      server.send(m)
    })
  })
  await repair(page)
  await page.getByTestId('slice-machine-printer').click()
  await page.locator('.choose-add').click()
  const search = page.getByRole('button', { name: 'Search my network' })
  await expect(search).toBeVisible()
  // Open, connected and idle for a while: no search yet, so no socket listens for printers.
  await page.waitForTimeout(5000)
  expect(calls.length).toBeGreaterThan(0)
  expect(calls).not.toContain('discover')
  await search.click()
  await expect.poll(() => calls.includes('discover')).toBe(true)
  // Printer setup is a page of its own, and it is not closed with a key: the next test starts the app again.
  await toSlice(page)
  await page.goto('./')
  await plateReady(page)
})

/** Printer setup for a Bambu Lab X1 Carbon, up to its connection choices. */
async function setupX1(page: Page): Promise<void> {
  await page.getByTestId('slice-machine-printer').click()
  await page.locator('.choose-add').click()
  const byHand = page.getByRole('button', { name: /Add it by hand/ }).first()
  await expect(byHand).toBeVisible()
  await byHand.dblclick()
  await page.getByRole('radiogroup', { name: 'Brand' }).getByRole('radio', { name: /Bambu Lab/ }).click()
  await page.getByTestId('setup-model-bambu-x1-carbon').click()
  await expect(page.getByTestId('setup-connection-bambu-lan')).toBeVisible()
}

test('Connected apps: BamBuddy shows as a printer connection only once it is added', async ({ page }) => {
  // The app starts three times.
  test.slow()
  // A stand-in BamBuddy on this computer that lists one printer.
  const { createServer } = await import('node:http')
  const keys: string[] = []
  const server = createServer((req, res) => {
    keys.push(String(req.headers['x-api-key'] ?? ''))
    res.setHeader('content-type', 'application/json')
    res.end(req.url === '/api/v1/printers' ? '[{"id":12,"name":"Shed P1S"}]' : '{}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  try {
    // Before: the X1 Carbon offers its own connection and export, nothing new.
    await paired(page)
    await setupX1(page)
    await expect(page.getByTestId('setup-connection-bambuddy')).toHaveCount(0)
    await expect(page.getByTestId('setup-connection-bambu-lan')).toHaveAttribute('data-on', 'true')

    // Add BamBuddy once, in Settings, Connected apps.
    await page.goto('./')
    await plateReady(page)
    await bridgeOn(page)
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Connected apps' }).click()
    const card = page.getByTestId('connected-app-bambuddy')
    await card.getByTestId('connected-app-bambuddy-address').fill(`127.0.0.1:${port}`)
    await card.getByTestId('connected-app-bambuddy-key').fill('e2e-bambuddy-key')
    await card.getByTestId('connected-app-bambuddy-save').click()
    await expect(card.getByTestId('connected-app-bambuddy-status')).toHaveText('Connected')
    await expect(card).toContainText('1 printer in BamBuddy')
    expect(keys).toContain('e2e-bambuddy-key')
    // Spoolman moved here from Printer bridge.
    await expect(page.getByTestId('connected-app-spoolman')).toContainText('Spoolman')
    await page.keyboard.press('Escape')

    // After: the same printer can now choose BamBuddy, and its own connection stays the default.
    await setupX1(page)
    await expect(page.getByTestId('setup-connection-bambu-lan')).toHaveAttribute('data-on', 'true')
    await page.getByTestId('setup-connection-bambuddy').click()
    await expect(page.getByPlaceholder('12')).toBeVisible()
    await expect(page.getByPlaceholder('192.168.1.50')).toHaveCount(0)
  } finally {
    // Leave the hub as the other tests expect it.
    await page.goto('./')
    await plateReady(page)
    await bridgeOn(page)
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Connected apps' }).click()
    // The card draws the add form until the page has read the hub's apps, so the form on screen does not say BamBuddy is
    // gone. The hub says it, and the card is waited for in the state the hub has.
    const added = (await hub.admin.listServices()).some((s) => s.pluginId === 'bambuddy')
    if (added) await page.getByTestId('connected-app-bambuddy-remove').click()
    await expect(page.getByTestId('connected-app-bambuddy-save')).toBeVisible()
    await mark(page)
    server.close()
  }
})

test('Connected apps: Home Assistant shows in every mode, with no Experimental label', async ({ page }) => {
  const { startMocks } = await import('../../../../packages/connect/mock-printers/src/index.ts')
  const { MOCK_HA_TOKEN } = await import('../../../../packages/connect/mock-printers/src/services.ts')
  const ha = await startMocks({ only: ['home-assistant'] })
  const apps = page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Connected apps' })
  try {
    await paired(page)
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await apps.click()
    // Advanced mode: the card is there without the experimental switch, and carries no Experimental label.
    await expect(page.getByTestId('connected-apps-experimental')).toHaveCount(0)
    const card = page.getByTestId('connected-app-home-assistant')
    await expect(card).toBeVisible()
    await expect(card.getByTestId('connected-app-home-assistant-experimental')).toHaveCount(0)
    await card.getByTestId('connected-app-home-assistant-address').fill(`127.0.0.1:${ha.ports['home-assistant']}`)
    await card.getByTestId('connected-app-home-assistant-key').fill(MOCK_HA_TOKEN)
    await card.getByTestId('connected-app-home-assistant-save').click()
    await expect(card.getByTestId('connected-app-home-assistant-status')).toHaveText('Connected')
    await expect(card).toContainText(/\d+ (switch, light or fan|switches, lights and fans) in Home Assistant/)

    // Remove it again.
    await card.getByTestId('connected-app-home-assistant-remove').click()
    await expect(card.getByTestId('connected-app-home-assistant-save')).toBeVisible()
  } finally {
    await ha.stop()
  }
})

test('Partner app: a named key shown once, listed in Devices, and revoking it cuts the partner off', async ({ page }) => {
  const { connectLink } = await import('../../../../packages/connect/link-client/src/index.ts')
  await paired(page)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'mimir' }).click()
  await page.getByTestId('agent-partner').click()
  await page.getByTestId('partner-name').fill('LayerMate')
  await page.getByTestId('partner-create').click()
  const shown = page.getByTestId('partner-key')
  await expect(shown).toHaveText(/^sxp_[0-9a-f]{64}$/)
  // Held in memory for this test only, against a throwaway hub.
  const key = (await shown.textContent()) ?? ''
  await page.getByTestId('partner-hide').click()
  await expect(shown).toHaveCount(0)
  await expect(page.getByText(key)).toHaveCount(0)

  // The partner app pairs with it, reads printers, and approves nothing.
  const hubKey = hub.admin.hubKey
  const partner = await connectLink({ url: hub.linkUrl, clientKey: key, hubKey })
  expect(partner.partner).toBe(true)
  expect((await partner.list()).map((p) => p.id)).toContain('voron')
  await expect(partner.approvals.grant('nothing')).rejects.toThrow(/partner|person|forbidden/i)

  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Printer bridge' }).click()
  const list = page.getByTestId('devices-list')
  const row = list.locator('li', { hasText: 'LayerMate' })
  await expect(row).toContainText('Partner app')
  await row.getByRole('button', { name: 'Revoke' }).click()
  await expect(row).toHaveCount(0)
  // The hub closed the partner's open connection, and the key no longer pairs.
  await expect.poll(() => partner.list().then(() => 'open', () => 'closed'), { timeout: 10_000 }).toBe('closed')
  await expect(connectLink({ url: hub.linkUrl, clientKey: key, hubKey })).rejects.toThrow()
  partner.close()
})

// Agent first: a client reads the integrations list Settings > mimir shows, with the same states and bays.
test('Settings > mimir and slicerx_integrations_list show the same integrations, states and bays', async ({ page }) => {
  await paired(page)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'mimir' }).click()
  const rows = page.getByTestId('mimir-integrations').locator('li')
  await expect(rows.filter({ hasText: 'Voron' })).toHaveCount(1)
  const shown = await rows.evaluateAll((lis) => lis.map((li) => ({ name: li.querySelector('b')?.textContent ?? '', detail: li.querySelector('small')?.textContent ?? '', word: li.querySelector('.sx-pill')?.textContent ?? '' })))
  const mcp = await mcpClient()
  try {
    const r = await mcp.call('slicerx_integrations_list', {})
    expect(r.isError ?? false).toBe(false)
    const listed = (r.structuredContent as { integrations: { name: string; state: string; bays: string[] }[] }).integrations
    expect(listed.length).toBeGreaterThan(0)
    expect(listed.map((i) => i.name)).toEqual(shown.map((s) => s.name))
    expect(listed.map((i) => (i.state === 'connected' ? 'Connected' : i.state === 'off' ? 'Off' : i.state))).toEqual(shown.map((s) => s.word))
    // a printer integration's detail in Settings names its bays, or says none is assigned
    for (const [i, row] of listed.map((l, n) => [l, shown[n]!] as const)) if (i.bays.length) expect(row.detail).toBe(i.bays.join(', '))
    expect(listed.find((i) => i.bays.includes('Voron'))?.state).toBe('connected')
  } finally {
    await mcp.close()
  }
})

test('a wrong code is refused with a plain message', async ({ page }) => {
  await toSlice(page)
  await seed(page)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Printer bridge' }).click()
  await page.getByLabel('Pairing code').fill('ZZZZ9999')
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('That pairing code was not accepted.')
})

test('the camera player shows live frames from the printer', async ({ page }) => {
  await paired(page)
  await page.keyboard.press('ControlOrMeta+k')
  await page.keyboard.type('Open the camera of Voron')
  await page.locator('.sx-palette-item', { hasText: 'Open the camera of Voron' }).first().click()
  const dialog = page.getByRole('dialog', { name: /Voron camera/ })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText(/\d+ fps/)).toBeVisible({ timeout: 30_000 })
  await expect(dialog.getByText('Direct on your network')).toBeVisible()
})

test('sends a sliced plate with the preflight and an approval, and the printer receives it', async ({ page }) => {
  test.slow()
  // One Print sheet: it checks the file against the printer, and its confirm button is the approval.
  const sheet = await sheetOn(page, 'Voron')
  await start(sheet)
  await sawToast(page, /started on Voron/, { timeout: 30_000 })
  expect(await mockLog()).toMatch(/\.gcode/)
})

test.describe(BAMBU, () => {
  test.beforeAll(async ({}, testInfo) => {
    // The phone project starts no hub (e2e/bridge-hub.ts), so there is nothing to add the printer to.
    if (testInfo.project.use.isMobile) return
    await addBambu('a1', 'A1', 'A1')
  })

  test('A1 with an AMS lite: the sheet sends a .gcode.3mf from the matched slot', async ({ page }) => {
    test.slow()
    const sheet = await sheetOn(page, 'A1')
    // The file and its filaments were decided before the sheet: a summary, no field and no slot picker.
    await expect(sheet.locator('.ps-file')).toContainText('.gcode.3mf')
    await expect(sheet.locator('.ps-fil').first()).toContainText(/AMS A\d|External spool/)
    await expect(sheet.locator('#ps-map-1')).toHaveCount(0)
    // The options an A1 has, and no first layer inspection.
    await expect(sheet.getByRole('switch', { name: 'Bed leveling' })).toBeVisible()
    await expect(sheet.getByRole('switch', { name: 'Vibration compensation' })).toBeVisible()
    await expect(sheet).not.toContainText('First layer inspection')
    await start(sheet)
    await sawToast(page, /started on A1/, { timeout: 30_000 })
    const log = await mockLog()
    expect(log).toMatch(/project_file/)
    expect(log).toMatch(/\.gcode\.3mf/)
    expect(log).toMatch(/ams_mapping\\":\[\d+\]/)
    await idleAgain('a1')
  })

  // A client queues the plate over MCP, as a partner app does with slicerx-mcp: the hub gets a .gcode.3mf with each
  // filament matched to a loaded slot, the person approves the card in the app, and the printer starts it with
  // `project_file`, the AMS mapping and use_ams on. Before, a client's send went as plain G-code with no mapping.
  test('A1 with an AMS lite: a client queue send starts a .gcode.3mf from the matched slot', async ({ page }) => {
    test.slow()
    await idleAgain('a1')
    await paired(page)
    // The plate takes the color of a PLA slot in the AMS lite that no other PLA slot shares, so only the color can pick it.
    const slots = ((await hub.admin.status('a1')) as unknown as { slots: { id: string; material?: string; color?: string }[] }).slots
    const pla = slots.filter((s) => /^PLA/i.test(s.material ?? '') && s.color)
    const target = pla.filter((s) => /^A[1-4]$/.test(s.id) && !pla.some((o) => o.id !== s.id && o.color?.toLowerCase() === s.color?.toLowerCase())).at(-1)
    if (!target?.color) throw new Error(`no PLA slot of its own color in the AMS lite: ${JSON.stringify(slots)}`)
    const mcp = await mcpClient()
    let completed: ApprovalDone | undefined
    let stopWatching = () => {}
    try {
      for (const [tool, args] of [
        ['slicerx_project_open', { name: 'Queue', printer: 'bambu_a1', filament: 'pla' }],
        ['slicerx_project_set_filament', { slot: 1, color: target.color }],
        ['slicerx_project_add_model', { model: mcp.model, copies: 1 }],
        ['slicerx_slice', {}],
      ] as const) {
        const r = await mcp.call(tool, args)
        expect(r.isError, `${tool}: ${JSON.stringify(r.content)}`).toBeFalsy()
      }
      const q = await mcp.call('slicerx_printer_queue', { printerId: 'a1', plate: 1 })
      // Read back: the file and the slot map the hub was handed.
      expect(q.structuredContent, JSON.stringify(q.content)).toMatchObject({ status: 'needs_person', request_id: expect.any(String), slot_map: { 0: target.id } })
      expect(String(q.structuredContent?.['file'])).toMatch(/\.gcode\.3mf$/)
      stopWatching = hub.admin.onApprovalDone((done) => {
        if (done.requestId === q.structuredContent?.['request_id']) completed = done
      })
      // The Bambu mock writes the commands it reads to the mocks' shared log; its own log has only the job.
      const starts = async () => ((await ctl('/state'))['log'] as string[]).filter((l) => l.startsWith('project_file {'))
      const before = (await starts()).length
      // The card in the app shows the slot the print starts from; the person approves it.
      const card = page.locator('dialog.approve-dialog[open]')
      await expect(card).toContainText(`filament 1 from slot ${target.id}`, { timeout: 30_000 })
      await card.getByRole('button', { name: 'Bed is clear, approve' }).click()
      await expect.poll(async () => (await starts()).length, { message: 'the printer got a project_file start', timeout: 60_000 }).toBeGreaterThan(before)
      const start = JSON.parse((await starts()).at(-1)!.slice('project_file '.length)) as { param: string; url: string; ams_mapping: number[]; use_ams: boolean }
      expect(start.param).toBe('Metadata/plate_1.gcode')
      expect(start.url).toMatch(/\.gcode\.3mf$/)
      // AMS lite slot A<n> is tray n - 1.
      expect(start.ams_mapping).toEqual([Number(target.id.slice(1)) - 1])
      expect(start.use_ams).toBe(true)
      // Receipt at the printer can precede the hub recording the start. Finish before resetting it.
      await expect.poll(() => completed, { timeout: 60_000 }).toMatchObject({ ok: true })
    } finally {
      stopWatching()
      await mcp.close()
      await idleAgain('a1')
    }
  })

  test('A1: a refused start shows the reason and offers plain G-code', async ({ page }) => {
    test.slow()
    await ctl('/bambu', { refuse: 'The file could not be parsed (mock)' })
    try {
      const sheet = await sheetOn(page, 'A1')
      await start(sheet)
      const again = page.locator('dialog.print-sheet[open]')
      // On a miss, say what the printer was asked to do.
      await expect(again).toContainText('A1 did not start the print', { timeout: 30_000 }).catch(async (e: unknown) => {
        const app = await page.evaluate(() => JSON.stringify((window as unknown as { __sx: { getState(): { toast: unknown } } }).__sx.getState().toast))
        throw new Error(`${String(e).slice(0, 300)}\napp toast: ${app}\nmock log: ${(await mockLog()).slice(-600)}`)
      })
      // The printer's own words are in the line's Details.
      await expect(again.locator('.cl-more[data-tip-title="A1 did not start the print"]')).toHaveAttribute('data-tip-body', /^It said: The file could not be parsed \(mock\)/)
      const plain = again.getByRole('button', { name: 'Send as plain G-code' })
      await expect(plain).toBeEnabled()
      await ctl('/bambu', { refuse: null })
      await plain.click()
      await sawToast(page, /started on A1/, { timeout: 30_000 })
      const log = await mockLog()
      expect(log).toMatch(/project_file refused/)
      // gcode_file started the plain file, not the .gcode.3mf.
      expect(log).toMatch(/"start [^"]+\.gcode"/)
    } finally {
      await ctl('/bambu', { refuse: null })
      await idleAgain('a1')
    }
  })

  test('A1 mini with the external spool only: filament 1 goes to the external spool', async ({ page }) => {
    test.slow()
    await ctl('/bambu', { model: 'N1', ams: 'none', external: { type: 'PLA', color: '#FFFFFF' } })
    await addBambu('a1mini', 'A1 mini', 'A1 mini')
    try {
      const sheet = await sheetOn(page, 'A1 mini')
      await expect(sheet.locator('.ps-fil').first()).toContainText('External spool')
      const slot = sheet.locator('#ps-map-1')
      if (await slot.count()) {
        const opts = (await slot.locator('option').allTextContents()).map((o) => o.trim())
        expect(opts.filter((o) => /^A\d/.test(o))).toEqual([])
      }
      await start(sheet)
      await sawToast(page, /started on A1 mini/, { timeout: 30_000 })
      const log = await mockLog()
      // The external spool is tray 254 (vt_tray).
      expect(log).toMatch(/project_file[^\n]*ams_mapping\\":\[254\]|ams_mapping\\":\[-1\]|use_ams\\":false/)
    } finally {
      // The A1 mini is the same mock as A1: leave A1 alone on it, as the tests after this one expect, and the mock an
      // A1 again.
      await hub.admin.removePrinter('a1mini')
      printersChanged = true
      await ctl('/bambu', { model: 'N2S', ams: 'lite', external: { type: 'PLA', color: '#FFFFFF' } })
      // Both sessions read the same mock topic, so A1 took the A1 mini's get_version answer too. A reconnect asks
      // again, and A1 reads as an A1 (256 x 256 mm bed) for the tests after this one.
      await ctl('/bambu', { dropMqtt: true })
      await expect.poll(async () => ((await hub.admin.status('a1')) as { model?: string }).model, { timeout: 30_000 }).toMatch(/^(Bambu Lab )?A1$/)
      await idleAgain('a1')
    }
  })

  // Authorization Control firmware without Developer Mode and with no flag or reply that says so (a Discord report
  // from an A1 mini): status and the light work, the upload is turned away. The sheet says Developer Mode may be the
  // cause. Runs before the Developer Mode test, whose reports leave the flag on in the hub's reading.
  test('A1 on Authorization Control without Developer Mode: the sheet shows the steps and Bambu Connect', async ({ page }) => {
    test.slow()
    await idleAgain('a1')
    await ctl('/bambu', { authorizationControl: 'silent' })
    try {
      const sheet = await sheetOn(page, 'A1')
      await start(sheet)
      const again = page.locator('dialog.print-sheet[open]')
      const box = again.getByTestId('developer-mode-needed')
      await expect(box).toContainText("A1 sends its status but didn't take the print. That may be Developer Mode being off.", { timeout: 60_000 })
      await expect(again.getByRole('button', { name: 'Send as plain G-code' })).toHaveCount(0)
      // Read back: a guess is never written into the hub's status, which keeps to what the printer said.
      expect((await hub.admin.status('a1')).live?.needsDeveloperMode).toBeUndefined()
      expect((await hub.admin.status('a1')).state).toBe('idle')
      await sheetShots(page, box, 'developer-mode-may')
      // Closed, the sheet fits a 1440 x 900 window with the refusal and Start in view. Opening the steps grows it
      // downward: the title and the toggle keep their place to the pixel (static controls).
      const toggle = box.getByTestId('developer-mode-steps-toggle')
      await expect(toggle).toHaveAttribute('aria-expanded', 'false')
      const dialogBox = await again.boundingBox()
      expect(dialogBox!.y).toBeGreaterThanOrEqual(0)
      expect(dialogBox!.y + dialogBox!.height).toBeLessThanOrEqual(900)
      await expect(again.getByRole('button', { name: /start/i }).first()).toBeInViewport()
      const title = again.locator('.sx-dialog-h h2')
      const [titleBefore, toggleBefore] = [await title.boundingBox(), await toggle.boundingBox()]
      await toggle.click()
      await expect(box.getByTestId('developer-mode-steps-list')).toContainText('swipe to page 3')
      expect(await title.boundingBox()).toEqual(titleBefore)
      expect(await toggle.boundingBox()).toEqual(toggleBefore)
      await toggle.click()
      await expect(box.getByTestId('developer-mode-steps-list')).toHaveCount(0)
      // The browser has no file path to hand to Bambu Connect, so it saves the file.
      await page.evaluate(() => delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker)
      const download = page.waitForEvent('download')
      await box.getByTestId('danger-bambu-connect-send').click()
      expect((await download).suggestedFilename()).toMatch(/\.gcode\.3mf$/)
      expect(await mockLog()).toMatch(/dropped STOR/)
    } finally {
      await ctl('/bambu', { authorizationControl: null })
      await idleAgain('a1')
    }
  })

  // The same firmware answering the start with the unsigned-command refusal (`mqtt message verify failed`): the
  // printer said it, so the sheet says it plainly and the hub's status carries it for clients to read back.
  test('A1 refusing the start as unsigned: the sheet says Developer Mode is off, and the status says so', async ({ page }) => {
    test.slow()
    await idleAgain('a1')
    await ctl('/bambu', { authorizationControl: 'verify' })
    try {
      const sheet = await sheetOn(page, 'A1')
      await start(sheet)
      const again = page.locator('dialog.print-sheet[open]')
      const box = again.getByTestId('developer-mode-needed')
      await expect(box).toContainText('A1 sends its status but turned the print away. Bambu Lab printers do that while Developer Mode is off.', { timeout: 60_000 })
      await expect(box).not.toContainText('may be')
      await expect(again.getByRole('button', { name: 'Send as plain G-code' })).toHaveCount(0)
      expect(await mockLog()).toMatch(/unsigned project_file/)
      await expect.poll(async () => (await hub.admin.status('a1')).live?.needsDeveloperMode, { timeout: 10_000 }).toBe(true)
      await sheetShots(page, box, 'developer-mode-sure')
    } finally {
      await ctl('/bambu', { authorizationControl: null })
      await idleAgain('a1')
    }
  })

  // A full card answers the upload with FTP 452: the sheet says to free space, never Developer Mode.
  test('A1 with a full card: the sheet says there is no room and how to free space', async ({ page }) => {
    test.slow()
    await idleAgain('a1')
    await ctl('/bambu', { storageFull: true })
    try {
      const sheet = await sheetOn(page, 'A1')
      await start(sheet)
      const again = page.locator('dialog.print-sheet[open]')
      const box = again.getByTestId('storage-full-needed')
      await expect(box).toContainText('A1 has no room for the file: its storage is full.', { timeout: 60_000 })
      await expect(box).toContainText('Delete old print files on the printer')
      await expect(again.getByTestId('developer-mode-needed')).toHaveCount(0)
      await expect(again.getByRole('button', { name: 'Send as plain G-code' })).toHaveCount(0)
      expect(await mockLog()).toMatch(/full STOR/)
      await sheetShots(page, box, 'storage-full')
    } finally {
      await ctl('/bambu', { storageFull: false })
      await idleAgain('a1')
    }
  })

  test('A1 with Developer Mode off: status keeps coming, and Print saves the file for Bambu Connect', async ({ page }) => {
    test.slow()
    await idleAgain('a1')
    await ctl('/bambu', { model: 'N2S', ams: 'lite', external: { type: 'PLA', color: '#FFFFFF' }, developerMode: false })
    try {
      // The printer still connects and reports; it is monitor-only, never a failed connection.
      await expect.poll(async () => (await hub.admin.status('a1')).live?.monitorOnly, { timeout: 20_000 }).toBe(true)
      expect((await hub.admin.status('a1')).state).toBe('idle')
      const sheet = await sheetOn(page, 'A1')
      await expect(sheet).toContainText('Developer Mode is off on A1')
      await expect(sheet.getByRole('switch', { name: 'Bed leveling' })).toHaveCount(0)
      await expect(sheet.getByRole('button', { name: /start/i })).toHaveCount(0)
      const logs = async () => {
        const st = await ctl('/state')
        return [...(st['log'] as string[]), ...((st['bambu'] as { log: string[] }).log)].filter((l) => /project_file|refused|upload|STOR/i.test(l))
      }
      const before = await logs()
      // The browser has no file path to hand to Bambu Connect, so it saves the file; no picker in a headless run.
      await page.evaluate(() => delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker)
      const download = page.waitForEvent('download')
      await sheet.getByRole('button', { name: 'Save file' }).click()
      expect((await download).suggestedFilename()).toMatch(/\.gcode\.3mf$/)
      // Bambu Lab makes no Bambu Connect for Linux, so there the line says to take the file to the printer instead.
      const linux = await page.evaluate(() => /Linux/.test(navigator.userAgent) && !/Android/.test(navigator.userAgent))
      await sawToast(page, linux ? /Bambu Connect isn't available for Linux yet/ : /Open it in Bambu Connect and press Print there/)
      // Nothing went to the printer: no upload, no start, nothing it had to refuse.
      expect(await logs()).toEqual(before)
    } finally {
      // Back on, said in the report: a report that leaves the flag out keeps the hub's last reading, as a printer's
      // partial reports do. The tests after this one need A1 to take commands, so this waits until the hub has seen it.
      await ctl('/bambu', { developerMode: true })
      await expect.poll(async () => (await hub.admin.status('a1')).live?.monitorOnly ?? false, { timeout: 20_000 }).toBe(false)
    }
  })

  test('the camera guard pauses for a hand and brings its card up on Printers', async ({ page }) => {
    test.slow()
    await idleAgain('a1')
    await paired(page)
    const { HAND_FRAME } = await import('../../../../packages/connect/mock-printers/src/frames.ts')
    await ctl('/bambu', { cameraFrame: 'hand' })
    await ctl('/set', { mock: 'bambu', state: 'printing' })
    try {
      await expect.poll(async () => (await hub.admin.status('a1')).state, { timeout: 20_000 }).toBe('printing')
      const det = await reportHand('a1')
      try {
        expect(Buffer.from(det.frame).equals(HAND_FRAME), 'the detector got the hand frame').toBe(true)
        expect(det.paused).toBe(true)
        // The report comes back once the hub has sent the pause; the mock logs it when it gets there, a moment later.
        await expect.poll(mockLog, { message: 'the printer got the pause', timeout: 20_000 }).toMatch(/pause/)
        // The app comes to Printers on its own, with the card in view: the frame, the strike, and Resume.
        const card = page.locator('.guard-card')
        await expect(card.getByRole('heading', { name: 'Paused: a hand in the printer' })).toBeVisible()
        await expect(card.locator('img')).toHaveAttribute('src', /^blob:/)
        await expect(card.locator('.guard-spot svg.strike')).toBeVisible()
        await expect(card.getByRole('button', { name: 'Resume' })).toBeEnabled()
        // The pill says Paused; the status line does not say it again (QA P6).
        await expect(card.getByText('Paused', { exact: true })).toHaveCount(1)
        // Check again asks the detector about a new frame (QA M7): still a hand, so the card stays as it was.
        await card.getByRole('button', { name: 'Check again' }).click()
        await sawToast(page, /There is still a hand in the new picture/)
        expect(det.looks.count).toBe(1)
        await expect(card.getByRole('heading', { name: 'Paused: a hand in the printer' })).toBeVisible()
        // The hand is gone: answered, still paused, with Resume (QA 0.2.0: the card vanished, the printer paused).
        det.looks.hand = false
        await card.getByRole('button', { name: 'Check again' }).click()
        await expect(card.getByRole('heading', { name: 'Still paused' })).toBeVisible()
        expect((await hub.admin.status('a1')).state).toBe('paused')
        await resumeFromCard(page, card, 'A1')
        await expect.poll(async () => (await hub.admin.status('a1')).state, { timeout: 20_000 }).toBe('printing')
        await expect(card).toHaveCount(0)
      } finally {
        det.close()
      }
      // A second hand, dismissed: still paused with Resume until the person resumes.
      const again = await reportHand('a1')
      try {
        expect(again.paused).toBe(true)
        const card = page.locator('.guard-card')
        await card.getByRole('button', { name: 'Dismiss, it was me' }).click()
        await expect(card.getByRole('heading', { name: 'Still paused' })).toBeVisible()
        expect((await hub.admin.status('a1')).state).toBe('paused')
        await resumeFromCard(page, card, 'A1')
        await expect.poll(async () => (await hub.admin.status('a1')).state, { timeout: 20_000 }).toBe('printing')
        await expect(card).toHaveCount(0)
      } finally {
        again.close()
      }
    } finally {
      await ctl('/bambu', { cameraFrame: null })
    }
  })

  /** A plate detector stand-in on the watch role: answers every plate check with `answer()`. */
  async function plateDetector(answer: () => { clear: boolean; box?: number[] }): Promise<{ checks: number; close(): void }> {
    const { connectLink } = await import('../../../../packages/connect/link-client/src/index.ts')
    const out = { checks: 0, close: () => undefined as void }
    class Answering extends WebSocket {
      constructor(u: string | URL) {
        super(u)
        this.addEventListener('message', (m: MessageEvent) => {
          if (typeof m.data !== 'string') return
          const msg = JSON.parse(m.data) as { event?: string; data?: { checkId: string; printerId: string } }
          if (msg.event !== 'watch.plate' || !msg.data) return
          out.checks++
          this.send(JSON.stringify({ id: 900_000 + out.checks, method: 'watch.plateResult', params: { checkId: msg.data.checkId, printerId: msg.data.printerId, note: 'test', ...answer() } }))
        })
      }
    }
    const det = await connectLink({ url: hub.linkUrl, code: hub.code, role: 'watch', WebSocket: Answering as unknown as typeof WebSocket })
    await det.watch.subscribe(() => undefined, { everyMs: 120_000, printerIds: ['a1'] })
    out.close = () => det.close()
    return out
  }

  const SPOT = [0.42, 0.5, 0.62, 0.75]

  test('the camera guard: a plate it paused waits on Resume after a clean check, and never becomes the empty plate', async ({ page }) => {
    test.slow()
    await idleAgain('a1')
    await paired(page)
    let dirty = true
    const det = await plateDetector(() => (dirty ? { clear: false, box: SPOT } : { clear: true }))
    try {
      // The printer starts a print on its own onto a dirty plate.
      await ctl('/set', { mock: 'bambu', state: 'printing' })
      const card = page.locator('.guard-card')
      await expect(card.getByRole('heading', { name: 'Paused: something on the plate' })).toBeVisible({ timeout: 30_000 })
      await expect.poll(async () => (await hub.admin.status('a1')).state, { timeout: 20_000 }).toBe('paused')
      // The empty-plate picture belongs to an empty printer: not offered here (QA 0.2.0 saved the dirty frame).
      await expect(card.getByRole('button', { name: 'This plate is clear' })).toHaveCount(0)
      // Checked again and still dirty: the same card.
      await card.getByRole('button', { name: 'Check again' }).click()
      await expect(card.getByRole('heading', { name: 'Paused: something on the plate' })).toBeVisible()
      // Cleared and checked again: still paused, with Resume (QA 0.2.0: the card vanished, the printer paused).
      dirty = false
      await card.getByRole('button', { name: 'Check again' }).click()
      await expect(card.getByRole('heading', { name: 'Still paused' })).toBeVisible()
      expect((await hub.admin.status('a1')).state).toBe('paused')
      await resumeFromCard(page, card, 'A1')
      await expect.poll(async () => (await hub.admin.status('a1')).state, { timeout: 20_000 }).toBe('printing')
      await expect(card).toHaveCount(0)
      const st = await (hub.admin as unknown as { watch: { guardState(): Promise<{ plates: Record<string, string> }> } }).watch.guardState()
      expect(st.plates, 'no empty-plate picture was taken from the flagged frame').toEqual({})
    } finally {
      det.close()
      await idleAgain('a1')
    }
  })

  test('the camera guard holds a start from the Print sheet, and It\'s fine starts it anyway', async ({ page }) => {
    test.slow()
    await idleAgain('a1')
    // A 4:3 camera with a scrap at the plate's bottom right (QA N2: spots landed off the picture on frames that are not 16:9).
    const { PLATE_4_3_FRAME } = await import('../../../../packages/connect/mock-printers/src/frames.ts')
    const frameFile = join(hub.stateDir, 'plate-4x3.jpg')
    writeFileSync(frameFile, PLATE_4_3_FRAME)
    await ctl('/bambu', { cameraFrameFile: frameFile })
    const scrap = [0.75, 0.8333, 0.85, 0.9333]
    const det = await plateDetector(() => ({ clear: false, box: scrap }))
    try {
      const sheet = await sheetOn(page, 'A1')
      const before = (await mockLog()).match(/project_file/g)?.length ?? 0
      await start(sheet)
      await sawToast(page, /something is on the plate/, { timeout: 30_000 })
      expect((await mockLog()).match(/project_file/g)?.length ?? 0, 'nothing started').toBe(before)
      const card = page.locator('.guard-card')
      await expect(card.getByRole('heading', { name: 'Something on the plate' })).toBeVisible()
      await expect(card).toContainText('Start on hold')
      // The idle printer's own line ("Plate clear, ready for a job") would contradict the card (QA N1).
      await expect(card).not.toContainText('Plate clear')
      // The whole picture shows, and the spot sits on the scrap.
      const pic = (await card.locator('img').boundingBox())!
      const spot = (await card.locator('.guard-spot').boundingBox())!
      const frame = (await card.locator('.guard-frame').boundingBox())!
      expect(pic.width / pic.height).toBeCloseTo(4 / 3, 1)
      expect(Math.abs(spot.x - (pic.x + scrap[0]! * pic.width))).toBeLessThan(2)
      expect(Math.abs(spot.y - (pic.y + scrap[1]! * pic.height))).toBeLessThan(2)
      expect(spot.y + spot.height).toBeLessThanOrEqual(frame.y + frame.height + 1)
      await card.getByRole('button', { name: "It's fine, start anyway" }).click()
      await sawToast(page, /started on A1/, { timeout: 30_000 })
      expect((await mockLog()).match(/project_file/g)?.length ?? 0).toBe(before + 1)
      await expect(card).toHaveCount(0)
    } finally {
      det.close()
      await ctl('/bambu', { cameraFrameFile: null })
      await idleAgain('a1')
    }
  })

  test('the camera guard on a printer it cannot pause alerts and says why', async ({ page }) => {
    test.slow()
    await idleAgain('a1')
    await ctl('/bambu', { developerMode: false, cameraFrame: 'hand' })
    try {
      await expect.poll(async () => (await hub.admin.status('a1')).live?.monitorOnly, { timeout: 20_000 }).toBe(true)
      await paired(page)
      await ctl('/set', { mock: 'bambu', state: 'printing' })
      await expect.poll(async () => (await hub.admin.status('a1')).state, { timeout: 20_000 }).toBe('printing')
      const det = await reportHand('a1')
      try {
        expect(det.paused).toBe(false)
        const card = page.locator('.guard-card')
        await expect(card.getByRole('heading', { name: 'Hand seen, print still running' })).toBeVisible()
        await expect(card.getByRole('note')).toContainText("can't stop this print")
        await expect(card.getByRole('note')).toContainText('Bambu Connect')
        await expect(card.getByRole('button', { name: 'Resume' })).toHaveCount(0)
      } finally {
        det.close()
      }
    } finally {
      await ctl('/bambu', { developerMode: null, cameraFrame: null })
    }
  })
})

test.describe('Snapmaker U1', () => {
  test.beforeAll(async ({}, testInfo) => {
    if (testInfo.project.use.isMobile) return
    await hub.admin.settings.set({ experimentalConnectors: true })
    await hub.admin.addPrinter({ id: 'u1', name: 'U1 Bay', plugin: 'snapmaker', protocol: 'moonraker', host: '127.0.0.1', port: hub.ports['snapmaker-u1'], pollMs: 200 }, { vendor: 'Snapmaker', model: 'U1' })
    printersChanged = true
  })

  // Not asking when everything matches is a stored preference of the shared page: put it back after each test.
  test.afterEach(async ({ page }) => {
    await patch(page, { toolheadSkipMatching: {} })
  })

  test.afterAll(async ({}, testInfo) => {
    if (testInfo.project.use.isMobile) return
    await hub.admin.removePrinter('u1')
    await hub.admin.settings.set({ experimentalConnectors: false })
    printersChanged = true
  })

  const printerActions = async () => (await logOf('snapmaker-u1')).filter((line) => line !== 'webcams list')

  test('U1 planning refuses missing material and never uploads or starts', async () => {
    const host = hub.admin as unknown as PrinterHost
    const before = await printerActions()
    const plan = await host.planToolheads!('u1', [{ tool: 0, material: 'ABS', color: '#ffffff' }])
    expect(plan.ready).toBe(false)
    expect(plan.assignments[0]?.status).toBe('unavailable')
    expect(await printerActions()).toEqual(before)
  })

  test('U1 upload-only uses the chosen loaded head without starting', async ({ page }) => {
    test.slow()
    const sheet = await sheetOn(page, 'U1 Bay')
    await expect(sheet.getByRole('group', { name: 'Choose toolheads' })).toBeVisible()
    const before = await printerActions()
    await sheet.locator('#ps-toolhead-0').selectOption('4')
    expect(await printerActions()).toEqual(before)
    await sheet.getByRole('button', { name: 'More ways to send' }).click()
    await page.getByRole('menuitemcheckbox', { name: 'Upload only', exact: true }).click()
    await sheet.getByRole('button', { name: 'Upload only', exact: true }).click()
    await sawToast(page, /It has not started/)
    const log = (await printerActions()).slice(before.length)
    expect(log.some((line) => line.startsWith('upload '))).toBe(true)
    expect(log.some((line) => line.startsWith('start ') || line.includes('SET_PRINT_EXTRUDER_MAP'))).toBe(false)
  })

  test('U1 applies and verifies the map only after the person starts', async ({ page }) => {
    test.slow()
    const sheet = await sheetOn(page, 'U1 Bay')
    await sheet.locator('#ps-toolhead-0').selectOption('4')
    const before = await printerActions()
    await start(sheet)
    await sawToast(page, /started on U1 Bay/, { timeout: 30_000 })
    const log = (await printerActions()).slice(before.length)
    const upload = log.findIndex((line) => line.startsWith('upload '))
    const mapping = log.findIndex((line) => line.includes('SET_PRINT_EXTRUDER_MAP'))
    const started = log.findIndex((line) => line.startsWith('start '))
    expect(upload).toBeGreaterThanOrEqual(0)
    expect(mapping).toBeGreaterThan(upload)
    expect(started).toBeGreaterThan(mapping)
  })
})

// Samples every frame from the drop to the end to see that nothing moves, and waits on the reconnect: nightly.
test('a dropped bridge connection comes back on its own; the cards stay in place, dimmed and off, until it does', { tag: '@nightly' }, async ({ page }) => {
  // Every connection the page opens to the hub goes through here, so the test can drop one as a suspended page would,
  // and hold the reconnect off for a while.
  let refuse = false
  // While on, the hub's answers to status requests wait here instead of reaching the page, as from slow printers: the
  // printer list's refresh is still out when the connection drops, and after the reconnect the new list waits for them.
  let holdStatus = false
  const heldStatus: (() => void)[] = []
  const routes: WebSocketRoute[] = []
  await page.routeWebSocket(hub.route, (ws) => {
    if (refuse) {
      void ws.close()
      return
    }
    const server = ws.connectToServer()
    routes.push(ws)
    const statusIds = new Set<unknown>()
    const idOf = (m: string | Buffer, method?: string): unknown => {
      if (typeof m !== 'string') return undefined
      try {
        const msg = JSON.parse(m) as { id?: unknown; method?: unknown }
        return method === undefined || msg.method === method ? msg.id : undefined
      } catch {
        return undefined
      }
    }
    ws.onMessage((m) => {
      const id = idOf(m, 'status')
      if (holdStatus && id !== undefined) statusIds.add(id)
      server.send(m)
    })
    server.onMessage((m) => {
      const id = idOf(m)
      if (id !== undefined && statusIds.delete(id)) heldStatus.push(() => ws.send(m))
      else ws.send(m)
    })
    ws.onClose(() => server.close())
  })
  await repair(page)
  holdStatus = true
  // Opening the tab refreshes the printer list; its status requests stay unanswered until the connection drops.
  await page.getByRole('button', { name: 'Printers', exact: true }).first().click()
  const card = page.getByTestId('printer-card').filter({ hasText: 'Voron' })
  await expect(card).toBeVisible()
  await expect.poll(() => heldStatus.length).toBeGreaterThan(0)
  // Where everything on the page sits: the heading's row, the counts and every card.
  const layout = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('.page.fleet .wall-h > *:not(.wall-away-note), .page.fleet .wall-counts, [data-testid="printer-card"]')].map((el) => {
        const b = el.getBoundingClientRect()
        return `${el.className || el.tagName}:${Math.round(b.x)},${Math.round(b.y)},${Math.round(b.width)},${Math.round(b.height)}`
      }),
    )
  const connected = await layout()
  const cardsBefore = await page.getByTestId('printer-card').count()
  // Every frame from the drop to the end: no card may leave and nothing may move, even for a frame.
  await page.evaluate((want) => {
    const w = window as unknown as { __cardsMin: number; __moved: string[]; __watch: boolean }
    w.__cardsMin = Infinity
    w.__moved = []
    w.__watch = true
    const tick = () => {
      if (!w.__watch) return
      w.__cardsMin = Math.min(w.__cardsMin, document.querySelectorAll('[data-testid="printer-card"]').length)
      const now = [...document.querySelectorAll('.page.fleet .wall-h > *:not(.wall-away-note), .page.fleet .wall-counts, [data-testid="printer-card"]')].map((el) => {
        const b = el.getBoundingClientRect()
        return `${el.className || el.tagName}:${Math.round(b.x)},${Math.round(b.y)},${Math.round(b.width)},${Math.round(b.height)}`
      })
      if (now.join('|') !== want.join('|') && w.__moved.length < 5) w.__moved.push(now.join('|'))
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }, connected)
  const before = routes.length
  refuse = true
  await routes.at(-1)!.close()
  await expect(page.getByTestId('bridge-reconnecting')).toBeVisible()
  await expect(card).toHaveAttribute('data-away', 'true')
  await expect(card).toContainText('Reconnecting')
  await expect(card).toContainText(/Last seen/)
  // Every control on the cards is off until the bridge is back.
  await expect(card.getByTestId('printer-card-open')).toBeDisabled()
  await expect(card.getByTestId('printer-card-options')).toBeDisabled()
  expect(await layout(), 'nothing moves while reconnecting').toEqual(connected)
  const heldBefore = heldStatus.length
  refuse = false
  // It reconnects with the code this session used, without asking again.
  await expect.poll(() => routes.length, { timeout: 30_000 }).toBeGreaterThan(before)
  await sawToast(page, /Reconnected to the printer bridge/, { timeout: 30_000 })
  await expect(page.getByTestId('bridge-reconnecting')).toHaveCount(0)
  await expect(card).not.toHaveAttribute('data-away', 'true')
  await expect(card.getByTestId('printer-card-options')).toBeEnabled()
  // The new connection's printer list is still waiting for its printers.
  await expect.poll(() => heldStatus.length, { timeout: 30_000 }).toBeGreaterThan(heldBefore)
  expect(await layout(), 'nothing moves once reconnected').toEqual(connected)
  // Then the printers answer and the cards take the new rows, in the same places.
  holdStatus = false
  for (const send of heldStatus.splice(0)) send()
  await expect(card.locator('.wall-meta')).toBeVisible()
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))
  expect(await layout(), 'nothing moves once the printers answer').toEqual(connected)
  const watched = await page.evaluate(() => {
    const w = window as unknown as { __cardsMin: number; __moved: string[]; __watch: boolean }
    w.__watch = false
    return { cardsMin: w.__cardsMin, moved: w.__moved }
  })
  expect(watched.moved, 'no frame from the drop on moves anything').toEqual([])
  expect(watched.cardsMin).toBe(cardsBefore)
})

// A send whose connection drops part way is never sent again, and says what the printer reports: bridge-reconnect.test.ts:136.

/**
 * Screenshots for review: SX_SHOTS=1, saved to SX_SHOTS_DIR (test-results/shots by default). The open Print sheet with
 * `box` in view, at 1440 and 390 px wide, dark and light; the viewport and theme are put back after.
 */
async function sheetShots(page: Page, box: Locator, name: string): Promise<void> {
  if (!process.env['SX_SHOTS']) return
  const dir = process.env['SX_SHOTS_DIR'] ?? test.info().outputPath('shots')
  const before = page.viewportSize()
  type Sx = { __sx: { getState(): { scheme: string; themeFollowsSystem: boolean }; setState(p: unknown): void } }
  const theme = await page.evaluate(() => {
    const st = (window as unknown as Sx).__sx.getState()
    return { scheme: st.scheme, themeFollowsSystem: st.themeFollowsSystem }
  })
  const setScheme = (scheme: string) => page.evaluate((s) => (window as unknown as { __sx: { setState(p: unknown): void } }).__sx.setState({ scheme: s, themeFollowsSystem: false }), scheme)
  for (const [width, height] of [[1440, 900], [390, 844]] as const) {
    await page.setViewportSize({ width, height })
    for (const scheme of ['dark', 'light'] as const) {
      await setScheme(scheme)
      await box.evaluate((el) => el.scrollIntoView({ block: 'center' }))
      await page.mouse.move(0, 0)
      await page.waitForTimeout(400)
      await page.screenshot({ path: `${dir}/print-sheet-${name}-${scheme}-${width}.png` })
    }
  }
  if (before) await page.setViewportSize(before)
  await page.evaluate((t) => (window as unknown as Sx).__sx.setState(t), theme)
}
