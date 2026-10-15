// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A client steps through the plates of the project open in the app the way the person does with the plate picker,
// over MCP and from the command line: slicerx-mcp on a real sx-link with the app link on, the person allowing it in
// the app. Only the desktop app hosts the app link, and it answers only a client the hub remembers (one set up through
// Connect your AI agent), so the page stands in for the desktop shell and the client brings a remembered agent key. Each answer is the plates read back, and the picker on screen agrees; a step the person takes with Shift+]
// reads back too. Runs only when SX_LINK_BIN names a built sx-link (e2e/bridge-hub.ts).
import { execFile } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import type { Page } from '@playwright/test'
import { hub, seed, useBridge } from './bridge-hub'
import { expectFileDialog, interceptFileDialogs } from './file-dialog'
import { expect, plateReady, test, viewSized } from './fixtures'
import { SMALL_3, plateProject } from './plate-project'

useBridge([], async () => {
  // The person turns on Let agents use the open project.
  await hub.admin.settings.set({ appLink: true })
})

const repo = join(import.meta.dirname, '../../..')
const mcpDir = join(repo, 'packages/mcp')
const from = createRequire(join(mcpDir, 'package.json'))

type Plates = { shown: number; drawn?: number | null; count: number; plates: { number: number; name: string; shown: boolean; slice: string }[] }
type Answer = { isError?: boolean; structuredContent?: { ok: boolean; summary: string; output: Plates } }

/** The keychain item the client's credential is under, as Connect your AI agent names it for a test build of the app. */
const KEY_REF = 'slicerx-agent-test-plates'
const APP_ID = 'app.slicerx.desktop.e2e'

/**
 * A stand-in for the system keychain tools (security on macOS, secret-tool on Linux) first on the PATH: it hands over
 * the remembered key for this one item and nothing else, so the run never touches a real keychain.
 */
function fakeKeychain(dir: string, key: string): string {
  const bin = join(dir, 'bin')
  const keyFile = join(dir, 'key')
  writeFileSync(keyFile, key, { mode: 0o600 })
  const script = `#!/bin/sh\nfor a in "$@"; do [ "$a" = "${KEY_REF}.${APP_ID}" ] && exec cat "${keyFile}"; done\nexit 44\n`
  mkdirSync(bin)
  for (const tool of ['security', 'secret-tool']) {
    writeFileSync(join(bin, tool), script)
    chmodSync(join(bin, tool), 0o755)
  }
  return bin
}

/** The process environment for slicerx-mcp as Connect your AI agent sets it up: its credential named, no other. */
const env = (bin: string): Record<string, string> => ({
  ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === 'string' && !e[0].startsWith('SLICERX_MCP_LINK'))),
  PATH: `${bin}:${process.env['PATH'] ?? ''}`,
  SLICERX_MCP_LINK_KEY_REF: KEY_REF,
  SLICERX_MCP_APP_IDENTIFIER: APP_ID,
})
/** slicerx-mcp as a client runs it, checking the hub's key from the hub's state directory. */
const serverArgs = (dir: string) => [from.resolve('tsx/cli'), 'src/cli.ts', '--engine', 'stub', '--printers', 'link', '--link-url', hub.linkUrl, '--link-state-dir', hub.stateDir, '--out-dir', join(dir, 'out'), '--profiles-dir', join(dir, 'profiles')]

/**
 * The person allows a client the first time it calls; the buttons arm after a moment. A client already allowed is not
 * asked again, so the question is answered only if it comes up before the call ends.
 */
async function allowWhenAsked<T>(page: Page, call: Promise<T>): Promise<T> {
  const allow = page.getByTestId('app-link-allow')
  let done = false
  void call.then(
    () => void (done = true),
    () => void (done = true),
  )
  const asked = (async () => {
    while (!done) {
      if (await allow.isVisible()) {
        await expect(allow).toBeEnabled()
        await allow.click()
        return
      }
      await page.waitForTimeout(200)
    }
  })()
  const out = await call
  await asked
  return out
}

/** Opens the studio as the desktop app does: its shell starts the hub and the bridge connects on its own, app link on. */
async function openAsDesktop(page: Page): Promise<void> {
  await page.addInitScript((shell) => Object.assign(window, { __sxTestShell: shell }), { url: hub.linkUrl, code: hub.code, hubKey: hub.admin.hubKey })
  await seed(page)
  await plateReady(page)
  type Sx = { getState(): { bridgeStatus: { state: string } } }
  await expect.poll(() => page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState().bridgeStatus.state), { timeout: 30_000 }).toBe('on')
}

const shownInApp = (page: Page) => page.getByTestId('plate-picker-current').locator('.pp-no')

