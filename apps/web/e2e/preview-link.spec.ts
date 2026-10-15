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
import { expect, plateReady, sliced, tab, test } from './fixtures'

useBridge([], async () => { await hub.admin.settings.set({ appLink: true }) }, { hostAppLink: true })
const repo = join(import.meta.dirname, '../../..')
const from = createRequire(join(repo, 'packages/mcp/package.json'))
let runtimeDir: string | undefined
test.beforeAll(async () => {
  const { build } = await import(pathToFileURL(from.resolve('esbuild')).href)
  runtimeDir = mkdtempSync(join(repo, 'packages/mcp/.preview-runtime-'))
  await build({ entryPoints: [join(repo, 'packages/mcp/src/index.ts')], outfile: join(runtimeDir, 'index.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node24', logLevel: 'warning', external: ['@modelcontextprotocol/sdk', 'zod', 'yaml', '@noble/*'] })
})
test.afterAll(() => { if (runtimeDir) rmSync(runtimeDir, { recursive: true, force: true }) })

test('a read client controls the live slice preview through MCP and native CLI with independent read-back', async ({ page }) => {
  test.slow()
  const hosting: string[] = []
  page.on('console', (m) => { if (m.text().startsWith('[app link]')) hosting.push(m.text()) })
  await page.addInitScript((shell) => Object.assign(window, { __sxTestShell: shell }), { url: hub.linkUrl, code: hub.code, hubKey: hub.admin.hubKey })
  await seed(page)
  await plateReady(page)
  await expect.poll(() => hosting.join('\n'), { timeout: 30_000 }).toContain('this window hosts the app link')
  const { Client } = await import(pathToFileURL(from.resolve('@modelcontextprotocol/sdk/client/index.js')).href)
  const { InMemoryTransport } = await import(pathToFileURL(from.resolve('@modelcontextprotocol/sdk/inMemory.js')).href)
  const { createContext, createSlicerxServer } = await import(pathToFileURL(join(runtimeDir!, 'index.mjs')).href)
  const dir = mkdtempSync(join(tmpdir(), 'sx-preview-link-'))
  const policyFile = join(dir, 'policy.json')
  writeFileSync(policyFile, '{}')
  const { clientKey } = await hub.admin.clients.create('preview-reader', 'agent')
  const ctx = await createContext({ engine: 'sx', sxBin: process.env['SX_CLI_BIN'], printers: 'link', linkUrl: hub.linkUrl, linkHubKey: hub.admin.hubKey, linkClientKey: clientKey, app: 'required', outDir: join(dir, 'out'), profilesDir: join(dir, 'profiles'), policyFile })
  const server = createSlicerxServer(ctx)
  const client = new Client({ name: 'preview-reader', version: '0.0.0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  try {
    await Promise.all([server.connect(a), client.connect(b)])
    await client.listTools()
    const raw = (name: string, args = {}) => client.callTool({ name: `slicerx_${name}`, arguments: args }, undefined, { timeout: 60_000 })
    const pending = raw('app_preview')
    const grant = page.getByTestId('app-link-read')
    await expect(grant).toBeEnabled({ timeout: 30_000 })
    await grant.click()
    expect((await pending).isError).not.toBe(true)
    const call = async (name: string, args = {}) => {
      const result = await raw(name, args)
      expect(result.isError, JSON.stringify(result)).not.toBe(true)
      return result.structuredContent.output
    }
    const empty = await call('app_preview')
    expect(empty).toMatchObject({ sliced: false, toolpaths: false })
    expect(empty.range).toBeUndefined()
    expect(await raw('app_preview_set', { layer: 1 })).toMatchObject({ isError: true, structuredContent: { error: { code: 'busy' } } })
    expect(await call('app_preview')).toEqual(empty)
    await page.getByRole('button', { name: 'Slice plate', exact: true }).click()
    await expect(sliced(page)).toBeVisible({ timeout: 120_000 })
    const initial = await call('app_preview')
    expect(initial).toMatchObject({ sliced: true, toolpaths: true })
    expect(initial.layers).toBeGreaterThan(6)
    const history = await call('app_history')
    expect(await raw('app_preview_set', { layer: initial.layers + 1, camera: 'top', toolhead: false })).toMatchObject({ isError: true, structuredContent: { error: { code: 'invalid_input' } } })
    expect(await call('app_preview')).toEqual(initial)
    const settings = { range: [2, 6], oneLayer: true, colorMode: 'speed', camera: 'front', toolhead: false, gantry: true }
    expect(await call('app_preview_set', settings)).toMatchObject({ range: [6, 6], oneLayer: true, colorMode: 'speed', camera: 'front', toolhead: false, gantry: true })
    expect(await call('app_preview')).toMatchObject({ range: [6, 6], colorMode: 'speed' })
    await expect(page.locator('#pv-layer')).toHaveValue('6')
    await expect(page.getByTestId('pv-show-toolhead')).not.toBeChecked()
    await expect(page.getByTestId('pv-show-gantry')).toBeChecked()
    await page.getByRole('button', { name: 'Next layer', exact: true }).click()
    expect(await call('app_preview')).toMatchObject({ range: [6, 7], oneLayer: false })

    if (process.platform === 'win32') {
      await withWindowsCredential(clientKey!, async (ref, identifier) => {
        const env = { ...process.env }
        for (const key of Object.keys(env)) if (key.startsWith('SLICERX_MCP_')) delete env[key]
        Object.assign(env, { SLICERX_MCP_LINK_KEY_REF: ref, SLICERX_MCP_APP_IDENTIFIER: identifier, SLICERX_MCP_LINK_URL: hub.linkUrl, SLICERX_MCP_LINK_HUB_KEY: hub.admin.hubKey, SLICERX_MCP_CLI: join(repo, 'packages/mcp/dist/cli.js'), SLICERX_NODE_BIN: process.execPath })
        const native = process.env['SX_CLI_BIN']!
        expect(native).toBeTruthy()
        const result = await promisify(execFile)(native, ['call', '--app', '--engine', 'sx', '--sx-bin', native, '--policy', policyFile, '--out-dir', join(dir, 'cli'), '--profiles-dir', join(dir, 'profiles'), 'app_preview_set', JSON.stringify({ layer: 4, oneLayer: false, colorMode: 'flow', toolhead: true }), 'app_preview'], { env, windowsHide: true, timeout: 60_000 })
        expect(result.stdout + result.stderr).not.toContain(clientKey)
        const rows = result.stdout.trim().split('\n').map((line) => JSON.parse(line))
        expect(rows).toHaveLength(2)
        for (const row of rows) expect(row).toMatchObject({ ok: true, output: { output: { range: [1, 4], oneLayer: false, colorMode: 'flow', toolhead: true } } })
        expect(await call('app_preview')).toMatchObject(rows[1].output.output)
        await expect(page.locator('#pv-layer')).toHaveValue('4')
      })
    }
    expect((await call('app_history')).revision).toBe(history.revision)
    await tab(page, 'model').click()
    expect(await raw('app_preview_set', { layer: 2 })).toMatchObject({ isError: true, structuredContent: { error: { code: 'busy' } } })
    await expect(tab(page, 'model')).toHaveAttribute('aria-current', 'page')
  } finally { await client.close(); await server.close(); ctx.printers?.close?.(); rmSync(dir, { recursive: true, force: true }) }
})
