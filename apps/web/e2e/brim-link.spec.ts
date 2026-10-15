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
  runtimeDir = mkdtempSync(join(repo, 'packages/mcp/.brim-runtime-'))
  await build({ entryPoints: [join(repo, 'packages/mcp/src/index.ts')], outfile: join(runtimeDir, 'index.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node24', logLevel: 'warning', external: ['@modelcontextprotocol/sdk', 'zod', 'yaml', '@noble/*'] })
})
test.afterAll(() => { if (runtimeDir) rmSync(runtimeDir, { recursive: true, force: true }) })

type Ear = { index: number; bedMm: number[]; localMm: number[]; diameterMm: number; connected: boolean }
type Brim = { revision: string; changed?: boolean; objects: { id: string; enabled: boolean; ears: Ear[] }[] }
type Answer = { isError?: boolean; structuredContent?: { output?: Brim; error?: { code: string } } }

test('clients edit brim ears through MCP and the native CLI, read them back, undo and slice actual discs', async ({ page }) => {
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
  const dir = mkdtempSync(join(tmpdir(), 'sx-brim-link-'))
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
    const pending = call('app_brim_ears')
    const grant = page.getByTestId(readOnly ? 'app-link-read' : 'app-link-allow')
    await expect(grant).toBeEnabled({ timeout: 30_000 })
    await grant.click()
    expect((await pending).isError).not.toBe(true)
    return { call, clientKey, close: async () => { await client.close(); await server.close(); ctx.printers?.close?.() } }
  }
  try {
    const reader = await session('brim-reader', true)
    try {
      const state = (await reader.call('app_brim_ears')).structuredContent!.output!
      expect(await reader.call('project_brim_ears', { object: state.objects[0]!.id, revision: state.revision, action: 'generate' })).toMatchObject({ isError: true, structuredContent: { error: { code: 'not_supported' } } })
    } finally { await reader.close() }
    const editor = await session('brim-editor', false)
    try {
      const call = async (name: string, args = {}) => {
        const out = await editor.call(name, args)
        expect(out.isError, JSON.stringify(out)).not.toBe(true)
        return out.structuredContent!.output!
      }
      const initial = await call('app_brim_ears')
      const object = initial.objects[0]!.id
      const read = () => call('app_brim_ears', { object })
      const edit = async (args: Record<string, unknown>) => call('project_brim_ears', { object, revision: (await read()).revision, ...args })
      await edit({ action: 'generate', diameter_mm: 10 })
      const generated = await read()
      expect(generated.objects[0]!.ears.length).toBeGreaterThanOrEqual(3)
      expect(generated.objects[0]!.ears.every((e) => e.connected)).toBe(true)
      expect(await editor.call('project_brim_ears', { object, revision: initial.revision, action: 'clear' })).toMatchObject({ isError: true, structuredContent: { error: { code: 'busy' } } })
      const undo = page.getByTestId('plate-tools-group').getByRole('button', { name: 'Undo', exact: true })
      await undo.click()
      expect((await read()).objects[0]!.ears).toEqual([])
      const [x, y] = generated.objects[0]!.ears[0]!.bedMm
      const actions = [
        { action: 'add', x_mm: x, y_mm: y, diameter_mm: 10 },
        { action: 'move', indices: [0], x_mm: x! + 0.5, y_mm: y },
        { action: 'resize', indices: [0], diameter_mm: 12 },
        { action: 'remove', indices: [0] },
        { action: 'generate', diameter_mm: 10 },
        { action: 'clear' },
      ]
      const outputs: Brim[] = []
      if (process.platform === 'win32') {
        await withWindowsCredential(editor.clientKey!, async (ref, identifier) => {
          const env = { ...process.env }
          for (const key of Object.keys(env)) if (key.startsWith('SLICERX_MCP_')) delete env[key]
          Object.assign(env, { SLICERX_MCP_LINK_KEY_REF: ref, SLICERX_MCP_APP_IDENTIFIER: identifier, SLICERX_MCP_LINK_URL: hub.linkUrl, SLICERX_MCP_LINK_HUB_KEY: hub.admin.hubKey, SLICERX_MCP_CLI: join(repo, 'packages/mcp/dist/cli.js'), SLICERX_NODE_BIN: process.execPath })
          const native = process.env['SX_CLI_BIN']!
          expect(native, 'build and name the real sx CLI').toBeTruthy()
          for (const action of actions) {
            const args = { object, revision: (await read()).revision, ...action }
            const result = await promisify(execFile)(native, ['call', '--app', '--engine', 'sx', '--sx-bin', native, '--policy', policyFile, '--out-dir', join(dir, 'cli'), '--profiles-dir', join(dir, 'profiles'), 'project_brim_ears', JSON.stringify(args), 'app_brim_ears', JSON.stringify({ object })], { env, windowsHide: true, timeout: 60_000 })
            expect(result.stdout + result.stderr).not.toContain(editor.clientKey)
            const rows = result.stdout.trim().split('\n').map((line) => JSON.parse(line))
            expect(rows).toHaveLength(2)
            expect(rows.every((row) => row.ok)).toBe(true)
            expect(rows[0].output.output.changed).toBe(true)
            expect(rows[1].output.output.objects).toEqual(rows[0].output.output.objects)
            expect((await read()).objects).toEqual(rows[1].output.output.objects)
            outputs.push(rows[1].output.output)
          }
        })
      } else {
        for (const action of actions) { await edit(action); outputs.push(await read()) }
      }
      expect(outputs[0]!.objects[0]!.ears[0]!.bedMm[0]).toBeCloseTo(x!, 3)
      expect(outputs[1]!.objects[0]!.ears[0]!.bedMm[0]).toBeCloseTo(x! + 0.5, 3)
      expect(outputs[2]!.objects[0]!.ears[0]!.diameterMm).toBe(12)
      expect(outputs[3]!.objects[0]!.ears).toEqual([])
      expect(outputs[4]!.objects[0]!.ears.length).toBeGreaterThanOrEqual(3)
      expect(outputs[5]!.objects[0]!.ears).toEqual([])
      for (let i = outputs.length - 1; i >= 0; i--) {
        await undo.click()
        const ears = (await read()).objects[0]!.ears
        expect(ears).toEqual(i === 0 ? [] : outputs[i - 1]!.objects[0]!.ears)
      }
      await edit({ action: 'generate', diameter_mm: 10 })
      await page.keyboard.press('ControlOrMeta+k')
      await page.locator('.sx-palette-input').fill('brim type')
      await page.locator('.sx-palette-item', { hasText: 'now' }).first().click()
      await page.locator('#expert-panel').getByLabel('Brim type').selectOption('painted')
      expect((await read()).objects[0]!.enabled).toBe(true)
      const count = await sliceCount(page)
      await page.getByRole('main').getByRole('button', { name: 'Slice plate', exact: true }).click()
      await expect(sliced(page, count)).toBeVisible({ timeout: 120_000 })
      const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export G-code' }).click()])
      const text = readFileSync(await download.path(), 'utf8')
      const mark = text.includes('\n; CHANGE_LAYER\n') ? '; CHANGE_LAYER' : ';LAYER_CHANGE'
      const firstLayer = text.slice(text.indexOf(mark), text.indexOf(mark, text.indexOf(mark) + 1))
      expect(firstLayer).toMatch(/;\s*(?:TYPE|FEATURE):\s*Brim/)
    } finally { await editor.close() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
