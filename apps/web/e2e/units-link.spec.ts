// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { withWindowsCredential } from '../../../packages/mcp/test/helpers/windows-credential'
import { hub, seed, useBridge } from './bridge-hub'
import { expect, plateReady, tab, test } from './fixtures'
import { command } from './cad-helpers'

useBridge([], async () => { await hub.admin.settings.set({ appLink: true }) }, { hostAppLink: true })
const repo = join(import.meta.dirname, '../../..')
const from = createRequire(join(repo, 'packages/mcp/package.json'))
let runtimeDir: string | undefined
test.beforeAll(async () => {
  const { build } = await import(pathToFileURL(from.resolve('esbuild')).href)
  runtimeDir = mkdtempSync(join(repo, 'packages/mcp/.units-runtime-'))
  await build({ entryPoints: [join(repo, 'packages/mcp/src/index.ts')], outfile: join(runtimeDir, 'index.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node24', logLevel: 'warning', external: ['@modelcontextprotocol/sdk', 'zod', 'yaml', '@noble/*'] })
})
test.afterAll(() => { if (runtimeDir) rmSync(runtimeDir, { recursive: true, force: true }) })

test('clients change display units with visible read-back, native CLI and persistent preferences', async ({ page }) => {
  test.slow()
  page.setDefaultTimeout(30_000)
  const hosting: string[] = []
  page.on('console', (m) => { if (m.text().startsWith('[app link]')) hosting.push(m.text()) })
  await page.addInitScript((shell) => Object.assign(window, { __sxTestShell: shell }), { url: hub.linkUrl, code: hub.code, hubKey: hub.admin.hubKey })
  await page.addInitScript(() => localStorage.setItem('slicerx.debug', '1'))
  await seed(page)
  await plateReady(page)
  await tab(page, 'model').click()
  await expect.poll(() => hosting.join('\n'), { timeout: 30_000 }).toContain('this window hosts the app link')
  const { Client } = await import(pathToFileURL(from.resolve('@modelcontextprotocol/sdk/client/index.js')).href)
  const { InMemoryTransport } = await import(pathToFileURL(from.resolve('@modelcontextprotocol/sdk/inMemory.js')).href)
  const { createContext, createSlicerxServer } = await import(pathToFileURL(join(runtimeDir!, 'index.mjs')).href)
  const dir = mkdtempSync(join(tmpdir(), 'sx-units-link-'))
  const policyFile = join(dir, 'policy.json')
  writeFileSync(policyFile, '{}')
  const session = async (name: string, readOnly: boolean) => {
    const { clientKey } = await hub.admin.clients.create(name, 'agent')
    const ctx = await createContext({ engine: 'sx', sxBin: process.env['SX_CLI_BIN'], printers: 'link', linkUrl: hub.linkUrl, linkHubKey: hub.admin.hubKey, linkClientKey: clientKey, app: 'required', outDir: join(dir, name), profilesDir: join(dir, 'profiles'), policyFile })
    const server = createSlicerxServer(ctx)
    const client = new Client({ name, version: '0.0.0' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(a), client.connect(b)])
    await client.listTools()
    const raw = (name: string, args = {}) => client.callTool({ name: `slicerx_${name}`, arguments: args }, undefined, { timeout: 60_000 })
    const pending = raw('app_units')
    const grant = page.getByTestId(readOnly ? 'app-link-read' : 'app-link-allow')
    await expect(grant).toBeEnabled({ timeout: 30_000 })
    await grant.click()
    expect((await pending).isError).not.toBe(true)
    const call = async (name: string, args = {}) => {
      const result = await raw(name, args)
      expect(result.isError, JSON.stringify(result)).not.toBe(true)
      return result.structuredContent.output
    }
    return { raw, call, clientKey, close: async () => { await client.close(); await server.close(); ctx.printers?.close?.() } }
  }
  const reader = await session('units-reader', true)
  try {
    await command(page, 'Add a box')
    await expect(page.getByLabel('Model size')).toContainText('20')
    const before = await reader.call('app_history')
    const read = () => reader.call('app_units')
    const inches = await reader.call('app_units_set', { length: 'in', precision: { decimals: 3 } })
    expect(inches).toMatchObject({ available: true, length: 'in', precision: { decimals: 3 }, millimetersPerUnit: 25.4, dataUnit: 'mm' })
    expect(await read()).toEqual(inches)
    await expect(page.getByLabel('Model size')).toContainText('0.787 x 0.787 x 0.787 in')
    const settings = async () => {
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Settings' })
      await dialog.getByRole('button', { name: /Slicing and modeling|Modeling/ }).first().click()
      return dialog
    }
    const dialog = await settings()
    await expect(dialog.getByTestId('set-precision-pick')).toHaveValue('d3')
    await dialog.getByTestId('set-precision-pick').selectOption('f32')
    expect(await read()).toMatchObject({ length: 'in', precision: { fraction: 32 }, inchDigits: 3, inchFraction: 32 })
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(page.getByLabel('Model size')).toContainText('25/32 x 25/32 x 25/32 in')
    const unchanged = await read()
    expect(await reader.raw('app_units_set', { length: 'mm', precision: { fraction: 32 } })).toMatchObject({ isError: true, structuredContent: { error: { code: 'invalid_input' } } })
    expect(await read()).toEqual(unchanged)
    expect(await reader.call('app_history')).toEqual(before)
    if (process.platform === 'win32') {
      await withWindowsCredential(reader.clientKey!, async (ref, identifier) => {
        const env = { ...process.env }
        for (const key of Object.keys(env)) if (key.startsWith('SLICERX_MCP_')) delete env[key]
        Object.assign(env, { SLICERX_MCP_LINK_KEY_REF: ref, SLICERX_MCP_APP_IDENTIFIER: identifier, SLICERX_MCP_LINK_URL: hub.linkUrl, SLICERX_MCP_LINK_HUB_KEY: hub.admin.hubKey, SLICERX_MCP_CLI: join(repo, 'packages/mcp/dist/cli.js'), SLICERX_NODE_BIN: process.execPath })
        const native = process.env['SX_CLI_BIN']!
        expect(native).toBeTruthy()
        const result = await promisify(execFile)(native, ['call', '--app', '--engine', 'sx', '--sx-bin', native, '--policy', policyFile, '--out-dir', join(dir, 'cli'), '--profiles-dir', join(dir, 'profiles'), 'app_units_set', JSON.stringify({ length: 'mm', precision: { decimals: 2 } }), 'app_units'], { env, windowsHide: true, timeout: 60_000 })
        expect(result.stdout + result.stderr).not.toContain(reader.clientKey)
        const rows = result.stdout.trim().split('\n').map((line) => JSON.parse(line))
        expect(rows).toHaveLength(2)
        for (const row of rows) {
          expect(row.ok).toBe(true)
          expect(row.output.output).toMatchObject({ length: 'mm', precision: { decimals: 2 }, millimetersPerUnit: 1, dataUnit: 'mm' })
        }
        expect(rows[0].output.output).toEqual(rows[1].output.output)
        expect(await read()).toEqual(rows[1].output.output)
      })
      await expect(page.getByLabel('Model size')).toContainText('20 x 20 x 20 mm')
    }
    await reader.call('app_units_set', { length: 'in' })
    expect(await read()).toMatchObject({ length: 'in', precision: { fraction: 32 } })
    expect(await reader.call('app_history')).toEqual(before)
    await page.reload()
    await plateReady(page)
    const restored = await settings()
    await expect(restored.getByTestId('set-precision-pick')).toHaveValue('f32')
    await restored.getByTestId('set-units-mm').click()
    await expect(restored.getByTestId('set-precision-pick')).toHaveValue(process.platform === 'win32' ? 'd2' : `d${inches.mmDigits}`)
  } finally { await reader.close(); rmSync(dir, { recursive: true, force: true }) }
})
