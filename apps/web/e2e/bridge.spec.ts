// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The app against a real sx-link and the mock printers, end to end: pair, list, camera, send with preflight and
// approval on a Klipper printer, the bridge's settings, and, in the Bambu Lab describe, the Print sheet for an A1 with
// an AMS lite and an A1 mini with only the external spool (slot choice, the .gcode.3mf start, a refused start with
// its reason and the plain G-code offer) and the camera guard. The flows every brand shares run per brand in
// prusa-bridge, elegoo-bridge and snapmaker-bridge (e2e/bridge-brands.ts); Bambu Lab is checked on real printers.
// The harness and its hub lock are in e2e/bridge-hub.ts.
import { type Page } from '@playwright/test'
import { expect, plateReady, sliceCount, sliced, test } from './fixtures'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { bridgeOn, connectApp, ctl, hub, mockLog, reportHand, resumeFromCard, sawToast, seed, sheetFor, start, useBridge } from './bridge-hub'

/** The describe the Bambu Lab printers belong to. addBambu refuses to run outside it. */
const BAMBU = 'Bambu Lab'

useBridge(['moonraker', 'bambu'], async (ctl) => {
  // The Bambu mock as an A1 with an AMS lite and white PLA on the side holder.
  await ctl('/bambu', { model: 'N2S', ams: 'lite', external: { type: 'PLA', color: '#FFFFFF' } })
  await hub.admin.addPrinter({ id: 'voron', name: 'Voron', plugin: 'moonraker', host: '127.0.0.1', port: hub.ports['moonraker'] ?? 0 }, { vendor: 'Voron', model: '2.4' })
})

/** Puts the Bambu mock back to idle and waits until the hub has seen it. */
async function idleAgain(id: string): Promise<void> {
  await ctl('/set', { mock: 'bambu', state: 'idle' })
  await expect.poll(async () => (await hub.admin.status(id)).state, { timeout: 20_000 }).toBe('idle')
}

/**
 * Adds a Bambu Lab printer on the Bambu mock. Only the Bambu Lab describe may: the flows every brand shares run on the
 * simulated brands, and a new test that reaches for Bambu by default fails here.
 */
async function addBambu(id: string, name: string, model: string): Promise<void> {
  if (!test.info().titlePath.includes(BAMBU)) throw new Error(`addBambu is for the "${BAMBU}" describe only: shared flows belong in e2e/bridge-brands.ts, on the simulated brands`)
  const { MOCK_SERIAL, MOCK_ACCESS_CODE } = await import('../../../packages/connect/mock-printers/src/bambu.ts')
  await hub.admin.setSecret(`${id}-code`, MOCK_ACCESS_CODE)
  await hub.admin.addPrinter(
    { id, name, plugin: 'bambu-lan', host: '127.0.0.1', port: hub.ports['bambu'], serial: MOCK_SERIAL, credentialRef: `${id}-code`, ftpPort: hub.ports['bambu-ftp'], cameraPort: hub.ports['bambu-camera'], pollMs: 200 },
    { vendor: 'Bambu Lab', model },
  )
}

test('pairs with the bridge and lists its printer', async ({ page }) => {
  await connectApp(page)
  await page.getByRole('button', { name: 'Printers', exact: true }).first().click()
  await expect(page.getByText('Voron').first()).toBeVisible()
})

