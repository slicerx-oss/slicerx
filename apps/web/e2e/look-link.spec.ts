// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A client reads and sets two view preferences of the open app, Frame the view and Toolbar size, and reads the 3D view's
// look back, over MCP and from the command line: slicerx-mcp on a real sx-link with the app link on, the person
// allowing it in the app. The page stands in for the desktop shell and the client brings a remembered agent key, as in
// plate-picker-link.spec.ts. Each answer is the preferences read back, the ribbon on screen agrees, a bad value changes nothing, and a change the person makes
// in Settings reads back too. Runs only when SX_LINK_BIN names a built sx-link (e2e/bridge-hub.ts).
import { execFile } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import type { Page } from '@playwright/test'
import { hub, seed, useBridge } from './bridge-hub'
import { expect, plateReady, test } from './fixtures'

useBridge([], async () => {
  // The person turns on Let agents use the open project.
  await hub.admin.settings.set({ appLink: true })
})

const repo = join(import.meta.dirname, '../../..')
const mcpDir = join(repo, 'packages/mcp')
const from = createRequire(join(mcpDir, 'package.json'))

type Look = { toolbarSize: string; modelFraming?: string; viewport?: { preset: string; themeBackdrop: boolean; look: { backdrop: { top: string | null } } } }
type Answer = { isError?: boolean; structuredContent?: { ok: boolean; summary: string; output: Look } }

/** The keychain item the client's credential is under, as Connect your AI agent names it for a test build of the app. */
const KEY_REF = 'slicerx-agent-test-look'
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

type Sx = { getState(): { appearance: { toolbarSize: string; modelFraming: string } } }
const appearance = (page: Page) => page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState().appearance)

