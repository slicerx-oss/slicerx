// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Journey: a G-code line that can move the head asks about the plate first. An agent asks the hub to send a raw line;
// a probe (G29) can bring the nozzle down to the plate, so its card in the app asks whether the plate is clear and the
// hub sends it only on that answer, while a heater line goes on a plain Approve. Against a real sx-link and the Klipper
// mock, each step reads the mock's own command log, not just the page. The harness, with this file's own hub on a free
// loopback port, is in e2e/bridge-hub.ts. Needs SX_LINK_BIN (a built sx-link); the tests skip without it.
import type { Page } from '@playwright/test'
import { hashParams, type ApprovalRequest } from '@slicerx/contracts'
import { ONBOARDING_VERSION } from '../../../../packages/app/src/first-run/onboarding.ts'
import { connectApp, hub, logOf, useBridge } from '../bridge-hub'
import { expect, journey as test } from '../journey'
import { toSlice } from './lib/slice'

test.use({ journeyPrefs: { workspace: 'prepare', settingsMode: 'advanced', cadTools: true, firstRun: { completedAt: '2026-10-01T00:00:00.000Z', step: 'done', look: { id: 'slicerx' }, printerId: null, version: ONBOARDING_VERSION } } })

const ID = 'bench'
const NAME = 'Bench'

useBridge(['moonraker'], async () => {
  await hub.admin.addPrinter({ id: ID, name: NAME, plugin: 'moonraker', host: '127.0.0.1', port: hub.ports['moonraker'] ?? 0 }, { vendor: 'Voron', model: '2.4' })
})

/** How many times the Klipper mock has received `line`. */
const sent = async (line: string): Promise<number> => (await logOf('moonraker')).filter((l) => l.trim() === `gcode ${line}`).length

/** An agent on this file's hub asks for one raw line on a card, as slicerx_printer_gcode does. */
async function askForLine(id: string, line: string): Promise<void> {
  const { connectLink } = await import('../../../../packages/connect/link-client/src/index.ts')
  const { clientKey } = await hub.admin.clients.create(`e2e agent ${id}`, 'agent')
  const agent = await connectLink({ url: hub.linkUrl, clientKey: clientKey ?? '', hubKey: hub.admin.hubKey })
  try {
    const request: ApprovalRequest = {
      id,
      sessionId: 'e2e',
      tool: 'slicerx_printer_gcode',
      permission: 'start',
      title: `Send "${line}" to ${ID}?`,
      lines: [`Sends: ${line}`],
      printerId: ID,
      paramsHash: await hashParams({ printerId: ID, line }),
      actions: [{ action: 'printer.gcode', target: ID, paramsHash: await hashParams({ printerId: ID, line }) }],
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    }
    const r = await agent.approvals.registerWork(request, { kind: 'gcode', printerId: ID, line })
    expect(r.answeredIn).toBe('app')
  } finally {
    agent.close()
  }
}

const cardOn = (page: Page) => page.locator('dialog.approve-dialog[open]')

test('a probe line asks about the plate and goes to the printer only on the answer', async ({ page }) => {
  await toSlice(page)
  await connectApp(page)
  await expect.poll(async () => (await hub.admin.status(ID)).state, { timeout: 20_000 }).toBe('idle')
  await askForLine('mg-g29', 'G29')
  const card = cardOn(page)
  await expect(card).toContainText('G29', { timeout: 30_000 })
  await expect(card).toContainText('can move the head')
  const go = card.getByRole('button', { name: 'Plate is clear, approve' })
  await expect(go).toBeVisible()
  expect(await sent('G29')).toBe(0)
  await go.click()
  await expect.poll(() => sent('G29'), { message: 'the printer got G29', timeout: 20_000 }).toBe(1)
  await expect(card).toHaveCount(0)
})

test('a heater line goes on a plain Approve, with no plate question', async ({ page }) => {
  await askForLine('mg-m104', 'M104 S200')
  const card = cardOn(page)
  await expect(card).toContainText('M104 S200', { timeout: 30_000 })
  await expect(card).not.toContainText('can move the head')
  await expect(card.getByRole('button', { name: /Plate is clear/ })).toHaveCount(0)
  await card.getByRole('button', { name: 'Approve', exact: true }).click()
  await expect.poll(() => sent('M104 S200'), { message: 'the printer got M104 S200', timeout: 20_000 }).toBe(1)
  expect(await sent('G29')).toBe(1)
})
