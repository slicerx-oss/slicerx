// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { hub, seed, useBridge } from './bridge-hub'
import { expectFileDialog, interceptFileDialogs } from './file-dialog'
import { expect, plateReady, test } from './fixtures'
import { plateProject } from './plate-project'

useBridge([], async () => { await hub.admin.settings.set({ appLink: true }) }, { hostAppLink: true })
const from = createRequire(join(import.meta.dirname, '../../../packages/mcp/package.json'))
let runtimeDir: string | undefined
test.beforeAll(async () => {
  // An isolated bundle uses this checkout's commands without replacing another test's runtime.
  const { build } = await import(pathToFileURL(from.resolve('esbuild')).href)
  runtimeDir = mkdtempSync(join(import.meta.dirname, '../../../packages/mcp/.plate-runtime-'))
  await build({
    entryPoints: [join(import.meta.dirname, '../../../packages/mcp/src/index.ts')], outfile: join(runtimeDir, 'index.mjs'),
    bundle: true, platform: 'node', format: 'esm', target: 'node24', logLevel: 'warning',
    external: ['@modelcontextprotocol/sdk', 'zod', 'yaml', '@noble/*'],
  })
})
test.afterAll(() => { if (runtimeDir) rmSync(runtimeDir, { recursive: true, force: true }) })
type Entry = { id: string; transform: number[]; sizeMm: number[] }
type State = { shown: number; count: number; changedPlate?: string; plates: { id: string; name: string; objects: number; settings: Record<string, unknown>; entries: Entry[] }[] }
type Answer = { isError?: boolean; structuredContent?: { output?: State; error?: { code: string } } }

test('plate edits through the hub preserve read grants, read back objects, and share toolbar Undo', async ({ page }) => {
  test.slow()
  const hosting: string[] = []
  page.on('console', (m) => { if (m.text().startsWith('[app link]')) hosting.push(m.text()) })
  await page.addInitScript((shell) => Object.assign(window, { __sxTestShell: shell }), { url: hub.linkUrl, code: hub.code, hubKey: hub.admin.hubKey })
  interceptFileDialogs(page)
  await seed(page)
  await plateReady(page)
  await expect.poll(() => hosting.join('\n'), { timeout: 30_000 }).toContain('this window hosts the app link')
  const chooser = await expectFileDialog(page, () => page.keyboard.press('ControlOrMeta+o'))
  await chooser.setFiles({ name: 'Parts.3mf', mimeType: 'model/3mf', buffer: plateProject(['Base', 'Lid']) })
  await expect(page.getByTestId('plate-picker-current').locator('.pp-of')).toHaveText('of 2', { timeout: 60_000 })

  const { Client } = await import(pathToFileURL(from.resolve('@modelcontextprotocol/sdk/client/index.js')).href)
  const { InMemoryTransport } = await import(pathToFileURL(from.resolve('@modelcontextprotocol/sdk/inMemory.js')).href)
  const { createContext, createSlicerxServer } = await import(pathToFileURL(join(runtimeDir!, 'index.mjs')).href)
  const dir = mkdtempSync(join(tmpdir(), 'sx-plate-edits-'))
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
    const pending = call('app_plates')
    const grant = page.getByTestId(readOnly ? 'app-link-read' : 'app-link-allow')
    await expect(grant).toBeEnabled({ timeout: 30_000 })
    await grant.click()
    const first = await pending
    expect(first.isError).not.toBe(true)
    return { call, first: first.structuredContent!.output!, close: async () => { await client.close(); await server.close(); ctx.printers?.close?.() } }
  }
  try {
    const reader = await session('plate-reader', true)
    try {
      const objects = reader.first.plates[0]!.entries.map((o) => o.id)
      for (const [tool, args] of [
        ['add', { name: 'Denied' }], ['duplicate', { plate: 1 }], ['rename', { plate: 1, name: 'Denied' }],
        ['settings', { plate: 1, settings: { bedType: 'cool' } }], ['remove', { plate: 1, deleteObjects: true }], ['move', { plate: 2, objects }],
      ] as const) expect(await reader.call(`app_plate_${tool}`, args)).toMatchObject({ isError: true, structuredContent: { error: { code: 'not_supported' } } })
      expect((await reader.call('app_plates')).structuredContent!.output).toEqual(reader.first)
    } finally { await reader.close() }

    const editor = await session('plate-editor', false)
    const call = async (name: string, args = {}) => {
      const out = await editor.call(name, args)
      expect(out.isError, JSON.stringify(out)).not.toBe(true)
      return out.structuredContent!.output!
    }
    try {
      const original = await call('app_plates')
      const source = original.plates[0]!
      const object = source.entries[0]!
      expect(object.sizeMm).toEqual([8, 8, 8])
      const added = await call('app_plate_add', { name: 'Spare', settings: { sequence: 'by-object' } })
      const spare = added.changedPlate!
      expect(added).toMatchObject({ count: 3, shown: 3, plates: [{}, {}, { id: spare, name: 'Spare', settings: { sequence: 'by-object' }, entries: [] }] })
      await expect(page.getByTestId('plate-picker-current').locator('.pp-no')).toHaveText('Plate 3')
      await call('app_plate_show', { plate: source.id })
      const moved = await call('app_plate_move', { plate: spare, objects: [object.id] })
      expect(moved.plates[0]!.entries).toEqual([])
      expect(moved.plates[2]!.entries[0]).toMatchObject({ id: object.id, sizeMm: object.sizeMm })
      await page.getByTestId('plate-tools-group').getByRole('button', { name: 'Undo', exact: true }).click()
      expect((await call('app_plates')).plates[0]!.entries).toEqual(source.entries)
      await page.getByTestId('plate-tools-group').getByRole('button', { name: 'Redo', exact: true }).click()
      expect((await call('app_plates')).plates).toEqual(moved.plates)
      const copy = await call('app_plate_duplicate', { plate: spare, name: 'Spare copy' })
      expect(copy.count).toBe(4)
      const copyId = copy.changedPlate!
      const copied = copy.plates.find((p) => p.id === copyId)!
      expect(copied.entries[0]!.id).not.toBe(object.id)
      expect(copied.entries[0]!.transform).toEqual(moved.plates[2]!.entries[0]!.transform)
      await call('app_plate_rename', { plate: copyId, name: 'Top' })
      const configured = await call('app_plate_settings', { plate: copyId, settings: { bedType: 'textured-pei', filamentOrder: [1] } })
      expect(configured.plates.find((p) => p.id === copyId)).toMatchObject({ name: 'Top', settings: { sequence: 'by-object', bedType: 'textured-pei', filamentOrder: [1] } })
      const beforeDelete = await call('app_plates')
      expect(await editor.call('app_plate_remove', { plate: copyId })).toMatchObject({ isError: true, structuredContent: { error: { code: 'not_supported' } } })
      expect(await call('app_plates')).toEqual(beforeDelete)
      const removed = await call('app_plate_remove', { plate: copyId, deleteObjects: true })
      expect(removed.count).toBe(3)
      expect(removed.plates.some((p) => p.id === copyId)).toBe(false)
      await page.getByTestId('plate-tools-group').getByRole('button', { name: 'Undo', exact: true }).click()
      expect(await call('app_plates')).toEqual(beforeDelete)
      const cleared = await call('app_plate_settings', { plate: copyId, settings: {}, replace: true })
      expect(cleared.plates.find((p) => p.id === copyId)!.settings).toEqual({})
    } finally { await editor.close() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
