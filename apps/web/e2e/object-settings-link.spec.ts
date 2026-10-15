// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { hub, seed, useBridge } from './bridge-hub'
import { expect, plateReady, test } from './fixtures'

useBridge([], async () => { await hub.admin.settings.set({ appLink: true }) }, { hostAppLink: true })
const from = createRequire(join(import.meta.dirname, '../../../packages/mcp/package.json'))
let runtimeDir: string | undefined
test.beforeAll(async () => {
  const { build } = await import(pathToFileURL(from.resolve('esbuild')).href)
  runtimeDir = mkdtempSync(join(import.meta.dirname, '../../../packages/mcp/.object-settings-runtime-'))
  await build({ entryPoints: [join(import.meta.dirname, '../../../packages/mcp/src/index.ts')], outfile: join(runtimeDir, 'index.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node24', logLevel: 'warning', external: ['@modelcontextprotocol/sdk', 'zod', 'yaml', '@noble/*'] })
})
test.afterAll(() => { if (runtimeDir) rmSync(runtimeDir, { recursive: true, force: true }) })

type Values = Record<string, unknown>
type State = { design: string; object: { id: string; settings: Values; effective: Values }; parts: { name: string; settings: Values; effective: Values }[] }
type Answer = { isError?: boolean; structuredContent?: { output?: State; error?: { code: string } } }

test('clients change object and part settings with effective read-back, UI badges and toolbar Undo', async ({ page }) => {
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
  const dir = mkdtempSync(join(tmpdir(), 'sx-object-settings-link-'))
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
    const pending = call('design_list')
    const grant = page.getByTestId(readOnly ? 'app-link-read' : 'app-link-allow')
    await expect(grant).toBeEnabled({ timeout: 30_000 })
    await grant.click()
    expect((await pending).isError).not.toBe(true)
    return { call, close: async () => { await client.close(); await server.close(); ctx.printers?.close?.() } }
  }
  try {
    const editor = await session('settings-editor', false)
    try {
      const call = async (name: string, args = {}) => {
        const out = await editor.call(name, args)
        expect(out.isError, JSON.stringify(out)).not.toBe(true)
        return out.structuredContent!.output!
      }
      const design = (await call('design_new', { name: 'Settings block' })).design
      await call('geom_extrude', { design, shape: { type: 'rectangle', widthMm: 20, heightMm: 10 }, distance_mm: 3 })
      const read = () => call('app_object_settings', { object: design, keys: ['wall_loops'] })
      const initial = await read()
      expect(initial.parts.length).toBeGreaterThan(0)
      const part = initial.parts[0]!.name
      const own = await call('project_object_settings', { object: design, set: { wall_loops: 4 } })
      expect(own.object.settings).toEqual({ wall_loops: 4 })
      const changed = await call('app_object_settings_set', { object: design, part, set: { wall_loops: 6 } })
      expect(changed.parts[0]).toMatchObject({ name: part, settings: { wall_loops: 6 }, effective: { wall_loops: 6 } })
      expect((await read()).parts[0]!.effective).toEqual({ wall_loops: 6 })
      const row = page.getByTestId('object-row').filter({ hasText: 'Settings block' })
      await expect(row.getByTestId('slice-object-override-badge')).toHaveText('2')
      expect(await editor.call('app_object_settings_set', { object: design, set: { wall_loops: -2 } })).toMatchObject({ isError: true, structuredContent: { error: { code: 'invalid_input' } } })
      expect((await read()).object.settings).toEqual({ wall_loops: 4 })
      const reader = await session('settings-reader', true)
      try {
        expect(await reader.call('app_object_settings', { object: design, keys: ['wall_loops'] })).toMatchObject({ structuredContent: { output: { parts: [{ effective: { wall_loops: 6 } }] } } })
        for (const name of ['app_object_settings_set', 'project_object_settings']) expect(await reader.call(name, { object: design, set: { wall_loops: 8 } })).toMatchObject({ isError: true, structuredContent: { error: { code: 'not_supported' } } })
      } finally { await reader.close() }
      const undo = page.getByTestId('plate-tools-group').getByRole('button', { name: 'Undo', exact: true })
      await undo.click()
      expect((await read()).parts[0]).toMatchObject({ settings: {}, effective: { wall_loops: 4 } })
      await undo.click()
      expect((await read()).object.effective).toEqual(initial.object.effective)
      await call('app_object_settings_set', { object: design, part, set: { wall_loops: 5 } })
      const cleared = await call('app_object_settings_set', { object: design, part, clear: ['wall_loops'] })
      expect(cleared.parts[0]!.settings).toEqual({})
      expect((await read()).parts[0]!.effective).toEqual(initial.parts[0]!.effective)
    } finally { await editor.close() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
