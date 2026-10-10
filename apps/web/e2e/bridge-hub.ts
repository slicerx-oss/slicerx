// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The harness every bridge spec shares: a real sx-link with throwaway state, the mock printers it reaches, and the
// app paired with it. Runs only when SX_LINK_BIN names a built sx-link (cargo build -p sx-link); otherwise skipped.
// CI builds it and sets SX_LINK_REQUIRE=1, and there a missing binary fails the tests instead.
//
// The app pairs with the hub on its fixed port, 47615, with no way to name another, so two bridge files must never
// run at once on one machine: each file holds HUB_LOCK while its hub runs. A worker that waits for it gives up after
// HUB_LOCK_WAIT_MS with a message that names the holder.
import { type Locator, type Page } from '@playwright/test'
import { command, openStudio } from './cad-helpers'
import { expect, plateReady, sliceCount, sliced, test } from './fixtures'
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import type { MockName } from '../../../packages/connect/mock-printers/src/index.ts'

export const HUB_PORT = 47615
const HUB_LOCK = join(tmpdir(), `sx-e2e-hub-${HUB_PORT}.lock`)
const HUB_LOCK_WAIT_MS = 10 * 60_000

const bin = process.env['SX_LINK_BIN']
const required = process.env['SX_LINK_REQUIRE'] === '1'

/** The hub methods the specs call as the person, through the admin connection. */
export interface Admin {
  close(): void
  hubKey: string
  addPrinter(c: unknown, i?: unknown): Promise<unknown>
  removePrinter(id: string): Promise<void>
  setSecret(n: string, v: string): Promise<void>
  status(id: string): Promise<{ state: string; message?: string; live?: { monitorOnly?: boolean } }>
  settings: { set(s: Record<string, unknown>): Promise<unknown> }
  clients: { create(name: string, role: 'agent' | 'watch', opts?: { partner?: boolean }): Promise<{ clientKey?: string }> }
}

/** What a running bridge file has: the pairing code, the hub's address, the mocks' ports and control port. */
export const hub = { code: '', linkUrl: '', controlPort: 0, ports: {} as Record<string, number>, stateDir: '', admin: undefined as unknown as Admin }

