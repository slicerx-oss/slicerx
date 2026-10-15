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
import { command } from './cad-helpers'
import { expectFileDialog, interceptFileDialogs } from './file-dialog'

useBridge([], async () => { await hub.admin.settings.set({ appLink: true }) }, { hostAppLink: true })
const repo = join(import.meta.dirname, '../../..')
const from = createRequire(join(repo, 'packages/mcp/package.json'))
let runtimeDir: string | undefined
test.beforeAll(async () => {
  const { build } = await import(pathToFileURL(from.resolve('esbuild')).href)
  runtimeDir = mkdtempSync(join(repo, 'packages/mcp/.gcode-runtime-'))
  await build({ entryPoints: [join(repo, 'packages/mcp/src/index.ts')], outfile: join(runtimeDir, 'index.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node24', logLevel: 'warning', external: ['@modelcontextprotocol/sdk', 'zod', 'yaml', '@noble/*'] })
})
test.afterAll(() => { if (runtimeDir) rmSync(runtimeDir, { recursive: true, force: true }) })

test('a read client reads real slice text and selects the same G-code lines as the panel and native CLI', async ({ page }) => {
  test.slow()
  interceptFileDialogs(page)
  const hosting: string[] = []
  page.on('console', (m) => { if (m.text().startsWith('[app link]')) hosting.push(m.text()) })
  await page.addInitScript((shell) => Object.assign(window, { __sxTestShell: shell }), { url: hub.linkUrl, code: hub.code, hubKey: hub.admin.hubKey })
  await seed(page)
  await plateReady(page)
  await tab(page, 'prepare').click()
  await expect.poll(() => hosting.join('\n'), { timeout: 30_000 }).toContain('this window hosts the app link')
  const { Client } = await import(pathToFileURL(from.resolve('@modelcontextprotocol/sdk/client/index.js')).href)
  const { InMemoryTransport } = await import(pathToFileURL(from.resolve('@modelcontextprotocol/sdk/inMemory.js')).href)
  const { createContext, createSlicerxServer } = await import(pathToFileURL(join(runtimeDir!, 'index.mjs')).href)
  const dir = mkdtempSync(join(tmpdir(), 'sx-gcode-link-'))
  const policyFile = join(dir, 'policy.json')
  writeFileSync(policyFile, '{}')
  const { clientKey } = await hub.admin.clients.create('gcode-reader', 'agent')
  const ctx = await createContext({ engine: 'sx', sxBin: process.env['SX_CLI_BIN'], printers: 'link', linkUrl: hub.linkUrl, linkHubKey: hub.admin.hubKey, linkClientKey: clientKey, app: 'required', outDir: join(dir, 'out'), profilesDir: join(dir, 'profiles'), policyFile })
  const server = createSlicerxServer(ctx)
  const client = new Client({ name: 'gcode-reader', version: '0.0.0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  try {
    await Promise.all([server.connect(a), client.connect(b)])
    await client.listTools()
    const raw = (name: string, args = {}) => client.callTool({ name: `slicerx_${name}`, arguments: args }, undefined, { timeout: 60_000 })
    const pending = raw('app_preview_gcode')
    const grant = page.getByTestId('app-link-read')
    await expect(grant).toBeEnabled({ timeout: 30_000 })
    await grant.click()
    expect(await pending).toMatchObject({ isError: true, structuredContent: { error: { code: 'busy' } } })
    const call = async (name: string, args = {}) => {
      const result = await raw(name, args)
      expect(result.isError, JSON.stringify(result)).not.toBe(true)
      return result.structuredContent.output
    }
    const read = (args = {}) => call('app_preview_gcode', args)
    await page.getByRole('button', { name: 'Slice plate', exact: true }).click()
    await expect(sliced(page)).toBeVisible({ timeout: 120_000 })
    const initial = await read({ fromLine: 1, count: 3 })
    expect(initial).toMatchObject({ source: { kind: 'slice' }, mapped: true, fromLine: 1, lines: [{ number: 1 }, { number: 2 }, { number: 3 }] })
    expect(initial.totalLines).toBeGreaterThan(100)
    expect(initial.currentLine).toBeGreaterThan(10)
    const history = await call('app_history')
    await page.getByRole('button', { name: 'G-code', exact: true }).click()
    const panel = page.getByRole('complementary', { name: 'G-code', exact: true })
    const go = panel.getByRole('textbox', { name: 'Go to line' })
    await expect(go).toBeVisible()
    await go.fill('1')
    await go.press('Enter')
    await expect.poll(async () => (await read()).currentLine).toBe(0)
    await expect(panel.locator('.gc-row').filter({ has: page.locator('.gc-no', { hasText: /^1$/ }) }).locator('.gc-text')).toHaveText(initial.lines[0].text)
    const last = await call('app_preview_gcode_jump', { line: initial.currentLine, count: 1 })
    const selected = panel.getByRole('option', { selected: true })
    await expect(selected.locator('.gc-no')).toHaveText(String(last.currentLine))
    await expect(selected.locator('.gc-text')).toHaveText(last.lines[0].text)
    expect(await read({ count: 1 })).toMatchObject({ currentLine: last.currentLine, layer: last.layer, moveShare: last.moveShare })
    expect(await raw('app_preview_gcode_jump', { line: initial.totalLines + 1 })).toMatchObject({ isError: true, structuredContent: { error: { code: 'invalid_input' } } })
    expect((await read()).currentLine).toBe(last.currentLine)
    if (process.platform === 'win32') {
      await withWindowsCredential(clientKey!, async (ref, identifier) => {
        const env = { ...process.env }
        for (const key of Object.keys(env)) if (key.startsWith('SLICERX_MCP_')) delete env[key]
        Object.assign(env, { SLICERX_MCP_LINK_KEY_REF: ref, SLICERX_MCP_APP_IDENTIFIER: identifier, SLICERX_MCP_LINK_URL: hub.linkUrl, SLICERX_MCP_LINK_HUB_KEY: hub.admin.hubKey, SLICERX_MCP_CLI: join(repo, 'packages/mcp/dist/cli.js'), SLICERX_NODE_BIN: process.execPath })
        const native = process.env['SX_CLI_BIN']!
        expect(native).toBeTruthy()
        const result = await promisify(execFile)(native, ['call', '--app', '--engine', 'sx', '--sx-bin', native, '--policy', policyFile, '--out-dir', join(dir, 'cli'), '--profiles-dir', join(dir, 'profiles'), 'app_preview_gcode_jump', JSON.stringify({ line: 1, count: 1 }), 'app_preview_gcode', JSON.stringify({ fromLine: 1, count: 1 })], { env, windowsHide: true, timeout: 60_000 })
        expect(result.stdout + result.stderr).not.toContain(clientKey)
        const rows = result.stdout.trim().split('\n').map((line) => JSON.parse(line))
        expect(rows).toHaveLength(2)
        for (const row of rows) { expect(row.ok).toBe(true); expect(row.output.output).toMatchObject({ source: initial.source, currentLine: 0, layer: 1, moveShare: 0, lines: [{ number: 1, text: initial.lines[0].text }] }) }
        expect(await read({ fromLine: 1, count: 1 })).toMatchObject(rows[1].output.output)
      })
    }
    const text = 'G90\nM83\n;LAYER_CHANGE\nG1 Z0.2\nG1 X0 Y0 F6000\nG1 X10 Y0 E1 F1200\nG1 X10 Y10 E1\n;LAYER_CHANGE\nG1 Z0.4\nG1 X0 Y10 E1\n'
    const chooser = await expectFileDialog(page, () => command(page, 'Open a G-code file to view'))
    await chooser.setFiles({ name: 'client-preview.gcode', mimeType: 'text/plain', buffer: Buffer.from(text) })
    await expect.poll(async () => (await read()).source).toEqual({ kind: 'file', name: 'client-preview.gcode' })
    expect(await call('app_preview_gcode_jump', { line: 6, count: 1 })).toMatchObject({ totalLines: 10, currentLine: 6, layer: 1, lines: [{ number: 6, text: 'G1 X10 Y0 E1 F1200' }] })
    await expect(selected.locator('.gc-no')).toHaveText('6')
    await expect(selected.locator('.gc-text')).toHaveText('G1 X10 Y0 E1 F1200')
    await go.fill('10')
    await go.press('Enter')
    await expect.poll(async () => (await read()).currentLine).toBe(10)
    expect(await read({ count: 1 })).toMatchObject({ layer: 2, lines: [{ number: 10, text: 'G1 X0 Y10 E1' }] })
    expect((await call('app_history')).revision).toBe(history.revision)
    await tab(page, 'model').click()
    expect((await read()).source).toEqual({ kind: 'file', name: 'client-preview.gcode' })
    expect(await raw('app_preview_gcode_jump', { line: 6 })).toMatchObject({ isError: true, structuredContent: { error: { code: 'busy' } } })
  } finally { await client.close(); await server.close(); ctx.printers?.close?.(); rmSync(dir, { recursive: true, force: true }) }
})
