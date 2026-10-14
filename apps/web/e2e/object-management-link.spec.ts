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
  runtimeDir = mkdtempSync(join(import.meta.dirname, '../../../packages/mcp/.management-runtime-'))
  await build({ entryPoints: [join(import.meta.dirname, '../../../packages/mcp/src/index.ts')], outfile: join(runtimeDir, 'index.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node24', logLevel: 'warning', external: ['@modelcontextprotocol/sdk', 'zod', 'yaml', '@noble/*'] })
})
test.afterAll(() => { if (runtimeDir) rmSync(runtimeDir, { recursive: true, force: true }) })



type Row = { id: string; name: string; parts: number; sizeMm: number[]; minMm: number[]; maxMm: number[] }
type State = { design: string; objects: Row[]; ids: string[]; removed: string[]; requested: number; created: number }
type Answer = { isError?: boolean; structuredContent?: { output?: State; error?: { code: string } } }

test('clients rename, duplicate, orient and remove live objects with read-back and toolbar Undo', async ({ page }) => {
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
  const dir = mkdtempSync(join(tmpdir(), 'sx-management-link-'))
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
    return { call, read: () => ctx.printers.appLink.call('plate.list') as Promise<{ objects: Row[] }>, close: async () => { await client.close(); await server.close(); ctx.printers?.close?.() } }
  }


  try {
    const reader = await session('management-reader', true)
    try {
      for (const [name, args] of [
        ['project_rename', { object: 'unknown', name: 'Name' }],
        ['project_duplicate', { object: 'unknown' }],
        ['project_remove_object', { object: 'unknown' }],
        ['project_lay_on_face', { object: 'unknown', normal: [1, 0, 0] }],
      ] as const) expect(await reader.call(name, args)).toMatchObject({ isError: true, structuredContent: { error: { code: 'not_supported' } } })
    } finally { await reader.close() }
    const editor = await session('management-editor', false)
    const call = async (name: string, args = {}) => {
      const out = await editor.call(name, args)
      expect(out.isError, JSON.stringify(out)).not.toBe(true)
      return out.structuredContent!.output!
    }
    try {
      const design = (await call('design_new', { name: 'Block' })).design
      await call('geom_extrude', { design, shape: { type: 'rectangle', widthMm: 20, heightMm: 10 }, distance_mm: 3 })
      const initial = (await editor.read()).objects.find((o) => o.id === design)!
      expect((await call('project_rename', { object: design, name: 'Renamed block' })).objects[0]!.name).toBe('Renamed block')
      const laid = (await call('project_lay_on_face', { object: design, normal: [1, 0, 0] })).objects[0]!
      expect(laid.minMm[2]).toBeCloseTo(0)
      expect(laid.sizeMm[2]).toBeCloseTo(initial.sizeMm[0]!)
      const copied = await call('project_duplicate', { object: design, count: 2 })
      expect(copied).toMatchObject({ requested: 2, created: 2 })
      expect(copied.objects).toHaveLength(2)
      expect(copied.objects.every((o) => o.id !== design && o.name === 'Renamed block')).toBe(true)
      const all = (await editor.read()).objects
      for (const row of copied.objects) expect(all.find((o) => o.id === row.id)).toEqual(row)
      const removed = await call('project_remove_object', { object: design })
      expect(removed.removed).toEqual([design])
      expect((await editor.read()).objects.some((o) => o.id === design)).toBe(false)
      expect(copied.ids.every((id) => removed.objects.some((o) => o.id === id))).toBe(true)
      const toolbar = page.getByTestId('plate-tools-group')
      await toolbar.getByRole('button', { name: 'Undo', exact: true }).click()
      expect((await editor.read()).objects.find((o) => o.id === design)).toEqual(laid)
      await toolbar.getByRole('button', { name: 'Undo', exact: true }).click()
      expect((await editor.read()).objects.some((o) => copied.ids.includes(o.id))).toBe(false)
      await toolbar.getByRole('button', { name: 'Undo', exact: true }).click()
      expect((await editor.read()).objects.find((o) => o.id === design)!.sizeMm).toEqual(initial.sizeMm)
      await toolbar.getByRole('button', { name: 'Undo', exact: true }).click()
      expect((await editor.read()).objects.find((o) => o.id === design)!.name).toBe('Block')
    } finally { await editor.close() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