test('a client reads and sets Frame the view and Toolbar size over MCP and the command line, each read back', async ({ page, isMobile }) => {
  test.skip(isMobile, 'The ribbon and its Toolbar size are desktop controls')
  await page.setViewportSize({ width: 1440, height: 900 })
  // the app state hook (__sx) the read-backs below use
  await page.addInitScript(() => localStorage.setItem('slicerx.debug', '1'))
  await openAsDesktop(page)
  await page.locator('.sx-tab[data-mode="design"]').click()
  const ribbon = page.getByTestId('model-shelf')
  await expect(ribbon).toHaveAttribute('data-setting', 'large')
  const { clientKey } = await hub.admin.clients.create('e2e look', 'agent')

  type Client = { connect(t: unknown): Promise<void>; callTool(p: { name: string; arguments: Record<string, unknown> }, s?: unknown, o?: { timeout?: number }): Promise<unknown>; close(): Promise<void> }
  const { Client } = (await import(pathToFileURL(from.resolve('@modelcontextprotocol/sdk/client/index.js')).href)) as { Client: new (i: { name: string; version: string }) => Client }
  const { StdioClientTransport } = (await import(pathToFileURL(from.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href)) as { StdioClientTransport: new (p: { command: string; args: string[]; cwd: string; env?: Record<string, string>; stderr?: 'inherit' }) => unknown }
  const dir = mkdtempSync(join(tmpdir(), 'sx-e2e-look-'))
  const bin = fakeKeychain(dir, clientKey!)
  const client = new Client({ name: 'e2e-look', version: '0.0.0' })
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: serverArgs(dir), cwd: mcpDir, env: env(bin), stderr: 'inherit' }))
    const call = async (tool: string, args: Record<string, unknown> = {}) => {
      const a = (await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 90_000 })) as Answer
      expect(a.isError, JSON.stringify(a)).toBeFalsy()
      return a.structuredContent!.output
    }
    expect(await allowWhenAsked(page, call('slicerx_app_look'))).toMatchObject({ toolbarSize: 'large', modelFraming: 'selection' })

    // Set, read back, and the window agrees.
    expect(await call('slicerx_app_look_set', { toolbarSize: 'small' })).toMatchObject({ toolbarSize: 'small', modelFraming: 'selection' })
    await expect(ribbon).toHaveAttribute('data-setting', 'small')
    expect(await call('slicerx_app_look_set', { modelFraming: 'open' })).toMatchObject({ toolbarSize: 'small', modelFraming: 'open' })
    expect(await appearance(page)).toMatchObject({ toolbarSize: 'small', modelFraming: 'open' })

    // A bad value is refused before it leaves, and nothing changes.
    const bad = (await client.callTool({ name: 'slicerx_app_look_set', arguments: { toolbarSize: 'huge' } }, undefined, { timeout: 90_000 })) as Answer
    expect(bad.isError).toBe(true)
    await expect(ribbon).toHaveAttribute('data-setting', 'small')

    // The 3D view's look reads back with the preset the theme picked, and follows a scheme change.
    expect((await call('slicerx_app_look')).viewport).toMatchObject({ preset: 'dark-precision', themeBackdrop: false, look: { backdrop: { top: '#2a2e3a' } } })
    const setScheme = (scheme: string) => page.evaluate((s) => (window as unknown as { __sx: { setState(p: unknown): void } }).__sx.setState({ scheme: s, themeFollowsSystem: false }), scheme)
    await setScheme('light')
    await expect.poll(async () => (await call('slicerx_app_look')).viewport?.preset).toBe('light-studio')
    expect((await call('slicerx_app_look')).viewport?.look.backdrop.top).toBe('#e3e6ea')
    await setScheme('dark')
    await expect.poll(async () => (await call('slicerx_app_look')).viewport?.preset).toBe('dark-precision')

    // The person changes Toolbar size in Settings; the client reads it back.
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    await dialog.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Look and feel' }).click()
    await dialog.getByTestId('set-toolbar-size').getByRole('radio', { name: 'Medium' }).click()
    await expect(ribbon).toHaveAttribute('data-setting', 'medium')
    expect(await call('slicerx_app_look')).toMatchObject({ toolbarSize: 'medium', modelFraming: 'open' })
    await page.keyboard.press('Escape')
  } finally {
    await client.close()
  }

  // The command line: slicerx-mcp call, one JSON line per call, the change and its read-back.
  try {
    const run = promisify(execFile)
    const cli = run(process.execPath, [...serverArgs(dir), 'call', 'app_look_set', '{"toolbarSize":"large","modelFraming":"selection"}', 'app_look'], { cwd: mcpDir, env: env(bin), timeout: 120_000 })
    const { stdout } = await allowWhenAsked(page, cli)
    const lines = stdout.trim().split('\n').map((l) => JSON.parse(l) as { tool: string; ok: boolean; output: { output: Look } })
    expect(lines).toHaveLength(2)
    expect(lines.map((l) => l.ok)).toEqual([true, true])
    expect(lines[0]!.output.output).toMatchObject({ toolbarSize: 'large', modelFraming: 'selection' })
    expect(lines[1]!.output.output).toMatchObject({ toolbarSize: 'large', modelFraming: 'selection' })
    await expect(ribbon).toHaveAttribute('data-setting', 'large')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// A hub code authenticates the CLI to the hub, but does not register a client that the app can grant access to.
test('a code-only CLI client gets setup guidance without waiting for a grant prompt', async ({ page, isMobile }) => {
  test.skip(isMobile, 'The app link is hosted by the desktop shell')
  await page.addInitScript(() => localStorage.setItem('slicerx.debug', '1'))
  await openAsDesktop(page)
  const dir = mkdtempSync(join(tmpdir(), 'sx-e2e-unregistered-'))
  try {
    const cleanEnv = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === 'string' && !e[0].startsWith('SLICERX_MCP_')))
    for (const tool of ['app_plates', 'app_history', 'app_look', 'app_values', 'app_assistant']) {
      const result = await promisify(execFile)(process.execPath, [...serverArgs(dir), 'call', tool], {
        cwd: mcpDir, env: cleanEnv, timeout: 30_000,
      }).then(
        (out) => ({ ...out, code: 0 }),
        (error: { code: number; stdout: string; stderr: string }) => error,
      )
      expect(result.code, tool).toBe(1)
      const answers = result.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line))
      expect(answers, tool).toHaveLength(1)
      const answer = answers[0]
      expect(answer.ok, tool).toBe(false)
      expect(answer.output.error).toMatchObject({ code: 'not_configured', details: { appLink: 'unauthorized' } })
      expect(answer.output.error.message).toContain('Connect it in Settings and use the generated client configuration')
      expect(answer.output.error.message).toContain('A hub pairing code alone does not open a permission prompt')
    }
    await expect(page.getByTestId('app-link-read')).toBeHidden()
    await expect(page.getByTestId('app-link-allow')).toBeHidden()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
