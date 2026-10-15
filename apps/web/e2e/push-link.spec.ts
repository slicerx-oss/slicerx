// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A client reads Push and pull as the person has it open in Model, and types a distance into its Distance box, over MCP
// and from the command line: slicerx-mcp on a real sx-link with the app link on, the person allowing it in the app, as
// in look-link.spec.ts. The client reads the picked face and the pending distance back, its typed distance shows in the
// box with the operation it makes, the project does not change until the person presses Enter, and a value the person
// types reads back too. Runs only when SX_LINK_BIN names a built sx-link (e2e/bridge-hub.ts).
import { execFile } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import type { Page } from '@playwright/test'
import { hub, seed, useBridge } from './bridge-hub'
import { bounds, command } from './cad-helpers'
import { expect, plateReady, test } from './fixtures'

useBridge([], async () => {
  // The person turns on Let agents use the open project.
  await hub.admin.settings.set({ appLink: true })
})

const repo = join(import.meta.dirname, '../../..')
const mcpDir = join(repo, 'packages/mcp')
const from = createRequire(join(mcpDir, 'package.json'))

type Push = { open: boolean; face: { object: string } | null; text: string; distanceMm: number | null; operation: string | null }
type Answer = { isError?: boolean; structuredContent?: { ok: boolean; summary: string; output: Push } }

/** The keychain item the client's credential is under, as Connect your AI agent names it for a test build of the app. */
const KEY_REF = 'slicerx-agent-test-push'
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

type Sx = { getState(): { plate: { id: string }[] }; setState(p: unknown): void }

const height = async (page: Page, id: string) => {
  const b = await bounds(page, id)
  return Math.round((b.max[2] - b.min[2]) * 100) / 100
}

test('a client reads the open Push and pull and types a distance for the person over MCP and the command line', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Picks the face with a mouse')
  test.slow()
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.addInitScript(() => localStorage.setItem('slicerx.debug', '1'))
  await openAsDesktop(page)
  // a fresh box in Model, its top face picked, then Push and pull
  await page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.setState({ plate: [], selection: null, selectedIds: [] }))
  await command(page, 'Add a box')
  await expect.poll(() => page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState().plate.length)).toBe(1)
  const id = await page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState().plate[0]!.id)
  await page.locator('.sx-tab[data-mode="design"]').click()
  await expect.poll(() => page.evaluate((id) => (window as unknown as { __vp: { drawnObjects(): string[] } }).__vp.drawnObjects().includes(id), id)).toBe(true)
  await page.evaluate(() => (window as unknown as { __vp: { view(v: string, o?: unknown): void } }).__vp.view('fit', { animate: false }))
  const h0 = await height(page, id)
  const { clientKey } = await hub.admin.clients.create('e2e push', 'agent')

  type Client = { connect(t: unknown): Promise<void>; callTool(p: { name: string; arguments: Record<string, unknown> }, s?: unknown, o?: { timeout?: number }): Promise<unknown>; close(): Promise<void> }
  const { Client } = (await import(pathToFileURL(from.resolve('@modelcontextprotocol/sdk/client/index.js')).href)) as { Client: new (i: { name: string; version: string }) => Client }
  const { StdioClientTransport } = (await import(pathToFileURL(from.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href)) as { StdioClientTransport: new (p: { command: string; args: string[]; cwd: string; env?: Record<string, string>; stderr?: 'inherit' }) => unknown }
  const dir = mkdtempSync(join(tmpdir(), 'sx-e2e-push-'))
  const bin = fakeKeychain(dir, clientKey!)
  const client = new Client({ name: 'e2e-push', version: '0.0.0' })
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: serverArgs(dir), cwd: mcpDir, env: env(bin), stderr: 'inherit' }))
    const call = async (tool: string, args: Record<string, unknown> = {}) => {
      const a = (await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 90_000 })) as Answer
      expect(a.isError, JSON.stringify(a)).toBeFalsy()
      return a.structuredContent!.output
    }
    // Push and pull is shut, and typing a distance into it is refused.
    expect(await allowWhenAsked(page, call('slicerx_app_model_push'))).toMatchObject({ open: false, face: null })
    const shut = (await client.callTool({ name: 'slicerx_app_model_push_set', arguments: { distanceMm: 5 } }, undefined, { timeout: 90_000 })) as Answer
    expect(shut.isError).toBe(true)

    // The person picks the top face and opens the tool.
    const b = await bounds(page, id)
    const top = await page.evaluate((p) => (window as unknown as { __vp: { screenOf(p: number[]): [number, number] } }).__vp.screenOf(p), [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, b.max[2]])
    await page.mouse.click(top[0], top[1])
    await expect(page.getByTestId('model-select-readout')).toHaveText('1 face on Box')
    await command(page, 'Push or pull a face')
    await expect(page.getByTestId('push-view-box')).toBeVisible()
    expect(await call('slicerx_app_model_push')).toMatchObject({ open: true, face: { object: id }, distanceMm: null, operation: null })

    // The client types a cut; the box shows it, and nothing changes until the person applies it.
    expect(await call('slicerx_app_model_push_set', { distanceMm: -3 })).toMatchObject({ open: true, distanceMm: -3, operation: 'cut' })
    await expect(page.getByTestId('push-view-distance')).toHaveValue('-3')
    await expect(page.getByTestId('push-view-op')).toHaveText('Cut')
    expect(await height(page, id)).toBe(h0)

    // The person types over it; the client reads that back.
    await page.getByTestId('push-view-distance').fill('2')
    expect(await call('slicerx_app_model_push')).toMatchObject({ distanceMm: 2, operation: 'pull' })

    // A bad value is refused before it leaves.
    const bad = (await client.callTool({ name: 'slicerx_app_model_push_set', arguments: { distanceMm: 'deep' } }, undefined, { timeout: 90_000 })) as Answer
    expect(bad.isError).toBe(true)
    await expect(page.getByTestId('push-view-distance')).toHaveValue('2')
  } finally {
    await client.close()
  }

  // The command line: slicerx-mcp call, one JSON line per call, the typed distance and its read-back.
  try {
    const run = promisify(execFile)
    const cli = run(process.execPath, [...serverArgs(dir), 'call', 'app_model_push_set', '{"distanceMm":4}', 'app_model_push'], { cwd: mcpDir, env: env(bin), timeout: 120_000 })
    const { stdout } = await allowWhenAsked(page, cli)
    const lines = stdout.trim().split('\n').map((l) => JSON.parse(l) as { tool: string; ok: boolean; output: { output: Push } })
    expect(lines).toHaveLength(2)
    expect(lines.map((l) => l.ok)).toEqual([true, true])
    expect(lines[1]!.output.output).toMatchObject({ distanceMm: 4, operation: 'pull' })
    await expect(page.getByTestId('push-view-distance')).toHaveValue('4')
    // the person applies it
    await page.getByTestId('push-view-distance').press('Enter')
    await expect.poll(() => height(page, id), { timeout: 30_000 }).toBe(h0 + 4)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
