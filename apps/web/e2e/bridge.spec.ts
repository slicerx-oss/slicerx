// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The app against a real sx-link and the mock printers, end to end: pair, list, camera, send with preflight
// and approval, and the Print sheet for a Bambu Lab A1 with an AMS lite and an A1 mini with only the
// external spool (slot choice, the .gcode.3mf start, a refused start with its reason and the plain
// G-code offer). Runs only when SX_LINK_BIN names a built sx-link (cargo build -p sx-link); otherwise
// skipped. The app pairs with the hub on its fixed port, so every hub test lives in this one file.
import { type Locator, type Page } from '@playwright/test'
import { command, openStudio } from './cad-helpers'
import { expect, plateReady, test } from './fixtures'
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'

const bin = process.env['SX_LINK_BIN']
test.skip(!bin, 'SX_LINK_BIN is not set')
test.describe.configure({ mode: 'serial' })
test.skip(({ isMobile }) => isMobile, 'The bridge flow runs at desktop width')

let proc: ChildProcessByStdio<null, Readable, Readable> | undefined
let stopMocks: (() => Promise<void>) | undefined
let code = ''
let linkUrl = ''
let controlPort = 0
let admin: { close(): void; addPrinter(c: unknown, i?: unknown): Promise<unknown>; setSecret(n: string, v: string): Promise<void>; status(id: string): Promise<{ state: string }> } | undefined
let ports: Record<string, number> = {}
// A throwaway state directory with file secrets: the test never touches the real hub or the keychain.
let stateDir = ''

const ctl = async (path: string, body?: unknown): Promise<Record<string, unknown>> => {
  const r = await fetch(`http://127.0.0.1:${controlPort}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return (await r.json()) as Record<string, unknown>
}
/** The Bambu mock's request log. */
const mockLog = async (): Promise<string> => JSON.stringify(await ctl('/state'))

/** Puts the Bambu mock back to idle and waits until the hub has seen it. */
async function idleAgain(id: string): Promise<void> {
  await ctl('/set', { mock: 'bambu', state: 'idle' })
  await expect.poll(async () => (await admin!.status(id)).state, { timeout: 20_000 }).toBe('idle')
}

async function addBambu(id: string, name: string, model: string): Promise<void> {
  const { MOCK_SERIAL, MOCK_ACCESS_CODE } = await import('../../../packages/connect/mock-printers/src/bambu.ts')
  await admin!.setSecret(`${id}-code`, MOCK_ACCESS_CODE)
  await admin!.addPrinter(
    { id, name, plugin: 'bambu-lan', host: '127.0.0.1', port: ports['bambu'], serial: MOCK_SERIAL, credentialRef: `${id}-code`, ftpPort: ports['bambu-ftp'], cameraPort: ports['bambu-camera'], pollMs: 200 },
    { vendor: 'Bambu Lab', model },
  )
}

test.beforeAll(async ({}, testInfo) => {
  // The phone project skips every test here; it must not start a second bridge on the same port as the desktop one.
  if (testInfo.project.use.isMobile) return
  const { startMocks } = await import('../../../packages/connect/mock-printers/src/index.ts')
  const { connectLink } = await import('../../../packages/connect/link-client/src/index.ts')
  const mocks = await startMocks({ only: ['moonraker', 'bambu'], state: 'idle', camera: true })
  stopMocks = () => mocks.stop()
  controlPort = mocks.control
  ports = mocks.ports
  // The Bambu mock as an A1 with an AMS lite and white PLA on the side holder.
  await ctl('/bambu', { model: 'N2S', ams: 'lite', external: { type: 'PLA', color: '#FFFFFF' } })
  stateDir = mkdtempSync(join(tmpdir(), 'sx-link-e2e-'))
  proc = spawn(bin!, ['--port', '47615', '--state-dir', stateDir, '--secrets', 'file', '--no-mdns'], { stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  const url = await new Promise<string>((resolve, reject) => {
    proc!.stdout.on('data', (d: Buffer) => {
      out += d.toString()
      const u = /ws:\/\/127\.0\.0\.1:\d+/.exec(out)
      const c = /pairing code: ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(out)
      if (u && c) {
        code = c[1] ?? ''
        resolve(u[0])
      }
    })
    proc!.once('exit', () => reject(new Error('sx-link exited early')))
  })
  linkUrl = url
  const link = await connectLink({ url, code })
  admin = link as unknown as typeof admin
  await link.addPrinter({ id: 'voron', name: 'Voron', plugin: 'moonraker', host: '127.0.0.1', port: mocks.ports['moonraker'] ?? 0 }, { vendor: 'Voron', model: '2.4' })
  await addBambu('a1', 'A1', 'A1')
})

test.afterAll(async () => {
  admin?.close()
  proc?.kill()
  if (stateDir) rmSync(stateDir, { recursive: true, force: true })
  await stopMocks?.()
})

async function seed(page: Page): Promise<void> {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'advanced', cadTools: true }))
  })
  await page.goto('./')
}

async function connectApp(page: Page): Promise<void> {
  await seed(page)
  await plateReady(page)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Printer bridge' }).click()
  await page.getByLabel('Pairing code').fill(code)
  await page.getByRole('button', { name: 'Connect' }).click()
  await expect(page.getByText('Connected', { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
}

test('pairs with the bridge and lists its printer', async ({ page }) => {
  await connectApp(page)
  await page.getByRole('button', { name: 'Printers', exact: true }).first().click()
  await expect(page.getByText('Voron').first()).toBeVisible()
})

test('a wrong code is refused with a plain message', async ({ page }) => {
  await seed(page)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Printer bridge' }).click()
  await page.getByLabel('Pairing code').fill('ZZZZ9999')
  await page.getByRole('button', { name: 'Connect' }).click()
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
  await page.getByRole('button', { name: 'Slice plate' }).click()
  await expect(page.locator('.sx-tab[aria-current=page]')).toContainText('Preview', { timeout: 90_000 })
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
  await expect(page.getByText(/started on Voron/)).toBeVisible({ timeout: 30_000 })
  const state = (await (await fetch(`http://127.0.0.1:${controlPort}/state`)).json()) as Record<string, unknown>
  expect(JSON.stringify(state)).toMatch(/\.gcode/)
})

