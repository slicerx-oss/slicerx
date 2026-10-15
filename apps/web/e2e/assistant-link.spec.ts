// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A separately configured client reads the open edition through a real hub, over MCP and the CLI.
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { hub, seed, useBridge } from './bridge-hub'
import { expect, plateReady, test } from './fixtures'

useBridge([], async () => { await hub.admin.settings.set({ appLink: true }) })
test.skip(process.env['SX_E2E_ASSISTANT_EDITION'] !== '1', 'requires the assistant edition build')

test('MCP and CLI read the open edition assistant identity', async ({ page }) => {
  await page.addInitScript((shell) => {
    Object.assign(window, { __sxTestShell: shell })
    localStorage.setItem('slicerx.debug', '1')
  }, { url: hub.linkUrl, code: hub.code, hubKey: hub.admin.hubKey })
  await seed(page)
  await plateReady(page)
  await expect.poll(() => page.evaluate(() => (window as any).__sx.getState().bridgeStatus.state)).toBe('on')
  const { clientKey } = await hub.admin.clients.create('assistant identity test', 'agent')
  const repo = join(import.meta.dirname, '../../..')
  const cwd = join(repo, 'packages/mcp')
  const from = createRequire(join(cwd, 'package.json'))
  const { Client } = await import(pathToFileURL(from.resolve('@modelcontextprotocol/sdk/client/index.js')).href)
  const { StdioClientTransport } = await import(pathToFileURL(from.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href)
  const dir = mkdtempSync(join(tmpdir(), 'sx-assistant-identity-'))
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === 'string' && !e[0].startsWith('SLICERX_MCP_LINK') && e[0] !== 'SLICERX_CONFIG')),
    SLICERX_MCP_LINK_KEY_REF: 'slicerx-agent-assistant-test',
    SX_TEST_AGENT_KEY: clientKey!,
  }
  // Isolate credential storage only. Windows has no MCP keychain reader yet; the hub, app and sx remain real.
  const credential = join(dir, 'credential.cjs')
  writeFileSync(credential, `
    const cp = require('node:child_process');
    const original = cp.execFileSync;
    const platform = process.platform;
    Object.defineProperty(process, 'platform', { get() { return new Error().stack?.includes('readKeychainKey') ? 'linux' : platform; } });
    cp.execFileSync = function(command, args, options) {
      if (command === 'secret-tool' && args.join(' ') === 'lookup service slicerx-agent-assistant-test username slicerx') return process.env.SX_TEST_AGENT_KEY;
      return original.apply(this, arguments);
    };
    require('node:module').syncBuiltinESMExports();
  `)
  const args = ['--require', credential, '--import', pathToFileURL(from.resolve('tsx')).href, 'src/cli.ts', '--engine', 'sx', '--sx-bin', process.env['SX_CLI_BIN']!, '--printers', 'link', '--link-url', hub.linkUrl, '--link-state-dir', hub.stateDir, '--out-dir', join(dir, 'out'), '--profiles-dir', join(dir, 'profiles')]
  const client = new Client({ name: 'assistant-identity-test', version: '0.0.0' })
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args, cwd, env }))
    const answer = client.callTool({ name: 'slicerx_app_assistant', arguments: {} })
    const allow = page.getByTestId('app-link-allow')
    await expect(allow).toBeEnabled()
    await allow.click()
    const result = await answer
    expect(result.isError, JSON.stringify(result)).toBeFalsy()
    const identity = result.structuredContent.output
    expect(identity).toMatchObject({ name: 'yourmate', accent: { light: '#006b65', dark: '#63e6d4' }, enabled: true })
    expect(identity.icon).toMatch(/^data:image\/svg\+xml,/)
    await client.close()
    const { stdout } = await promisify(execFile)(process.execPath, [...args, 'call', 'app_assistant'], { cwd, env, timeout: 90_000 })
    const lines = stdout.trim().split('\n').map((line) => JSON.parse(line))
    expect(lines).toHaveLength(1)
    expect(lines[0].ok).toBe(true)
    expect(lines[0].output.output).toEqual(identity)
  } finally {
    await client.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