test('printer setup asks the bridge to search the network only when Search my network is pressed', async ({ page }) => {
  // Every call the app makes on the hub, read on the way through.
  const calls: string[] = []
  await page.routeWebSocket(/127\.0\.0\.1:47615/, (ws) => {
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
  await connectApp(page)
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
    await connectApp(page)
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
    const remove = page.getByTestId('connected-app-bambuddy-remove')
    const save = page.getByTestId('connected-app-bambuddy-save')
    await expect(remove.or(save).first()).toBeVisible()
    if (await remove.isVisible()) await remove.click()
    await expect(page.getByTestId('connected-app-bambuddy-save')).toBeVisible()
    server.close()
  }
})

test('Connected apps: Home Assistant shows only with experimental connectors on, in Developer mode', async ({ page }) => {
  const { startMocks } = await import('../../../packages/connect/mock-printers/src/index.ts')
  const { MOCK_HA_TOKEN } = await import('../../../packages/connect/mock-printers/src/services.ts')
  const ha = await startMocks({ only: ['home-assistant'] })
  const apps = page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Connected apps' })
  try {
    await connectApp(page)
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await apps.click()
    // Advanced mode: no experimental switch and no Home Assistant card.
    await expect(page.getByTestId('connected-app-bambuddy')).toBeVisible()
    await expect(page.getByTestId('connected-apps-experimental')).toHaveCount(0)
    await expect(page.getByTestId('connected-app-home-assistant')).toHaveCount(0)
    await page.keyboard.press('Escape')

    // Developer mode shows the switch; turning it on shows Home Assistant, labeled Experimental.
    await page.getByTestId('slice-mode-chip').click()
    await page.getByTestId('slice-mode-chip-developer').click()
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await apps.click()
    const sw = page.getByTestId('connected-apps-experimental')
    await expect(sw).toHaveAttribute('aria-checked', 'false')
    await sw.click()
    await expect(sw).toHaveAttribute('aria-checked', 'true')
    const card = page.getByTestId('connected-app-home-assistant')
    await expect(card.getByTestId('connected-app-home-assistant-experimental')).toHaveText('Experimental')
    await card.getByTestId('connected-app-home-assistant-address').fill(`127.0.0.1:${ha.ports['home-assistant']}`)
    await card.getByTestId('connected-app-home-assistant-key').fill(MOCK_HA_TOKEN)
    await card.getByTestId('connected-app-home-assistant-save').click()
    await expect(card.getByTestId('connected-app-home-assistant-status')).toHaveText('Connected')
    await expect(card).toContainText(/\d+ (switch, light or fan|switches, lights and fans) in Home Assistant/)

    // Remove it, and turn the switch off again: the card goes away.
    await card.getByTestId('connected-app-home-assistant-remove').click()
    await expect(card.getByTestId('connected-app-home-assistant-save')).toBeVisible()
    await sw.click()
    await expect(sw).toHaveAttribute('aria-checked', 'false')
    await expect(page.getByTestId('connected-app-home-assistant')).toHaveCount(0)
  } finally {
    await ha.stop()
  }
})

test('Partner app: a named key shown once, listed in Devices, and revoking it cuts the partner off', async ({ page }) => {
  const { connectLink } = await import('../../../packages/connect/link-client/src/index.ts')
  await connectApp(page)
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

test('a wrong code is refused with a plain message', async ({ page }) => {
  await seed(page)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Printer bridge' }).click()
  await page.getByLabel('Pairing code').fill('ZZZZ9999')
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('That pairing code was not accepted.')
})

test('the camera player shows live frames from the printer', async ({ page }) => {
  await connectApp(page)
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
  await connectApp(page)
  const slices1 = await sliceCount(page)
  await page.getByRole('button', { name: 'Slice plate' }).click()
  await expect(sliced(page, slices1)).toBeVisible({ timeout: 90_000 })
  await page.keyboard.press('ControlOrMeta+k')
  await page.keyboard.type('Print the plate on Voron')
  await page.locator('.sx-palette-item', { hasText: 'Print the plate on Voron' }).first().click()
  // One Print sheet: it checks the file against the printer, and its confirm button is the approval.
  const sheet = page.locator('dialog.print-sheet[open]')
  await expect(sheet).toBeVisible()
  await expect(sheet.locator('.ps-file[data-checked]')).toBeVisible()
  const go = sheet.getByRole('button', { name: /^Bed is clear, start/ })
  // Errors from the preflight would keep the button disabled; say what they were.
  if (await go.isDisabled()) throw new Error(`Start is disabled: ${await sheet.locator('.cl-list').innerText()}`)
  await go.click()
  await sawToast(page, /started on Voron/, { timeout: 30_000 })
  expect(await mockLog()).toMatch(/\.gcode/)
})

test.describe(BAMBU, () => {
  test.beforeAll(async () => {
    await addBambu('a1', 'A1', 'A1')
  })

  test('A1 with an AMS lite: the sheet sends a .gcode.3mf from the matched slot', async ({ page }) => {
    test.slow()
    const sheet = await sheetFor(page, 'A1')
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

  test('A1: a refused start shows the reason and offers plain G-code', async ({ page }) => {
    test.slow()
    await ctl('/bambu', { refuse: 'The file could not be parsed (mock)' })
    try {
      const sheet = await sheetFor(page, 'A1')
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
      const sheet = await sheetFor(page, 'A1 mini')
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
      await ctl('/bambu', { model: 'N2S', ams: 'lite', external: { type: 'PLA', color: '#FFFFFF' } })
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
      const sheet = await sheetFor(page, 'A1')
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
    await connectApp(page)
    const { HAND_FRAME } = await import('../../../packages/connect/mock-printers/src/frames.ts')
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
    const { connectLink } = await import('../../../packages/connect/link-client/src/index.ts')
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
    await connectApp(page)
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
    const { PLATE_4_3_FRAME } = await import('../../../packages/connect/mock-printers/src/frames.ts')
    const frameFile = join(hub.stateDir, 'plate-4x3.jpg')
    writeFileSync(frameFile, PLATE_4_3_FRAME)
    await ctl('/bambu', { cameraFrameFile: frameFile })
    const scrap = [0.75, 0.8333, 0.85, 0.9333]
    const det = await plateDetector(() => ({ clear: false, box: scrap }))
    try {
      const sheet = await sheetFor(page, 'A1')
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
      await connectApp(page)
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