/** Pairs the app, puts one 20 mm box on the plate for `printer`, slices, and opens the Print sheet. */
async function sheetFor(page: Page, printer: string): Promise<Locator> {
  await openStudio(page)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Printer bridge' }).click()
  await page.getByLabel('Pairing code').fill(code)
  await page.getByRole('button', { name: 'Connect' }).click()
  await expect(page.getByText('Connected', { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Change', exact: true }).click()
  await page.getByRole('list', { name: 'Choose a printer' }).getByRole('button', { name: new RegExp(`^${printer}\\b`) }).first().click()
  await page.evaluate(() => (window as unknown as { __sx: { setState(p: unknown): void } }).__sx.setState({ plate: [], selection: null, selectedIds: [] }))
  await command(page, 'Add a box')
  await page.getByRole('button', { name: 'Slice plate' }).click()
  await expect(page.locator('.sx-tab[aria-current=page]')).toContainText('Preview', { timeout: 120_000 })
  await command(page, `Print the plate on ${printer}`)
  const sheet = page.locator('dialog.print-sheet[open]')
  await expect(sheet).toBeVisible()
  await expect(sheet.locator('.ps-file[data-checked]')).toBeVisible({ timeout: 30_000 })
  return sheet
}

async function start(sheet: Locator): Promise<void> {
  const go = sheet.getByRole('button', { name: /^Bed is clear, start|^Start (print|anyway)/ })
  if (await go.isDisabled()) throw new Error(`Start is disabled: ${await sheet.innerText()}`)
  await go.click()
}

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
  await expect(page.getByText(/started on A1/)).toBeVisible({ timeout: 30_000 })
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
    await expect(again).toContainText('A1 did not start the print. It said:', { timeout: 30_000 }).catch(async (e: unknown) => {
      const app = await page.evaluate(() => JSON.stringify((window as unknown as { __sx: { getState(): { toast: unknown } } }).__sx.getState().toast))
      throw new Error(`${String(e).slice(0, 300)}\napp toast: ${app}\nmock log: ${(await mockLog()).slice(-600)}`)
    })
    await expect(again).toContainText('The file could not be parsed (mock)')
    const plain = again.getByRole('button', { name: 'Send as plain G-code' })
    await expect(plain).toBeEnabled()
    await ctl('/bambu', { refuse: null })
    await plain.click()
    await expect(page.getByText(/started on A1/)).toBeVisible({ timeout: 30_000 })
    const log = await mockLog()
    expect(log).toMatch(/project_file refused/)
    expect(log).toMatch(/gcode_file|\.gcode\\"/)
  } finally {
    await ctl('/bambu', { refuse: null })
    await idleAgain('a1')
  }
})

test('A1 mini with the external spool only: filament 1 goes to the external spool', async ({ page }) => {
  test.slow()
  await ctl('/bambu', { model: 'N1', ams: 'none', external: { type: 'PLA', color: '#FFFFFF' } })
  await addBambu('a1mini', 'A1 mini', 'A1 mini')
  const sheet = await sheetFor(page, 'A1 mini')
  await expect(sheet.locator('.ps-fil').first()).toContainText('External spool')
  const slot = sheet.locator('#ps-map-1')
  if (await slot.count()) {
    const opts = (await slot.locator('option').allTextContents()).map((o) => o.trim())
    expect(opts.filter((o) => /^A\d/.test(o))).toEqual([])
  }
  await start(sheet)
  await expect(page.getByText(/started on A1 mini/)).toBeVisible({ timeout: 30_000 })
  const log = await mockLog()
  // The external spool is tray 254 (vt_tray).
  expect(log).toMatch(/project_file[^\n]*ams_mapping\\":\[254\]|ams_mapping\\":\[-1\]|use_ams\\":false/)
})

test('A1 with Developer Mode off: status keeps coming, and Print saves the file for Bambu Connect', async ({ page }) => {
  test.slow()
  await idleAgain('a1')
  await ctl('/bambu', { model: 'N2S', ams: 'lite', external: { type: 'PLA', color: '#FFFFFF' }, developerMode: false })
  try {
    // The printer still connects and reports; it is monitor-only, never a failed connection.
    await expect.poll(async () => ((await admin!.status('a1')) as { state: string; live?: { monitorOnly?: boolean } }).live?.monitorOnly, { timeout: 20_000 }).toBe(true)
    expect((await admin!.status('a1')).state).toBe('idle')
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
    await expect(page.getByText(/Open it in Bambu Connect and press Print there/)).toBeVisible()
    // Nothing went to the printer: no upload, no start, nothing it had to refuse.
    expect(await logs()).toEqual(before)
  } finally {
    await ctl('/bambu', { developerMode: null })
  }
})

/** A failure detector stand-in on the watch role: takes one frame of the printer, then reports a hand on it. */
async function reportHand(printerId: string): Promise<{ frame: Uint8Array; paused: boolean; looks: { hand: boolean; count: number }; close(): void }> {
  const { connectLink } = await import('../../../packages/connect/link-client/src/index.ts')
  // It also answers Check again (`watch.look`): a hand while `looks.hand` is set.
  const looks = { hand: true, count: 0 }
  class Looking extends WebSocket {
    constructor(u: string | URL) {
      super(u)
      this.addEventListener('message', (m: MessageEvent) => {
        if (typeof m.data !== 'string') return
        const msg = JSON.parse(m.data) as { event?: string; data?: { checkId: string; printerId: string } }
        if (msg.event !== 'watch.look' || !msg.data) return
        looks.count++
        this.send(JSON.stringify({ id: 800_000 + looks.count, method: 'watch.lookResult', params: { checkId: msg.data.checkId, printerId: msg.data.printerId, hand: looks.hand } }))
      })
    }
  }
  const det = await connectLink({ url: linkUrl, code, role: 'watch', WebSocket: Looking as unknown as typeof WebSocket })
  const frame = await new Promise<Uint8Array>((resolve) => {
    void det.watch.subscribe((f) => f.printerId === printerId && resolve(f.data), { everyMs: 2000, printerIds: [printerId] })
  })
  const { paused } = await det.watch.report({ printerId, kind: 'hand', confidence: 0.88, box: [0.06, 0.55, 0.4, 0.98], note: '2 of the last 3 frames, siglip2-base-224' })
  return { frame, paused, looks, close: () => det.close() }
}

test('the camera guard pauses for a hand and brings its card up on Printers', async ({ page }) => {
  test.slow()
  await idleAgain('a1')
  await connectApp(page)
  const { HAND_FRAME } = await import('../../../packages/connect/mock-printers/src/frames.ts')
  await ctl('/bambu', { cameraFrame: 'hand' })
  await ctl('/set', { mock: 'bambu', state: 'printing' })
  try {
    await expect.poll(async () => (await admin!.status('a1')).state, { timeout: 20_000 }).toBe('printing')
    const det = await reportHand('a1')
    try {
      expect(Buffer.from(det.frame).equals(HAND_FRAME), 'the detector got the hand frame').toBe(true)
      expect(det.paused).toBe(true)
      expect(await mockLog()).toMatch(/pause/)
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
      await expect(page.getByText('There is still a hand in the new picture')).toBeVisible()
      expect(det.looks.count).toBe(1)
      await expect(card.getByRole('heading', { name: 'Paused: a hand in the printer' })).toBeVisible()
      // The hand is gone: answered, still paused, with Resume (QA 0.2.0: the card vanished, the printer paused).
      det.looks.hand = false
      await card.getByRole('button', { name: 'Check again' }).click()
      await expect(card.getByRole('heading', { name: 'Still paused' })).toBeVisible()
      expect((await admin!.status('a1')).state).toBe('paused')
      await resumeFromCard(page, card)
      await expect.poll(async () => (await admin!.status('a1')).state, { timeout: 20_000 }).toBe('printing')
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
      expect((await admin!.status('a1')).state).toBe('paused')
      await resumeFromCard(page, card)
      await expect.poll(async () => (await admin!.status('a1')).state, { timeout: 20_000 }).toBe('printing')
      await expect(card).toHaveCount(0)
    } finally {
      again.close()
    }
  } finally {
    await ctl('/bambu', { cameraFrame: null })
  }
})

/** Resume on the guard card. The click is the approval: no second card opens (QA M9). */
async function resumeFromCard(page: Page, card: Locator): Promise<void> {
  await card.getByRole('button', { name: 'Resume' }).click()
  await expect(page.getByText(/Resumed on A1/)).toBeVisible()
  await expect(page.locator('dialog.approve-dialog[open]')).toHaveCount(0)
}

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
  const det = await connectLink({ url: linkUrl, code, role: 'watch', WebSocket: Answering as unknown as typeof WebSocket })
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
    await expect.poll(async () => (await admin!.status('a1')).state, { timeout: 20_000 }).toBe('paused')
    // The empty-plate picture belongs to an empty printer: not offered here (QA 0.2.0 saved the dirty frame).
    await expect(card.getByRole('button', { name: 'This plate is clear' })).toHaveCount(0)
    // Checked again and still dirty: the same card.
    await card.getByRole('button', { name: 'Check again' }).click()
    await expect(card.getByRole('heading', { name: 'Paused: something on the plate' })).toBeVisible()
    // Cleared and checked again: still paused, with Resume (QA 0.2.0: the card vanished, the printer paused).
    dirty = false
    await card.getByRole('button', { name: 'Check again' }).click()
    await expect(card.getByRole('heading', { name: 'Still paused' })).toBeVisible()
    expect((await admin!.status('a1')).state).toBe('paused')
    await resumeFromCard(page, card)
    await expect.poll(async () => (await admin!.status('a1')).state, { timeout: 20_000 }).toBe('printing')
    await expect(card).toHaveCount(0)
    const st = (await (admin as unknown as { watch: { guardState(): Promise<{ plates: Record<string, string> }> } }).watch.guardState())
    expect(st.plates, 'no empty-plate picture was taken from the flagged frame').toEqual({})
  } finally {
    det.close()
    await idleAgain('a1')
  }
})

