// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The bridge flows every brand shares, run against the simulated printers of packages/connect/mock-printers: pair and
// list, a sliced plate sent through the preflight and the approval, the card's live progress, pause, resume and
// cancel from the card, the camera guard's hand pause, the faults the brand reports, and a partner app that reads
// and approves nothing. One spec file per brand calls `brandFile` (prusa-bridge, elegoo-bridge, snapmaker-bridge),
// so the shards can spread them. Bambu Lab is checked on real printers; its own flows stay in bridge.spec.ts.
import { type Locator, type Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { connectApp, ctl, hub, logOf, reportHand, resumeFromCard, sawToast, sheetFor, start, toastsWith, useBridge } from './bridge-hub'
import type { MockName } from '../../../packages/connect/mock-printers/src/index.ts'

/** One simulated printer: how the hub adds it, its mock, and what it can show. */
export interface BrandPrinter {
  /** The describe's title. */
  title: string
  id: string
  /** The name the app shows. Unique on the plate's printer list, so `^name` picks it. */
  name: string
  vendor: string
  model: string
  mock: MockName
  /** Adds the printer to the hub. */
  add(): Promise<void>
  /** It has a camera the guard can watch. */
  camera: boolean
  /** What the card's line says after a runout; null when the printer only reports a pause. */
  runout: string | null
  /** What the live view's alert strip says while the door is open; null when the printer reports no door. */
  door: string | null
}

const local = '127.0.0.1'

export const PRINTERS = {
  prusa: {
    title: 'Prusa Core One on PrusaLink',
    id: 'coreone',
    name: 'Prusa Bay',
    vendor: 'Prusa',
    model: 'Core One',
    mock: 'prusalink',
    async add() {
      await hub.admin.setSecret('coreone-pass', 'mock-digest-pass')
      await hub.admin.addPrinter({ id: this.id, name: this.name, plugin: 'prusalink', host: local, port: hub.ports['prusalink'], credentialRef: 'coreone-pass', pollMs: 200 }, { vendor: this.vendor, model: this.model })
    },
    camera: true,
    // PrusaLink reports a runout as ATTENTION; the connector words it.
    runout: 'Printer needs attention',
    door: null,
  },
  elegoo: {
    title: 'Elegoo Centauri Carbon on SDCP',
    id: 'centauri',
    name: 'Elegoo Bay',
    vendor: 'Elegoo',
    model: 'Centauri Carbon',
    mock: 'elegoo',
    async add() {
      await hub.admin.addPrinter({ id: this.id, name: this.name, plugin: 'elegoo', host: local, port: hub.ports['elegoo'] }, { vendor: this.vendor, model: this.model })
    },
    camera: true,
    // SDCP V3.0.0 has no runout or door code: the mock pauses for a runout and ignores the door, so this checks only
    // what the app does with a pause.
    runout: null,
    door: null,
  },
  snapmaker: {
    title: 'Snapmaker A350 on the Snapmaker 2.0 API',
    id: 'a350',
    name: 'Snapmaker Bay',
    vendor: 'Snapmaker',
    model: 'A350',
    mock: 'snapmaker-luban',
    async add() {
      // Paired already: the mock confirms a token after two status polls, as a tap on the touchscreen does.
      const base = `http://${local}:${hub.ports['snapmaker-luban']}`
      const { token } = (await (await fetch(`${base}/api/v1/connect`, { method: 'POST' })).json()) as { token: string }
      for (let i = 0; i < 2; i++) await fetch(`${base}/api/v1/status?token=${token}`)
      await hub.admin.setSecret('a350-token', token)
      await hub.admin.addPrinter({ id: this.id, name: this.name, plugin: 'snapmaker', protocol: 'luban', host: local, port: hub.ports['snapmaker-luban'], credentialRef: 'a350-token', pollMs: 200 }, { vendor: this.vendor, model: this.model })
    },
    camera: false,
    runout: 'Filament ran out',
    door: 'Enclosure door is open',
  },
  'snapmaker-u1': {
    title: 'Snapmaker U1 on Moonraker',
    id: 'u1',
    name: 'U1 Bay',
    vendor: 'Snapmaker',
    model: 'U1',
    mock: 'snapmaker-u1',
    async add() {
      await hub.admin.addPrinter({ id: this.id, name: this.name, plugin: 'snapmaker', protocol: 'moonraker', host: local, port: hub.ports['snapmaker-u1'], pollMs: 200 }, { vendor: this.vendor, model: this.model })
    },
    camera: true,
    runout: null,
    door: null,
  },
} satisfies Record<string, BrandPrinter>

/** Opens the Printers tab. */
async function printersTab(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Printers', exact: true }).first().click()
  await expect(page.getByRole('heading', { name: 'Printers', exact: true })).toBeVisible()
}

/** `p`'s tile on the Printers tab, by its pill: `Printing`, `Needs you`, `Offline` and so on. */
const tile = (page: Page, p: BrandPrinter, pill?: string): Locator => page.getByRole('article', { name: pill ? `${p.name}, ${pill}` : new RegExp(`^${p.name}, `) })

/** Opens `p`'s live view from its tile. */
async function liveView(page: Page, p: BrandPrinter): Promise<Locator> {
  await printersTab(page)
  await tile(page, p).getByRole('button', { name: p.name, exact: true }).click()
  const view = page.getByRole('region', { name: `${p.name} live view` })
  await expect(view).toBeVisible()
  return view
}

/** Presses `button` in the live view, approves the card it raises, and waits for the toast. */
async function control(page: Page, view: Locator, button: string, toast: string, p: BrandPrinter): Promise<void> {
  const said = new RegExp(`${toast} on ${p.name}`)
  const before = await toastsWith(page, said)
  await view.getByRole('button', { name: button, exact: true }).click()
  const approve = page.locator('dialog.approve-dialog[open]')
  await expect(approve).toBeVisible()
  await approve.getByRole('button', { name: 'Approve' }).click()
  await sawToast(page, said, { after: before })
}

/** How many lines of the mock's log are exactly `line`. */
const count = async (mock: string, line: string) => (await logOf(mock)).filter((l) => l === line).length

/** Waits until the hub reads `p` in `state`. */
const hubSees = (p: BrandPrinter, state: string) => expect.poll(async () => (await hub.admin.status(p.id)).state, { message: `${p.name} reads ${state}`, timeout: 30_000 }).toBe(state)

/**
 * Sets up one brand's spec file: its mocks and printers on a hub of its own, then the shared flows on `main`, and
 * the camera guard's trip on `camera` when the main printer has no camera.
 */
export function brandFile(main: BrandPrinter, camera?: BrandPrinter): void {
  const printers = camera ? [main, camera] : [main]
  useBridge(
    printers.map((p) => p.mock),
    async () => {
      // Connectors not checked on a real printer yet stay hidden unless experimental connectors are on.
      await hub.admin.settings.set({ experimentalConnectors: true })
      for (const p of printers) await p.add()
    },
  )
  test.describe(main.title, () => flows(main))
  if (camera) test.describe(camera.title, () => cameraTrip(camera))
}

function flows(p: BrandPrinter): void {
  test('pairs with the bridge and lists the printer', async ({ page }) => {
    await connectApp(page)
    await printersTab(page)
    await expect(tile(page, p, 'Ready')).toBeVisible({ timeout: 30_000 })
  })

  // Checked while the printer is idle, the only time an empty-plate picture could be taken.
  if (!p.camera) {
    test('the camera guard shows as unavailable on a printer with no camera, never armed', async ({ page }) => {
      await connectApp(page)
      await printersTab(page)
      const card = tile(page, p, 'Ready')
      await expect(card).toContainText('No camera')
      // No empty-plate picture to take, and the hub refuses one.
      await card.getByRole('button', { name: `${p.name} options` }).click()
      const menu = page.getByRole('menu', { name: `${p.name} options` })
      await expect(menu).toBeVisible()
      await expect(menu.getByRole('menuitem', { name: /This plate is clear|Take the empty plate again/ })).toHaveCount(0)
      await page.keyboard.press('Escape')
      const watch = (hub.admin as unknown as { watch: { plateClear(id: string): Promise<unknown> } }).watch
      await expect(watch.plateClear(p.id)).rejects.toThrow(/no camera/)
      // The live view says it in words.
      await expect((await liveView(page, p)).getByTestId('ph-placeholder')).toContainText('This printer has no camera.')
    })
  }

  test('sends a sliced plate through the preflight and the approval, and the printer gets the file, then the start', async ({ page }) => {
    test.slow()
    // The file the app hands the hub, read on the way through: the printer must get these very bytes.
    const sent: string[] = []
    await page.routeWebSocket(/127\.0\.0\.1:47615/, (ws) => {
      const server = ws.connectToServer()
      ws.onMessage((m) => {
        if (typeof m === 'string') {
          try {
            const params = (JSON.parse(m) as { params?: { file?: { sha256?: string }; work?: { file?: { sha256?: string } } } }).params
            const sha = params?.file?.sha256 ?? params?.work?.file?.sha256
            if (sha) sent.push(sha)
          } catch {
            // Not a call: the handshake.
          }
        }
        server.send(m)
      })
    })
    const sheet = await sheetFor(page, p.name)
    await start(sheet)
    await sawToast(page, new RegExp(`started on ${p.name}`), { timeout: 30_000 })
    const log = await logOf(p.mock)
    const upload = log.findIndex((l) => l.startsWith('upload '))
    const started = log.findIndex((l) => l.startsWith('start '))
    expect(upload, `the printer got a file: ${log.join(' | ')}`).toBeGreaterThanOrEqual(0)
    expect(started, 'and then the start').toBeGreaterThan(upload)
    // "upload <name> <size> <sha256>", and the name may have spaces.
    const words = log[upload]!.split(' ')
    const sha = words.at(-1)
    const name = words.slice(1, -2).join(' ')
    expect(sent, 'the bytes the app sent are the bytes the printer got').toContain(sha)
    expect(log[started]).toBe(`start ${name}`)
    await hubSees(p, 'printing')
  })

  test('the card shows the print moving', async ({ page }) => {
    await connectApp(page)
    await printersTab(page)
    const bar = tile(page, p, 'Printing').getByRole('progressbar', { name: `${p.name} progress` })
    await expect(bar).toHaveAttribute('aria-valuenow', '0', { timeout: 30_000 })
    await ctl('/tick', { mock: p.mock, seconds: 900 })
    await expect(bar).toHaveAttribute('aria-valuenow', '25', { timeout: 30_000 })
    await ctl('/tick', { mock: p.mock, seconds: 900 })
    await expect(bar).toHaveAttribute('aria-valuenow', '50', { timeout: 30_000 })
    await expect(tile(page, p, 'Printing')).toContainText('30 min left')
  })

  test('pause and resume from the card, each approved, reach the printer', async ({ page }) => {
    await connectApp(page)
    const view = await liveView(page, p)
    const paused = await count(p.mock, 'pause')
    await control(page, view, 'Pause', 'Paused', p)
    await expect.poll(() => count(p.mock, 'pause'), { message: 'the printer got the pause', timeout: 20_000 }).toBe(paused + 1)
    await hubSees(p, 'paused')
    const resumed = await count(p.mock, 'resume')
    await control(page, view, 'Resume', 'Resumed', p)
    await expect.poll(() => count(p.mock, 'resume'), { message: 'the printer got the resume', timeout: 20_000 }).toBe(resumed + 1)
    await hubSees(p, 'printing')
  })

  if (p.camera) {
    test('the camera guard pauses for a hand, brings its card up on Printers, and Resume works', async ({ page }) => {
      test.slow()
      await connectApp(page)
      await guardTrip(page, p)
    })
  }

  test('a runout, an open door and dropping off the network show on the card and clear', async ({ page }) => {
    test.slow()
    await connectApp(page)
    await printersTab(page)
    // A runout pauses the print, and the card asks for the person.
    await ctl('/fault', { mock: p.mock, kind: 'runout' })
    await hubSees(p, 'paused')
    const needs = tile(page, p, 'Needs you')
    await expect(needs).toBeVisible({ timeout: 30_000 })
    if (p.runout) await expect(needs.locator('.wall-line')).toContainText(p.runout)
    else await expect(needs.locator('.wall-line')).toContainText(/^Paused/)
    // Cleared, the print waits for a resume, as on the printer.
    await ctl('/fault', { mock: p.mock, kind: 'clear' })
    await expect(needs).toBeVisible()
    const view = await liveView(page, p)
    await control(page, view, 'Resume', 'Resumed', p)
    await hubSees(p, 'printing')
    // The door: the alert strip says so where the printer reports one; elsewhere nothing changes.
    await ctl('/fault', { mock: p.mock, kind: 'door' })
    if (p.door) await expect(view.locator('.ph-alert')).toContainText(p.door, { timeout: 30_000 })
    else {
      await expect(view.locator('.ph-alert')).toHaveCount(0)
      expect((await hub.admin.status(p.id)).state).toBe('printing')
    }
    await ctl('/fault', { mock: p.mock, kind: 'clear' })
    if (p.door) await expect(view.locator('.ph-alert')).toHaveCount(0, { timeout: 30_000 })
    await view.getByRole('button', { name: 'Back to all printers' }).click()
    // Off the network: Offline and Not reachable, then back on its own once it answers again.
    await ctl('/fault', { mock: p.mock, kind: 'offline' })
    const off = tile(page, p, 'Offline')
    await expect(off).toBeVisible({ timeout: 45_000 })
    await expect(off.locator('.wall-line')).toHaveText('Not reachable')
    await ctl('/fault', { mock: p.mock, kind: 'clear' })
    await expect(tile(page, p, 'Printing')).toBeVisible({ timeout: 45_000 })
    const log = await logOf(p.mock)
    for (const line of ['fault runout', 'fault door', 'fault offline', 'fault clear']) expect(log).toContain(line)
  })

  test('cancel from the card, approved, stops the print', async ({ page }) => {
    await connectApp(page)
    const view = await liveView(page, p)
    const cancels = await count(p.mock, 'cancel')
    await control(page, view, 'Stop', 'Canceled', p)
    await expect.poll(() => count(p.mock, 'cancel'), { message: 'the printer got the cancel', timeout: 20_000 }).toBe(cancels + 1)
    await expect.poll(async () => (await hub.admin.status(p.id)).state, { timeout: 30_000 }).toMatch(/^(idle|finished)$/)
  })

  test('a partner app reads the printer and approves nothing', async () => {
    const { connectLink } = await import('../../../packages/connect/link-client/src/index.ts')
    const { clientKey } = await hub.admin.clients.create(`${p.name} partner`, 'agent', { partner: true })
    const partner = await connectLink({ url: hub.linkUrl, clientKey: clientKey!, hubKey: hub.admin.hubKey })
    try {
      expect(partner.partner).toBe(true)
      expect((await partner.list()).map((x) => x.id)).toContain(p.id)
      expect((await partner.status(p.id)).state).toMatch(/^(idle|finished)$/)
      await expect(partner.approvals.grant('nothing')).rejects.toThrow(/partner|person|forbidden/i)
      // A command needs a person's approval, which a partner cannot give itself: the printer hears nothing.
      const before = await logOf(p.mock)
      await expect(partner.pause(p.id, { requestId: 'r', token: 'forged', expiresAt: '' })).rejects.toThrow()
      expect(await logOf(p.mock)).toEqual(before)
    } finally {
      partner.close()
    }
  })
}

/** The hand trip: the hand frame reaches the detector, the hub pauses, the card comes up, and Resume resumes. */
async function guardTrip(page: Page, p: BrandPrinter): Promise<void> {
  const { HAND_FRAME } = await import('../../../packages/connect/mock-printers/src/frames.ts')
  await ctl('/camera', { mock: p.mock, frame: 'hand' })
  const pauses = await count(p.mock, 'pause')
  try {
    const det = await reportHand(p.id)
    try {
      expect(Buffer.from(det.frame).equals(HAND_FRAME), 'the detector got the hand frame').toBe(true)
      expect(det.paused).toBe(true)
      await expect.poll(() => count(p.mock, 'pause'), { message: 'the printer got the pause', timeout: 20_000 }).toBe(pauses + 1)
      const card = page.locator('.guard-card')
      await expect(card.getByRole('heading', { name: 'Paused: a hand in the printer' })).toBeVisible()
      await expect(card.getByRole('button', { name: 'Resume' })).toBeEnabled()
      const resumes = await count(p.mock, 'resume')
      await resumeFromCard(page, card, p.name)
      await expect.poll(() => count(p.mock, 'resume'), { message: 'the printer got the resume', timeout: 20_000 }).toBe(resumes + 1)
      await hubSees(p, 'printing')
      await expect(card).toHaveCount(0)
    } finally {
      det.close()
    }
  } finally {
    await ctl('/camera', { mock: p.mock, frame: 'placeholder' })
  }
}

/** A second printer of the brand that has the camera the main one lacks: listed, then the hand trip on a print it started. */
function cameraTrip(p: BrandPrinter): void {
  test('lists the printer with its camera', async ({ page }) => {
    await connectApp(page)
    await printersTab(page)
    await expect(tile(page, p, 'Ready')).toBeVisible({ timeout: 30_000 })
    await expect(tile(page, p)).not.toContainText('No camera')
  })

  test('the camera guard pauses for a hand, brings its card up on Printers, and Resume works', async ({ page }) => {
    test.slow()
    await connectApp(page)
    // A print the printer started on its own.
    await ctl('/set', { mock: p.mock, state: 'printing' })
    await hubSees(p, 'printing')
    try {
      await guardTrip(page, p)
    } finally {
      await ctl('/set', { mock: p.mock, state: 'idle' })
    }
  })
}
