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

test('a read client controls every preview marker and reads UI and native CLI changes back', async ({ page }) => {
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
  const dir = mkdtempSync(join(tmpdir(), 'sx-marker-link-'))
  const policyFile = join(dir, 'policy.json')
  writeFileSync(policyFile, '{}')
  const { clientKey } = await hub.admin.clients.create('marker-reader', 'agent')
  const ctx = await createContext({ engine: 'sx', sxBin: process.env['SX_CLI_BIN'], printers: 'link', linkUrl: hub.linkUrl, linkHubKey: hub.admin.hubKey, linkClientKey: clientKey, app: 'required', outDir: join(dir, 'out'), profilesDir: join(dir, 'profiles'), policyFile })
  const server = createSlicerxServer(ctx)
  const client = new Client({ name: 'marker-reader', version: '0.0.0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  try {
    await Promise.all([server.connect(a), client.connect(b)])
    await client.listTools()
    const raw = (name: string, args = {}) => client.callTool({ name: `slicerx_${name}`, arguments: args }, undefined, { timeout: 60_000 })
    const pending = raw('app_preview_markers')
    const grant = page.getByTestId('app-link-read')
    await expect(grant).toBeEnabled({ timeout: 30_000 })
    await grant.click()
    expect((await pending).isError).not.toBe(true)
    const call = async (name: string, args = {}) => {
      const result = await raw(name, args)
      expect(result.isError, JSON.stringify(result)).not.toBe(true)
      return result.structuredContent.output
    }
    const initial = await call('app_preview_markers')
    expect(initial.sliced).toBe(false)
    expect(initial.markers).toHaveLength(6)
    for (const row of initial.markers) { expect(row.available).toBe(false); expect(row.count).toBeUndefined() }
    expect(await raw('app_preview_markers_set', { wipes: true })).toMatchObject({ isError: true, structuredContent: { error: { code: 'busy' } } })
    await page.getByRole('button', { name: 'Slice plate', exact: true }).click()
    await expect(sliced(page)).toBeVisible({ timeout: 120_000 })
    const history = await call('app_history')
    const loaded = await call('app_preview_markers')
    for (const row of loaded.markers) expect(row.available).toBe(true)
    const allOn = { retractions: true, seams: true, lifts: true, wipes: true, toolChanges: true, pauses: true }
    await call('app_preview_markers_set', allOn)
    const legend = page.getByRole('list', { name: 'Toolpath legend' })
    const toggle = (label: string) => legend.locator('label').filter({ has: page.getByText(label, { exact: true }) }).getByRole('checkbox')
    for (const row of (await call('app_preview_markers')).markers) {
      expect(row.shown).toBe(true)
      await expect(toggle(row.label)).toBeChecked()
    }
    await expect.poll(async () => (await call('app_preview_markers')).markers.filter((m: { source: string; count?: number }) => m.source === 'gcode' && m.count !== undefined).length).toBe(3)
    await toggle('Seams').uncheck()
    expect((await call('app_preview_markers')).markers.find((m: { kind: string }) => m.kind === 'seams').shown).toBe(false)
    if (process.platform === 'win32') {
      await withWindowsCredential(clientKey!, async (ref, identifier) => {
        const env = { ...process.env }
        for (const key of Object.keys(env)) if (key.startsWith('SLICERX_MCP_')) delete env[key]
        Object.assign(env, { SLICERX_MCP_LINK_KEY_REF: ref, SLICERX_MCP_APP_IDENTIFIER: identifier, SLICERX_MCP_LINK_URL: hub.linkUrl, SLICERX_MCP_LINK_HUB_KEY: hub.admin.hubKey, SLICERX_MCP_CLI: join(repo, 'packages/mcp/dist/cli.js'), SLICERX_NODE_BIN: process.execPath })
        const native = process.env['SX_CLI_BIN']!
        expect(native).toBeTruthy()
        const allOff = Object.fromEntries(Object.keys(allOn).map((k) => [k, false]))
        const result = await promisify(execFile)(native, ['call', '--app', '--engine', 'sx', '--sx-bin', native, '--policy', policyFile, '--out-dir', join(dir, 'cli'), '--profiles-dir', join(dir, 'profiles'), 'app_preview_markers_set', JSON.stringify(allOff), 'app_preview_markers'], { env, windowsHide: true, timeout: 60_000 })
        expect(result.stdout + result.stderr).not.toContain(clientKey)
        const rows = result.stdout.trim().split('\n').map((line) => JSON.parse(line))
        expect(rows).toHaveLength(2)
        for (const row of rows) {
          expect(row.ok).toBe(true)
          expect(row.output.output.markers).toHaveLength(6)
          for (const marker of row.output.output.markers) expect(marker.shown).toBe(false)
        }
        expect(await call('app_preview_markers')).toMatchObject(rows[1].output.output)
        for (const row of loaded.markers) await expect(toggle(row.label)).not.toBeChecked()
      })
    }
    expect((await call('app_history')).revision).toBe(history.revision)
    await tab(page, 'model').click()
    expect(await raw('app_preview_markers_set', { wipes: true })).toMatchObject({ isError: true, structuredContent: { error: { code: 'busy' } } })
  } finally { await client.close(); await server.close(); ctx.printers?.close?.(); rmSync(dir, { recursive: true, force: true }) }
})
