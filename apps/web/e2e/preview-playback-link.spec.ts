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

useBridge(['snapmaker-u1'], async () => {
  await hub.admin.settings.set({ appLink: true, experimentalConnectors: true })
  await hub.admin.addPrinter({ id: 'playback-u1', name: 'Preview U1', plugin: 'snapmaker', protocol: 'moonraker', host: '127.0.0.1', port: hub.ports['snapmaker-u1'], pollMs: 200 }, { vendor: 'Snapmaker', model: 'U1' })
}, { hostAppLink: true })
const repo = join(import.meta.dirname, '../../..')
const from = createRequire(join(repo, 'packages/mcp/package.json'))
let runtimeDir: string | undefined
test.beforeAll(async () => {
  const { build } = await import(pathToFileURL(from.resolve('esbuild')).href)
  runtimeDir = mkdtempSync(join(repo, 'packages/mcp/.playback-runtime-'))
  await build({ entryPoints: [join(repo, 'packages/mcp/src/index.ts')], outfile: join(runtimeDir, 'index.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node24', logLevel: 'warning', external: ['@modelcontextprotocol/sdk', 'zod', 'yaml', '@noble/*'] })
})
test.afterAll(() => { if (runtimeDir) rmSync(runtimeDir, { recursive: true, force: true }) })

test('a read client plays, pauses and seeks the same clock as the UI and native CLI', async ({ page }) => {
  test.slow()
  const hosting: string[] = []
  page.on('console', (m) => { if (m.text().startsWith('[app link]')) hosting.push(m.text()) })
  await page.addInitScript((shell) => Object.assign(window, { __sxTestShell: shell }), { url: hub.linkUrl, code: hub.code, hubKey: hub.admin.hubKey })
  await page.addInitScript(() => localStorage.setItem('slicerx.debug', '1'))
  await seed(page)
  await plateReady(page)
  await expect.poll(() => page.evaluate(() => (window as unknown as { __sx: { getState(): { profile?: { printerId: string } } } }).__sx.getState().profile?.printerId)).toBe('snapmaker-u1')
  await expect.poll(() => hosting.join('\n'), { timeout: 30_000 }).toContain('this window hosts the app link')
  const { Client } = await import(pathToFileURL(from.resolve('@modelcontextprotocol/sdk/client/index.js')).href)
  const { InMemoryTransport } = await import(pathToFileURL(from.resolve('@modelcontextprotocol/sdk/inMemory.js')).href)
  const { createContext, createSlicerxServer } = await import(pathToFileURL(join(runtimeDir!, 'index.mjs')).href)
  const dir = mkdtempSync(join(tmpdir(), 'sx-playback-link-'))
  const policyFile = join(dir, 'policy.json')
  writeFileSync(policyFile, '{}')
  const { clientKey } = await hub.admin.clients.create('playback-reader', 'agent')
  const ctx = await createContext({ engine: 'sx', sxBin: process.env['SX_CLI_BIN'], printers: 'link', linkUrl: hub.linkUrl, linkHubKey: hub.admin.hubKey, linkClientKey: clientKey, app: 'required', outDir: join(dir, 'out'), profilesDir: join(dir, 'profiles'), policyFile })
  const server = createSlicerxServer(ctx)
  const client = new Client({ name: 'playback-reader', version: '0.0.0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  try {
    await Promise.all([server.connect(a), client.connect(b)])
    await client.listTools()
    const raw = (name: string, args = {}) => client.callTool({ name: `slicerx_${name}`, arguments: args }, undefined, { timeout: 60_000 })
    const pending = raw('app_preview_playback')
    const grant = page.getByTestId('app-link-read')
    await expect(grant).toBeEnabled({ timeout: 30_000 })
    await grant.click()
    expect((await pending).isError).not.toBe(true)
    const call = async (name: string, args = {}) => {
      const result = await raw(name, args)
      expect(result.isError, JSON.stringify(result)).not.toBe(true)
      return result.structuredContent.output
    }
    const read = () => call('app_preview_playback')
    expect(await read()).toMatchObject({ available: false, timeS: null, durationS: null })
    expect(await raw('app_preview_playback_set', { playing: true })).toMatchObject({ isError: true, structuredContent: { error: { code: 'busy' } } })
    await page.getByRole('button', { name: 'Slice plate', exact: true }).click()
    await expect(sliced(page)).toBeVisible({ timeout: 120_000 })
    await expect.poll(async () => (await read()).available).toBe(true)
    const initial = await read()
    const history = await call('app_history')
    const total = initial.durationS as number
    expect(total).toBeGreaterThan(10)
    const dock = page.getByRole('group', { name: 'Layers and moves' })
    const time = page.locator('#pv-time')
    const drawn = () => page.evaluate(() => {
      const tp = (window as unknown as { __vp: { toolpaths: { visibleRange(): [number, number]; hi: number; head: { visible: boolean } } } }).__vp.toolpaths
      return { hi: tp.hi, to: tp.visibleRange()[1], head: tp.head.visible }
    })
    const seek = await call('app_preview_playback_set', { playing: false, timeS: total / 2, speed: 2, followNozzle: true })
    await expect(dock.getByRole('button', { name: 'Play print', exact: true })).toBeVisible()
    await expect(dock.getByRole('checkbox', { name: 'Follow nozzle', exact: true })).toBeChecked()
    await expect.poll(async () => (await drawn()).hi).toBe(seek.layer - 1)
    await expect.poll(async () => (await drawn()).head).toBe(true)
    expect((await read()).timeS).toBeCloseTo(total / 2, 6)
    const unchanged = await read()
    expect(await raw('app_preview_playback_set', { playing: true, timeS: total + 1, speed: 5 })).toMatchObject({ isError: true, structuredContent: { error: { code: 'invalid_input' } } })
    expect(await read()).toEqual(unchanged)
    await call('app_preview_playback_set', { timeS: total / 3, playing: true, speed: 10 })
    await expect(dock.getByRole('button', { name: 'Pause playback' })).toBeVisible()
    await expect.poll(async () => (await read()).timeS).toBeGreaterThan(total / 3 + 1)
    await dock.getByRole('button', { name: 'Pause playback' }).click()
    const paused = await read()
    expect(paused.playing).toBe(false)
    await expect(dock.getByRole('button', { name: 'Play print', exact: true })).toBeVisible()
    await time.focus()
    await page.keyboard.press('Home')
    await expect.poll(async () => (await read()).timeS).toBe(0)
    await page.keyboard.press('ArrowRight')
    await expect.poll(async () => (await read()).timeS).toBe(1)
    await dock.getByRole('button', { name: 'Play print', exact: true }).click()
    await expect.poll(async () => (await read()).playing).toBe(true)
    await call('app_preview_playback_set', { playing: false })
    const stopped = await read()
    await expect(dock.getByRole('button', { name: 'Play print', exact: true })).toBeVisible()
    // Several independent reads after UI work must all keep the paused clock.
    for (let i = 0; i < 3; i++) expect((await read()).timeS).toBe(stopped.timeS)
    const change = await page.evaluate(() => (window as unknown as { __pv: { timeline: { changes: { segment: number; start: number; duration: number }[] } } }).__pv.timeline.changes[0])
    expect(change).toBeDefined()
    await call('app_preview_playback_set', { timeS: change!.start + change!.duration / 3 })
    await page.locator('#pv-moves').focus()
    await page.keyboard.press('ArrowRight')
    const scrubbed = await read()
    expect(scrubbed.toolChange.segment).toBe(change!.segment)
    expect(scrubbed.timeS).toBeCloseTo(change!.start + scrubbed.toolChange.seconds, 6)
    if (process.platform === 'win32') {
      await withWindowsCredential(clientKey!, async (ref, identifier) => {
        const env = { ...process.env }
        for (const key of Object.keys(env)) if (key.startsWith('SLICERX_MCP_')) delete env[key]
        Object.assign(env, { SLICERX_MCP_LINK_KEY_REF: ref, SLICERX_MCP_APP_IDENTIFIER: identifier, SLICERX_MCP_LINK_URL: hub.linkUrl, SLICERX_MCP_LINK_HUB_KEY: hub.admin.hubKey, SLICERX_MCP_CLI: join(repo, 'packages/mcp/dist/cli.js'), SLICERX_NODE_BIN: process.execPath })
        const native = process.env['SX_CLI_BIN']!
        expect(native).toBeTruthy()
        const result = await promisify(execFile)(native, ['call', '--app', '--engine', 'sx', '--sx-bin', native, '--policy', policyFile, '--out-dir', join(dir, 'cli'), '--profiles-dir', join(dir, 'profiles'), 'app_preview_playback_set', JSON.stringify({ playing: false, timeS: total / 4, speed: 0.5, followNozzle: false }), 'app_preview_playback'], { env, windowsHide: true, timeout: 60_000 })
        expect(result.stdout + result.stderr).not.toContain(clientKey)
        const rows = result.stdout.trim().split('\n').map((line) => JSON.parse(line))
        expect(rows).toHaveLength(2)
        for (const row of rows) { expect(row.ok).toBe(true); expect(row.output.output).toMatchObject({ playing: false, timeS: total / 4, speed: 0.5, followNozzle: false }) }
        expect(await read()).toMatchObject(rows[1].output.output)
        await expect(dock.getByRole('checkbox', { name: 'Follow nozzle', exact: true })).not.toBeChecked()
      })
    }
    expect((await call('app_history')).revision).toBe(history.revision)
    await call('app_preview_playback_set', { timeS: 1, playing: true })
    await tab(page, 'model').click()
    await expect.poll(async () => (await read()).available).toBe(false)
    expect(await read()).toMatchObject({ playing: false, timeS: null })
    expect(await raw('app_preview_playback_set', { playing: true })).toMatchObject({ isError: true, structuredContent: { error: { code: 'busy' } } })
  } finally { await client.close(); await server.close(); ctx.printers?.close?.(); rmSync(dir, { recursive: true, force: true }) }
})