test('a client lists the plates and steps through them over MCP and the command line, each read back', async ({ page }) => {
  interceptFileDialogs(page)
  await page.addInitScript(() => localStorage.setItem('slicerx.debug', '1'))
  await openAsDesktop(page)
  // The client the person set up through Connect your AI agent: a key the hub remembers.
  const { clientKey } = await hub.admin.clients.create('e2e plates', 'agent')
  const chooser = await expectFileDialog(page, () => page.keyboard.press('ControlOrMeta+o'))
  await chooser.setFiles({ name: 'Deck box.3mf', mimeType: 'model/3mf', buffer: plateProject(SMALL_3) })
  await expect(page.getByTestId('plate-picker-current').locator('.pp-of')).toHaveText('of 3', { timeout: 60_000 })
  await viewSized(page)

  // MCP over stdio, as a client runs slicerx-mcp.
  type Client = { connect(t: unknown): Promise<void>; callTool(p: { name: string; arguments: Record<string, unknown> }, s?: unknown, o?: { timeout?: number }): Promise<unknown>; close(): Promise<void> }
  const { Client } = (await import(pathToFileURL(from.resolve('@modelcontextprotocol/sdk/client/index.js')).href)) as { Client: new (i: { name: string; version: string }) => Client }
  const { StdioClientTransport } = (await import(pathToFileURL(from.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href)) as { StdioClientTransport: new (p: { command: string; args: string[]; cwd: string; env?: Record<string, string>; stderr?: 'inherit' }) => unknown }
  const dir = mkdtempSync(join(tmpdir(), 'sx-e2e-plates-'))
  const bin = fakeKeychain(dir, clientKey!)
  const client = new Client({ name: 'e2e-plates', version: '0.0.0' })
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: serverArgs(dir), cwd: mcpDir, env: env(bin), stderr: 'inherit' }))
    const call = async (tool: string, args: Record<string, unknown> = {}) => {
      const a = (await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 90_000 })) as Answer
      expect(a.isError, JSON.stringify(a)).toBeFalsy()
      return a.structuredContent!.output
    }
    const listed = await allowWhenAsked(page, call('slicerx_app_plates'))
    // The view draws the plate shown: plate 1 after the open, not the last plate it loaded.
    expect(listed).toMatchObject({ shown: 1, drawn: 1, count: 3 })
    expect(listed.plates.map((p) => p.name)).toEqual(SMALL_3)

    // A step, read back, and the picker on screen shows the same plate.
    expect(await call('slicerx_app_plate_show', { step: 'next' })).toMatchObject({ shown: 2, drawn: 2, plates: [{ shown: false }, { shown: true }, { shown: false }] })
    await expect(shownInApp(page)).toHaveText('Plate 2')
    expect(await call('slicerx_app_plate_show', { plate: 3 })).toMatchObject({ shown: 3, drawn: 3 })
    await expect(shownInApp(page)).toHaveText('Plate 3')
    await expect(page.getByTestId('plate-picker-next')).toBeDisabled()
    // Past the last plate: refused, and nothing moves.
    const end = (await client.callTool({ name: 'slicerx_app_plate_show', arguments: { step: 'next' } }, undefined, { timeout: 90_000 })) as Answer & { content: { text?: string }[] }
    expect(end.isError).toBe(true)
    expect(JSON.stringify(end.content)).toContain('last plate')
    await expect(shownInApp(page)).toHaveText('Plate 3')

    // The person steps back with Shift+[; the client reads it back.
    await page.locator('canvas.vp-canvas').focus()
    await page.keyboard.press('Shift+BracketLeft')
    await expect(shownInApp(page)).toHaveText('Plate 2')
    expect(await call('slicerx_app_plates')).toMatchObject({ shown: 2, drawn: 2 })
  } finally {
    await client.close()
  }

  // The command line: slicerx-mcp call, one JSON line per call, the step and its read-back.
  try {
    const run = promisify(execFile)
    const cli = run(process.execPath, [...serverArgs(dir), 'call', 'app_plate_show', '{"step":"previous"}', 'app_plates'], { cwd: mcpDir, env: env(bin), timeout: 120_000 })
    const { stdout } = await allowWhenAsked(page, cli)
    const lines = stdout.trim().split('\n').map((l) => JSON.parse(l) as { tool: string; ok: boolean; output: { output: Plates } })
    expect(lines).toHaveLength(2)
    expect(lines.map((l) => l.ok)).toEqual([true, true])
    expect(lines[0]!.output.output).toMatchObject({ shown: 1 })
    expect(lines[1]!.output.output).toMatchObject({ shown: 1, drawn: 1, count: 3 })
    await expect(shownInApp(page)).toHaveText('Plate 1')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