/** Takes the hub port's lock for this worker, clearing one whose holder has died. */
async function takeHubLock(): Promise<void> {
  const owner = join(HUB_LOCK, 'pid')
  const until = Date.now() + HUB_LOCK_WAIT_MS
  for (;;) {
    try {
      mkdirSync(HUB_LOCK)
      writeFileSync(owner, String(process.pid))
      return
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
    let holder = 0
    try {
      holder = Number(readFileSync(owner, 'utf8'))
    } catch {
      // the holder is between its mkdir and its pid file; look again
    }
    if (holder && !alive(holder)) rmSync(HUB_LOCK, { recursive: true, force: true })
    else if (Date.now() > until) throw new Error(`waited ${HUB_LOCK_WAIT_MS / 60_000} minutes for the bridge hub port ${HUB_PORT}: ${HUB_LOCK} is held by process ${holder || 'unknown'}`)
    else await new Promise((r) => setTimeout(r, 500))
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function dropHubLock(): void {
  try {
    if (Number(readFileSync(join(HUB_LOCK, 'pid'), 'utf8')) === process.pid) rmSync(HUB_LOCK, { recursive: true, force: true })
  } catch {
    // not ours, or gone already
  }
}

/**
 * Sets up a bridge file: serial tests at desktop width, the mocks in `mocks` started once for the file (idle, every
 * printer with a camera), a hub on HUB_PORT, and `setup` to add the file's printers. Call at the top of the file.
 */
export function useBridge(mocks: MockName[], setup: (ctl: Ctl) => Promise<void>): void {
  let proc: ChildProcessByStdio<null, Readable, Readable> | undefined
  let stopMocks: (() => Promise<void>) | undefined
  test.skip(!bin && !required, 'SX_LINK_BIN is not set')
  test.describe.configure({ mode: 'serial' })
  test.skip(({ isMobile }) => isMobile, 'The bridge flow runs at desktop width')

  test.beforeAll(async ({}, testInfo) => {
    // The phone project skips every test here; it must not start a second bridge on the same port as the desktop one.
    if (testInfo.project.use.isMobile) return
    if (!bin || !existsSync(bin)) throw new Error(`There is no sx-link at ${bin || '(SX_LINK_BIN is not set)'}: build it (cargo build -p sx-link) and name it in SX_LINK_BIN`)
    testInfo.setTimeout(testInfo.timeout + HUB_LOCK_WAIT_MS)
    await takeHubLock()
    const { startMocks } = await import('../../../packages/connect/mock-printers/src/index.ts')
    const { connectLink } = await import('../../../packages/connect/link-client/src/index.ts')
    const running = await startMocks({ only: mocks, state: 'idle', camera: true })
    stopMocks = () => running.stop()
    hub.controlPort = running.control
    hub.ports = running.ports
    // A throwaway state directory with file secrets: the test never touches the real hub or the keychain.
    hub.stateDir = mkdtempSync(join(tmpdir(), 'sx-link-e2e-'))
    proc = spawn(bin, ['--port', String(HUB_PORT), '--state-dir', hub.stateDir, '--secrets', 'file', '--no-mdns', ...(process.env['SX_TEST_LAN'] === '1' ? [] : ['--loopback'])], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    hub.linkUrl = await new Promise<string>((resolve, reject) => {
      proc!.stdout.on('data', (d: Buffer) => {
        out += d.toString()
        const u = /ws:\/\/127\.0\.0\.1:\d+/.exec(out)
        const c = /pairing code: ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(out)
        if (u && c) {
          hub.code = c[1] ?? ''
          resolve(u[0])
        }
      })
      proc!.once('exit', () => reject(new Error('sx-link exited early')))
    })
    hub.admin = (await connectLink({ url: hub.linkUrl, code: hub.code })) as unknown as Admin
    await setup(ctl)
  })

  test.afterAll(async () => {
    hub.admin?.close()
    // Gone before the mocks stop, so no connection of its own keeps a mock open; a hub that ignores the signal is
    // killed outright after 10 s.
    if (proc && proc.exitCode === null && proc.signalCode === null) {
      const p = proc
      const exited = new Promise<void>((r) => p.once('exit', () => r()))
      p.kill()
      const late = setTimeout(() => p.kill('SIGKILL'), 10_000)
      await exited
      clearTimeout(late)
    }
    if (hub.stateDir) rmSync(hub.stateDir, { recursive: true, force: true })
    await stopMocks?.()
    dropHubLock()
  })

  // Every toast's text as it is drawn, gone or not: a note is on screen for a few seconds, and a busy runner can take
  // longer than that between the click that posts it and the first look (the Printers tab mounting under it, say).
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      const seen: string[] = []
      const drawn = new WeakSet<Element>()
      Object.assign(window, { __toasts: seen })
      new MutationObserver(() => {
        for (const el of document.querySelectorAll('[data-testid="toast"]')) {
          if (drawn.has(el) || !el.textContent) continue
          drawn.add(el)
          seen.push(el.textContent)
        }
      }).observe(document, { childList: true, subtree: true, characterData: true })
    })
  })
}

