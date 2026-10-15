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
import { bounds, command } from './cad-helpers'

useBridge([], async () => { await hub.admin.settings.set({ appLink: true }) }, { hostAppLink: true })
const repo = join(import.meta.dirname, '../../..')
const from = createRequire(join(repo, 'packages/mcp/package.json'))
let runtimeDir: string | undefined
test.beforeAll(async () => {
  const { build } = await import(pathToFileURL(from.resolve('esbuild')).href)
  runtimeDir = mkdtempSync(join(repo, 'packages/mcp/.pick-filter-runtime-'))
  await build({ entryPoints: [join(repo, 'packages/mcp/src/index.ts')], outfile: join(runtimeDir, 'index.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node24', logLevel: 'warning', external: ['@modelcontextprotocol/sdk', 'zod', 'yaml', '@noble/*'] })
})
test.afterAll(() => { if (runtimeDir) rmSync(runtimeDir, { recursive: true, force: true }) })

test('a read client changes the real Model pick filter and reads UI picks through the SDK and native CLI', async ({ page }) => {
  test.slow()
  const hosting: string[] = []
  page.on('console', (m) => { if (m.text().startsWith('[app link]')) hosting.push(m.text()) })
  await page.addInitScript((shell) => Object.assign(window, { __sxTestShell: shell }), { url: hub.linkUrl, code: hub.code, hubKey: hub.admin.hubKey })
  await page.addInitScript(() => localStorage.setItem('slicerx.debug', '1'))
  await seed(page)
  await plateReady(page)
  await tab(page, 'prepare').click()
  await expect.poll(() => hosting.join('\n'), { timeout: 30_000 }).toContain('this window hosts the app link')
  const { Client } = await import(pathToFileURL(from.resolve('@modelcontextprotocol/sdk/client/index.js')).href)
  const { InMemoryTransport } = await import(pathToFileURL(from.resolve('@modelcontextprotocol/sdk/inMemory.js')).href)
  const { createContext, createSlicerxServer } = await import(pathToFileURL(join(runtimeDir!, 'index.mjs')).href)
  const dir = mkdtempSync(join(tmpdir(), 'sx-pick-filter-link-'))
  const policyFile = join(dir, 'policy.json')
  writeFileSync(policyFile, '{}')
  const { clientKey } = await hub.admin.clients.create('pick-filter-reader', 'agent')
  const ctx = await createContext({ engine: 'sx', sxBin: process.env['SX_CLI_BIN'], printers: 'link', linkUrl: hub.linkUrl, linkHubKey: hub.admin.hubKey, linkClientKey: clientKey, app: 'required', outDir: join(dir, 'out'), profilesDir: join(dir, 'profiles'), policyFile })
  const server = createSlicerxServer(ctx)
  const client = new Client({ name: 'pick-filter-reader', version: '0.0.0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  try {
    await Promise.all([server.connect(a), client.connect(b)])
    await client.listTools()
    const raw = (name: string, args = {}) => client.callTool({ name: `slicerx_${name}`, arguments: args }, undefined, { timeout: 60_000 })
    const pending = raw('app_pick_filter')
    const grant = page.getByTestId('app-link-read')
    await expect(grant).toBeEnabled({ timeout: 30_000 })
    await grant.click()
    expect((await pending).isError).not.toBe(true)
    const call = async (name: string, args = {}) => {
      const result = await raw(name, args)
      expect(result.isError, JSON.stringify(result)).not.toBe(true)
      return result.structuredContent.output
    }
    const read = () => call('app_pick_filter')
    expect(await read()).toMatchObject({ available: false })
    expect(await raw('app_pick_filter_set', { kind: 'object' })).toMatchObject({ isError: true, structuredContent: { error: { code: 'busy' } } })
    await tab(page, 'model').click()
    await command(page, 'Add a box')
    await expect.poll(async () => (await read()).objects.some((o: { name: string }) => o.name === 'Box')).toBe(true)
    const id = (await read()).primary as string
    const filter = (kind: string) => page.locator(`[data-testid="model-select-filter"][data-kind="${kind}"]`)
    await expect(filter('face')).toBeVisible()
    const history = await call('app_history')
    const face = await call('app_pick_filter_set', { kind: 'face' })
    expect(face).toMatchObject({ available: true, pickFilter: ['face'], primary: id })
    await expect(filter('face')).toHaveAttribute('aria-pressed', 'true')
    await expect(filter('object')).toHaveAttribute('aria-pressed', 'false')
    await expect.poll(() => page.evaluate(() => (window as unknown as { __vp: { rig: { move: unknown } } }).__vp.rig.move === null)).toBe(true)
    const box = await bounds(page, id)
    const point = await page.evaluate((p) => (window as unknown as { __vp: { screenOf(p: number[]): [number, number] } }).__vp.screenOf(p), [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, box.max[2]])
    await page.mouse.click(point[0], point[1])
    await expect.poll(async () => (await read()).picks.length).toBe(1)
    expect((await read()).picks[0]).toMatchObject({ kind: 'face', objectId: id })
    await call('app_pick_filter_set', { kind: 'edge', mode: 'toggle' })
    expect(await read()).toMatchObject({ pickFilter: ['face', 'edge'], primary: id, picks: [{ kind: 'face' }] })
    await expect(filter('edge')).toHaveAttribute('aria-pressed', 'true')
    await filter('object').click()
    expect(await read()).toMatchObject({ pickFilter: ['object'], primary: id, picks: [] })
    await filter('face').click({ modifiers: ['Shift'] })
    expect(await read()).toMatchObject({ pickFilter: ['object', 'face'] })
    const before = await read()
    expect(await raw('app_pick_filter_set', { kind: 'edge', mode: 'invalid' })).toMatchObject({ isError: true })
    expect(await read()).toEqual(before)
    if (process.platform === 'win32') {
      await withWindowsCredential(clientKey!, async (ref, identifier) => {
        const env = { ...process.env }
        for (const key of Object.keys(env)) if (key.startsWith('SLICERX_MCP_')) delete env[key]
        Object.assign(env, { SLICERX_MCP_LINK_KEY_REF: ref, SLICERX_MCP_APP_IDENTIFIER: identifier, SLICERX_MCP_LINK_URL: hub.linkUrl, SLICERX_MCP_LINK_HUB_KEY: hub.admin.hubKey, SLICERX_MCP_CLI: join(repo, 'packages/mcp/dist/cli.js'), SLICERX_NODE_BIN: process.execPath })
        const native = process.env['SX_CLI_BIN']!
        expect(native).toBeTruthy()
        const result = await promisify(execFile)(native, ['call', '--app', '--engine', 'sx', '--sx-bin', native, '--policy', policyFile, '--out-dir', join(dir, 'cli'), '--profiles-dir', join(dir, 'profiles'), 'app_pick_filter_set', JSON.stringify({ kind: 'edge', mode: 'only' }), 'app_pick_filter'], { env, windowsHide: true, timeout: 60_000 })
        expect(result.stdout + result.stderr).not.toContain(clientKey)
        const rows = result.stdout.trim().split('\n').map((line) => JSON.parse(line))
        expect(rows).toHaveLength(2)
        for (const row of rows) { expect(row.ok).toBe(true); expect(row.output.output).toMatchObject({ available: true, pickFilter: ['edge'], primary: id, picks: [] }) }
        expect(await read()).toMatchObject(rows[1].output.output)
        await expect(filter('edge')).toHaveAttribute('aria-pressed', 'true')
        await expect(filter('face')).toHaveAttribute('aria-pressed', 'false')
      })
    }
    expect((await call('app_history')).revision).toBe(history.revision)
    await command(page, 'Push or pull a face')
    await expect.poll(async () => (await read()).available).toBe(false)
    expect(await raw('app_pick_filter_set', { kind: 'face' })).toMatchObject({ isError: true, structuredContent: { error: { code: 'busy' } } })
    expect((await read()).pickFilter).toEqual(['edge'])
  } finally { await client.close(); await server.close(); ctx.printers?.close?.(); rmSync(dir, { recursive: true, force: true }) }
})
