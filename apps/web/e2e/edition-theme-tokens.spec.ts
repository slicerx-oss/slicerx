// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Run against the default app or a JSON edition named by SLICERX_CONFIG. Both modes must reach the rendered art and the client read-back.
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { hub, seed, useBridge } from './bridge-hub'
import { expect, plateReady, test, viewportReady } from './fixtures'

useBridge([], async () => { await hub.admin.settings.set({ appLink: true }) }, { hostAppLink: true })
const from = createRequire(join(import.meta.dirname, '../../../packages/mcp/package.json'))
const configPath = process.env['SLICERX_CONFIG']
const config = configPath?.endsWith('.json') ? JSON.parse(readFileSync(configPath, 'utf8')) : undefined
const theme = config?.brand?.theme
let runtimeDir: string
test.beforeAll(async () => {
  const { build } = await import(pathToFileURL(from.resolve('esbuild')).href)
  runtimeDir = mkdtempSync(join(import.meta.dirname, '../../../packages/mcp/.theme-runtime-'))
  await build({ entryPoints: [join(import.meta.dirname, '../../../packages/mcp/src/index.ts')], outfile: join(runtimeDir, 'index.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node24', logLevel: 'warning', external: ['@modelcontextprotocol/sdk', 'zod', 'yaml', '@noble/*'] })
})
test.afterAll(() => { if (runtimeDir) rmSync(runtimeDir, { recursive: true, force: true }) })

type Look = { theme: { scheme: string; visuals: Record<string, string>; overrides: Record<string, string> } }
type Answer = { isError?: boolean; structuredContent?: { output: Look } }

test('edition colors reach icons, loops, the viewport and MCP in both themes', async ({ page }, info) => {
  const hosting: string[] = []
  page.on('console', (message) => { if (message.text().startsWith('[app link]')) hosting.push(message.text()) })
  await page.addInitScript((shell) => {
    Object.assign(window, { __sxTestShell: shell })
    localStorage.setItem('slicerx.debug', '1')
  }, { url: hub.linkUrl, code: hub.code, hubKey: hub.admin.hubKey })
  await seed(page)
  const agreement = page.getByTestId('agreement-check')
  if (await agreement.isVisible()) {
    await agreement.check()
    await page.getByTestId('agreement-accept').click()
  }
  await plateReady(page)
  await viewportReady(page)
  await expect.poll(() => hosting.join('\n'), { timeout: 30_000 }).toContain('this window hosts the app link')
  await page.locator('.sx-tab[data-mode="design"]').click()
  const { Client } = await import(pathToFileURL(from.resolve('@modelcontextprotocol/sdk/client/index.js')).href)
  const { InMemoryTransport } = await import(pathToFileURL(from.resolve('@modelcontextprotocol/sdk/inMemory.js')).href)
  const { createContext, createSlicerxServer } = await import(pathToFileURL(join(runtimeDir, 'index.mjs')).href)
  const dir = mkdtempSync(join(tmpdir(), 'sx-theme-client-'))
  const policyFile = join(dir, 'policy.json')
  writeFileSync(policyFile, '{}')
  const { clientKey } = await hub.admin.clients.create('theme-reader', 'agent')
  const ctx = await createContext({ engine: 'sx', sxBin: process.env['SX_CLI_BIN'], printers: 'link', linkUrl: hub.linkUrl, linkHubKey: hub.admin.hubKey, linkClientKey: clientKey, outDir: join(dir, 'out'), profilesDir: join(dir, 'profiles'), policyFile })
  const server = createSlicerxServer(ctx)
  const client = new Client({ name: 'theme-reader', version: '0.0.0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(a), client.connect(b)])
  const read = async () => {
    const answer = await client.callTool({ name: 'slicerx_app_look', arguments: {} }, undefined, { timeout: 30_000 }) as Answer
    expect(answer.isError, JSON.stringify(answer)).not.toBe(true)
    return answer.structuredContent!.output.theme
  }
  try {
    const pending = read()
    const grant = page.getByTestId('app-link-read')
    await expect(grant).toBeEnabled({ timeout: 30_000 })
    await grant.click()
    await pending
    for (const scheme of ['dark', 'light'] as const) {
      const values: Record<string, string> = { ...theme?.tokens?.visuals, ...theme?.[scheme]?.visuals }
      await page.setViewportSize({ width: 1440, height: 900 })
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await page.evaluate((scheme) => {
        const sx = (window as unknown as { __sx: { setState(p: unknown): void } }).__sx
        sx.setState({ scheme, themeFollowsSystem: false })
      }, scheme)
      await expect(page.locator('html')).toHaveAttribute('data-scheme', scheme)
      const readBack = await read()
      expect(readBack.scheme).toBe(scheme)
      expect(readBack.overrides).toEqual(values)
      for (const [key, value] of Object.entries(values)) expect(readBack.visuals[key], key).toBe(value)
      if (values['--stage-a1']) {
        const luminance = (hex: string) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i]!, 0)
        const a = luminance(values['--stage-a1'])
        const b = luminance(readBack.visuals['--stage-pill']!)
        expect((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05), 'Add badge text contrast').toBeGreaterThanOrEqual(4.5)
      }
      const ribbon = page.getByTestId('model-shelf')
      await expect(ribbon).toBeVisible()
      await expect(ribbon.locator('svg.ti').first()).toHaveAttribute('width', '32')
      const rgb = (hex: string) => `rgb(${[1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)).join(', ')})`
      if (values['--ti-a1']) await expect(ribbon.locator('svg.ti .a1').first()).toHaveCSS('fill', rgb(values['--ti-a1']))
      if (values['--accent']) {
        await expect.poll(() => page.evaluate(() => (window as unknown as { __vp: { theme: { scene: { selection: string } } } }).__vp.theme.scene.selection)).toBe(values['--accent'])
      }
      await page.screenshot({ path: info.outputPath(`${config?.id ?? 'default'}-${scheme}-ribbon.png`) })
      const loop = async () => {
        await page.locator('[data-tool="push"]:visible').first().hover()
        const tip = page.locator('#sx-tip')
        await expect(tip).toHaveAttribute('data-ready', 'true')
        await expect(tip.locator('.sx-stage svg.sxs')).toBeVisible()
        if (values['--stage-a2']) await expect(tip.locator('.sxs .s-g2').first()).toHaveCSS('fill', rgb(values['--stage-a2']))
        if (values['--stage-grid']) await expect(tip.locator('.sxs-grid')).toHaveCSS('stroke', rgb(values['--stage-grid']))
        await expect(tip.locator('.s-a').first()).toHaveCSS('animation-play-state', 'paused')
        return tip
      }
      let tip = await loop()
      // A scoped studio color still supplies the default grid; an explicit loop override wins over it.
      await tip.evaluate((el) => el.style.setProperty('--scene-grid', '#123456'))
      await expect(tip.locator('.sxs-grid')).toHaveCSS('stroke', rgb(values['--stage-grid'] ?? '#123456'))
      await tip.evaluate((el) => el.style.removeProperty('--scene-grid'))
      await page.screenshot({ path: info.outputPath(`${config?.id ?? 'default'}-${scheme}-loop.png`) })
      await page.emulateMedia({ reducedMotion: 'no-preference' })
      await expect(tip.locator('.s-a').first()).toHaveCSS('animation-play-state', 'running')
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await page.mouse.move(0, 0)
      await page.setViewportSize({ width: 390, height: 844 })
      tip = await loop()
      const box = (await tip.boundingBox())!
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(390)
      await page.screenshot({ path: info.outputPath(`${config?.id ?? 'default'}-${scheme}-phone-loop.png`) })
    }
  } finally {
    await client.close(); await server.close(); ctx.printers?.close?.()
    rmSync(dir, { recursive: true, force: true })
  }
})
