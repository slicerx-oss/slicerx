// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { withWindowsCredential } from '../../../packages/mcp/test/helpers/windows-credential'
import { hub, seed, useBridge } from './bridge-hub'
import { expect, plateReady, sliceCount, sliced, test } from './fixtures'

useBridge([], async () => { await hub.admin.settings.set({ appLink: true }) }, { hostAppLink: true })
const repo = join(import.meta.dirname, '../../..')
const from = createRequire(join(repo, 'packages/mcp/package.json'))
let runtimeDir: string | undefined
test.beforeAll(async () => {
  const { build } = await import(pathToFileURL(from.resolve('esbuild')).href)
  runtimeDir = mkdtempSync(join(repo, 'packages/mcp/.settings-runtime-'))
  await build({ entryPoints: [join(repo, 'packages/mcp/src/index.ts')], outfile: join(runtimeDir, 'index.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node24', logLevel: 'warning', external: ['@modelcontextprotocol/sdk', 'zod', 'yaml', '@noble/*'] })
})
test.afterAll(() => { if (runtimeDir) rmSync(runtimeDir, { recursive: true, force: true }) })
type Settings = { overrides: Record<string, unknown>; effective: Record<string, unknown>; shadowed: string[] }
type Answer = { isError?: boolean; structuredContent?: { output?: Settings; error?: { code: string } } }

test('clients edit and reset live print settings, the panel reads them back, and the real slice uses them', async ({ page }) => {
  test.slow()
  const hosting: string[] = []
  page.on('console', (m) => { if (m.text().startsWith('[app link]')) hosting.push(m.text()) })
  await page.addInitScript((shell) => {
    Object.assign(window, { __sxTestShell: shell })
    Reflect.deleteProperty(window, 'showSaveFilePicker')
  }, { url: hub.linkUrl, code: hub.code, hubKey: hub.admin.hubKey })
  await seed(page)
  await plateReady(page)
  await expect.poll(() => hosting.join('\n'), { timeout: 30_000 }).toContain('this window hosts the app link')
  const { Client } = await import(pathToFileURL(from.resolve('@modelcontextprotocol/sdk/client/index.js')).href)
  const { InMemoryTransport } = await import(pathToFileURL(from.resolve('@modelcontextprotocol/sdk/inMemory.js')).href)
  const { createContext, createSlicerxServer } = await import(pathToFileURL(join(runtimeDir!, 'index.mjs')).href)
  const dir = mkdtempSync(join(tmpdir(), 'sx-settings-link-'))
  const policyFile = join(dir, 'policy.json')
  writeFileSync(policyFile, '{}')
  const session = async (name: string, readOnly: boolean) => {
    const { clientKey } = await hub.admin.clients.create(name, 'agent')
    const ctx = await createContext({ engine: 'sx', sxBin: process.env['SX_CLI_BIN'], printers: 'link', linkUrl: hub.linkUrl, linkHubKey: hub.admin.hubKey, linkClientKey: clientKey, app: 'required', outDir: join(dir, name), profilesDir: join(dir, 'profiles'), policyFile })
    const server = createSlicerxServer(ctx)
    const client = new Client({ name, version: '0.0.0' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(a), client.connect(b)])
    const call = (name: string, args = {}) => client.callTool({ name: `slicerx_${name}`, arguments: args }, undefined, { timeout: 60_000 }) as Promise<Answer>
    const pending = call('app_settings')
    const grant = page.getByTestId(readOnly ? 'app-link-read' : 'app-link-allow')
    await expect(grant).toBeEnabled({ timeout: 30_000 })
    await grant.click()
    expect((await pending).isError).not.toBe(true)
    return { call, clientKey, close: async () => { await client.close(); await server.close(); ctx.printers?.close?.() } }
  }
  try {
    const reader = await session('settings-reader', true)
    try {
      expect(await reader.call('project_set_overrides', { changes: { wall_loops: 5 } })).toMatchObject({ isError: true, structuredContent: { error: { code: 'not_supported' } } })
    } finally { await reader.close() }
    const editor = await session('settings-editor', false)
    try {
      const call = async (name: string, args = {}) => {
        const out = await editor.call(name, args)
        expect(out.isError, JSON.stringify(out)).not.toBe(true)
        return out.structuredContent!.output!
      }
      const initial = await call('app_settings', { keys: ['layer_height', 'wall_loops'] })
      await call('project_set_overrides', { changes: { layer_height: 0.24, wall_loops: 4 } })
      expect((await call('app_settings', { keys: ['layer_height', 'wall_loops'] })).effective).toEqual({ layer_height: 0.24, wall_loops: 4 })
      await page.keyboard.press('ControlOrMeta+k')
      await page.locator('.sx-palette-input').fill('layer height')
      await page.locator('.sx-palette-item', { hasText: 'now' }).first().click()
      const row = page.locator('#expert-panel').getByLabel('Layer height', { exact: true })
      await expect(row).toHaveValue('0.24')
      await row.fill('0.28')
      await row.press('Enter')
      expect((await call('app_settings', { keys: ['layer_height'] })).effective.layer_height).toBe(0.28)
      const before = await call('app_settings')
      expect(await editor.call('project_set_overrides', { changes: { wall_loops: 8, missing_key: 1 } })).toMatchObject({ isError: true })
      expect((await call('app_settings')).overrides).toEqual(before.overrides)
      const commands = [
        ['project_set_overrides', { clear: ['layer_height'] }],
        ['app_settings', { keys: ['layer_height', 'wall_loops'] }],
        ['project_set_overrides', { changes: { layer_height: 0.2, initial_layer_print_height: 0.2, smart_layer: 'off' } }],
        ['app_settings', { keys: ['layer_height', 'smart_layer'] }],
      ] as const
      const answers: Settings[] = []
      if (process.platform === 'win32') {
        await withWindowsCredential(editor.clientKey!, async (ref, identifier) => {
          const env = { ...process.env }
          for (const key of Object.keys(env)) if (key.startsWith('SLICERX_MCP_')) delete env[key]
          Object.assign(env, { SLICERX_MCP_LINK_KEY_REF: ref, SLICERX_MCP_APP_IDENTIFIER: identifier, SLICERX_MCP_LINK_URL: hub.linkUrl, SLICERX_MCP_LINK_HUB_KEY: hub.admin.hubKey, SLICERX_MCP_CLI: join(repo, 'packages/mcp/dist/cli.js'), SLICERX_NODE_BIN: process.execPath })
          const native = process.env['SX_CLI_BIN']
          expect(native, 'build and name the real sx CLI').toBeTruthy()
          const result = await promisify(execFile)(native!, ['call', '--app', '--engine', 'sx', '--sx-bin', native!, '--policy', policyFile, '--out-dir', join(dir, 'cli'), '--profiles-dir', join(dir, 'profiles'), ...commands.flatMap(([name, args]) => [name, JSON.stringify(args)])], { env, windowsHide: true, timeout: 90_000 })
          expect(result.stdout + result.stderr).not.toContain(editor.clientKey)
          const lines = result.stdout.trim().split('\n').map((line) => JSON.parse(line))
          expect(lines).toHaveLength(commands.length)
          for (const line of lines) {
            expect(line.ok, JSON.stringify(line)).toBe(true)
            answers.push(line.output.output as Settings)
          }
        })
      } else {
        for (const [name, args] of commands) answers.push(await call(name, args))
      }
      expect(answers[1]!.overrides).toEqual({ wall_loops: 4 })
      expect(answers[1]!.effective.layer_height).toBe(initial.effective.layer_height)
      expect(answers[3]!.effective).toEqual({ layer_height: 0.2, smart_layer: 'off' })
      expect((await call('app_settings', { keys: ['layer_height', 'smart_layer'] })).effective).toEqual(answers[3]!.effective)
      const count = await sliceCount(page)
      await page.getByRole('main').getByRole('button', { name: /^Slice/ }).first().click()
      await expect(sliced(page, count)).toBeVisible({ timeout: 120_000 })
      const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export G-code' }).click()])
      const gcode = readFileSync((await download.path())!, 'utf8')
      expect(gcode).toMatch(/^; layer_height = 0\.2$/m)
      expect(gcode).toMatch(/^; wall_loops = 4$/m)
      expect(gcode).toMatch(/^G1 .*E[0-9]/m)
    } finally { await editor.close() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