test('the camera guard holds a start from the Print sheet, and It\'s fine starts it anyway', async ({ page }) => {
  test.slow()
  await idleAgain('a1')
  const det = await plateDetector(() => ({ clear: false, box: SPOT }))
  try {
    const sheet = await sheetFor(page, 'A1')
    const before = (await mockLog()).match(/project_file/g)?.length ?? 0
    await start(sheet)
    await expect(page.getByText(/something is on the plate/)).toBeVisible({ timeout: 30_000 })
    expect((await mockLog()).match(/project_file/g)?.length ?? 0, 'nothing started').toBe(before)
    const card = page.locator('.guard-card')
    await expect(card.getByRole('heading', { name: 'Something on the plate' })).toBeVisible()
    await expect(card).toContainText('Start on hold')
    await card.getByRole('button', { name: "It's fine, start anyway" }).click()
    await expect(page.getByText(/started on A1/)).toBeVisible({ timeout: 30_000 })
    expect((await mockLog()).match(/project_file/g)?.length ?? 0).toBe(before + 1)
    await expect(card).toHaveCount(0)
  } finally {
    det.close()
    await idleAgain('a1')
  }
})

test('the camera guard on a printer it cannot pause alerts and says why', async ({ page }) => {
  test.slow()
  await idleAgain('a1')
  await ctl('/bambu', { developerMode: false, cameraFrame: 'hand' })
  try {
    await expect.poll(async () => ((await admin!.status('a1')) as { live?: { monitorOnly?: boolean } }).live?.monitorOnly, { timeout: 20_000 }).toBe(true)
    await connectApp(page)
    await ctl('/set', { mock: 'bambu', state: 'printing' })
    await expect.poll(async () => (await admin!.status('a1')).state, { timeout: 20_000 }).toBe('printing')
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