/** A request to the mocks' control server: a GET without a body, a POST with one. */
export type Ctl = (path: string, body?: unknown) => Promise<Record<string, unknown>>
export const ctl: Ctl = async (path, body) => {
  const r = await fetch(`http://127.0.0.1:${hub.controlPort}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return (await r.json()) as Record<string, unknown>
}

/** Every mock's state and request log, as one string. */
export const mockLog = async (): Promise<string> => JSON.stringify(await ctl('/state'))

/** One mock's request log. */
export async function logOf(mock: string): Promise<string[]> {
  return ((await ctl('/state'))[mock] as { log: string[] }).log
}

/** How many toasts drawn on this page so far read `has`. */
export async function toastsWith(page: Page, has: RegExp): Promise<number> {
  const all = await page.evaluate(() => (window as unknown as { __toasts?: string[] }).__toasts ?? [])
  return all.filter((t) => has.test(t)).length
}

/** Waits for a toast reading `has`, the first one, or one more than `after` when given. */
export async function sawToast(page: Page, has: RegExp, { after = 0, timeout = 15_000 }: { after?: number; timeout?: number } = {}): Promise<void> {
  await expect.poll(() => toastsWith(page, has), { message: `a toast reading ${has}`, timeout }).toBeGreaterThan(after)
}

export async function seed(page: Page): Promise<void> {
  // Setup already done, as after any first launch: printer setup opened by a test then records no unfinished onboarding
  // that a reload would open again.
  const { ONBOARDING_VERSION } = await import('../../../packages/app/src/first-run/onboarding.ts')
  const firstRun = { completedAt: '2026-10-01T00:00:00.000Z', step: 'done', look: { id: 'slicerx' }, printerId: null, version: ONBOARDING_VERSION }
  await page.addInitScript((firstRun) => {
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'advanced', cadTools: true, firstRun }))
  }, firstRun)
  await page.goto('./')
}

export async function connectApp(page: Page): Promise<void> {
  await seed(page)
  await plateReady(page)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Printer bridge' }).click()
  await page.getByLabel('Pairing code').fill(hub.code)
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(page.getByText('Connected', { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
}

/** Settings > Printer bridge, pairing again when this page is not connected yet. */
export async function bridgeOn(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Printer bridge' }).click()
  // The section loads on demand: wait for it, then pair only when it asks for the code.
  await expect(page.getByRole('region', { name: 'Printer bridge' })).toBeVisible()
  const codeBox = page.getByLabel('Pairing code')
  const connected = page.getByText('Connected', { exact: true })
  await expect(codeBox.or(connected).first()).toBeVisible()
  if (await codeBox.isVisible()) {
    await codeBox.fill(hub.code)
    await page.getByRole('button', { name: 'Connect', exact: true }).click()
  }
  await expect(page.getByText('Connected', { exact: true })).toBeVisible()
}

/** Pairs the app, puts one 20 mm box on the plate for `printer`, slices, and opens the Print sheet. */
export async function sheetFor(page: Page, printer: string): Promise<Locator> {
  await openStudio(page)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Printer bridge' }).click()
  await page.getByLabel('Pairing code').fill(hub.code)
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(page.getByText('Connected', { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByTestId('slice-machine-printer').click()
  await page.getByRole('list', { name: 'Choose a printer' }).getByRole('button', { name: new RegExp(`^${printer}\\b`) }).first().click()
  await page.evaluate(() => (window as unknown as { __sx: { setState(p: unknown): void } }).__sx.setState({ plate: [], selection: null, selectedIds: [] }))
  await command(page, 'Add a box')
  const slices = await sliceCount(page)
  await page.getByRole('button', { name: 'Slice plate' }).click()
  await expect(sliced(page, slices)).toBeVisible({ timeout: 120_000 })
  await command(page, `Print the plate on ${printer}`)
  const sheet = page.locator('dialog.print-sheet[open]')
  await expect(sheet).toBeVisible()
  await expect(sheet.locator('.ps-file[data-checked]')).toBeVisible({ timeout: 30_000 })
  return sheet
}

/** The Print sheet's start, which is the approval. Says what the sheet showed when it is disabled. */
export async function start(sheet: Locator): Promise<void> {
  const go = sheet.getByRole('button', { name: /^Bed is clear, start|^Start (print|anyway)/ })
  if (await go.isDisabled()) throw new Error(`Start is disabled: ${await sheet.innerText()}`)
  await go.click()
}

/** A failure detector stand-in on the watch role: takes one frame of the printer, then reports a hand on it. */
export async function reportHand(printerId: string): Promise<{ frame: Uint8Array; paused: boolean; looks: { hand: boolean; count: number }; close(): void }> {
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
  const det = await connectLink({ url: hub.linkUrl, code: hub.code, role: 'watch', WebSocket: Looking as unknown as typeof WebSocket })
  const frame = await new Promise<Uint8Array>((resolve) => {
    void det.watch.subscribe((f) => f.printerId === printerId && resolve(f.data), { everyMs: 2000, printerIds: [printerId] })
  })
  const { paused } = await det.watch.report({ printerId, kind: 'hand', confidence: 0.88, box: [0.06, 0.55, 0.4, 0.98], note: '2 of the last 3 frames, siglip2-base-224' })
  return { frame, paused, looks, close: () => det.close() }
}

/** Resume on the guard card. The click is the approval: no second card opens (QA M9). */
export async function resumeFromCard(page: Page, card: Locator, name: string): Promise<void> {
  const resumed = new RegExp(`Resumed on ${name}`)
  const before = await toastsWith(page, resumed)
  await card.getByRole('button', { name: 'Resume' }).click()
  await sawToast(page, resumed, { after: before })
  await expect(page.locator('dialog.approve-dialog[open]')).toHaveCount(0)
}
