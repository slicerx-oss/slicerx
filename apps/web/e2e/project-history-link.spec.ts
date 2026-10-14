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
type State = { revision: string; undo: number; redo: number; changed?: boolean; plates: { objects: { id: string; transform: number[]; minMm: number[]; sizeMm: number[] }[] }[] }
type Answer = { isError?: boolean; structuredContent?: { output?: State & { design?: string }; error?: { code: string } } }

test('project Undo and Redo share toolbar history and return restored geometry through the hub', async ({ page }) => {
  test.slow()
  const hosting: string[] = []
  page.on('console', (m) => { if (m.text().startsWith('[app link]')) hosting.push(m.text()) })
  await page.addInitScript((shell) => Object.assign(window, { __sxTestShell: shell }), { url: hub.linkUrl, code: hub.code, hubKey: hub.admin.hubKey })
  await seed(page)
  await plateReady(page)
  await expect.poll(() => hosting.join('\n'), { timeout: 30_000 }).toContain('this window hosts the app link')
  const { Client } = await import(pathToFileURL(from.resolve('@modelcontextprotocol/sdk/client/index.js')).href)
  const { InMemoryTransport } = await import(pathToFileURL(from.resolve('@modelcontextprotocol/sdk/inMemory.js')).href)
  const { createContext, createSlicerxServer } = await import(pathToFileURL(join(import.meta.dirname, '../../../packages/mcp/dist/index.js')).href)
  const dir = mkdtempSync(join(tmpdir(), 'sx-project-history-'))
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
    const pending = call('app_history')
    const grant = page.getByTestId(readOnly ? 'app-link-read' : 'app-link-allow')
    await expect(grant).toBeEnabled({ timeout: 30_000 })
    await grant.click()
    const first = await pending
    expect(first.isError).not.toBe(true)
    return { call, first: first.structuredContent!.output!, close: async () => { await client.close(); await server.close(); ctx.printers?.close?.() } }
  }
  try {
    const reader = await session('history-reader', true)
    try {
      expect(await reader.call('app_undo', { revision: reader.first.revision })).toMatchObject({ isError: true, structuredContent: { error: { code: 'not_supported' } } })
      expect(await reader.call('app_redo', { revision: reader.first.revision })).toMatchObject({ isError: true, structuredContent: { error: { code: 'not_supported' } } })
    } finally { await reader.close() }
    const editor = await session('history-editor', false)
    const state = async () => (await editor.call('app_history')).structuredContent!.output!
    try {
      const created = await editor.call('design_new', { name: 'History bracket' })
      const design = created.structuredContent!.output!.design!
      expect((await editor.call('geom_extrude', { design, shape: { type: 'rectangle', widthMm: 20, heightMm: 10 }, distance_mm: 3 })).isError).not.toBe(true)
      const before = await state()
      const original = before.plates.flatMap((p) => p.objects).find((o) => o.id === design)!
      expect(original.sizeMm).toEqual([20, 10, 3])
      expect((await editor.call('project_move', { object: design, x: 50, y: 60 })).isError).not.toBe(true)
      const moved = await state()
      expect(moved.plates[0]!.objects.find((o) => o.id === design)?.minMm).toEqual([40, 55, 0])
      expect(await editor.call('app_undo', { revision: before.revision })).toMatchObject({ isError: true, structuredContent: { error: { code: 'busy' } } })
      expect((await state()).revision).toBe(moved.revision)
      const undone = (await editor.call('app_undo', { revision: moved.revision })).structuredContent!.output!
      expect(undone).toMatchObject({ changed: true, redo: 1 })
      expect(undone.plates.flatMap((p) => p.objects).find((o) => o.id === design)).toMatchObject(original)
      // The toolbar uses the very same redo stack as the command.
      await page.getByRole('button', { name: 'Redo', exact: true }).click()
      const toolbar = await state()
      expect(toolbar.redo).toBe(0)
      expect(toolbar.plates).toEqual(moved.plates)
      const again = (await editor.call('app_undo', { revision: toolbar.revision })).structuredContent!.output!
      const redone = (await editor.call('app_redo', { revision: again.revision })).structuredContent!.output!
      expect(redone).toMatchObject({ changed: true, redo: 0 })
      expect(redone.plates).toEqual(moved.plates)
      expect(await editor.call('app_redo', { revision: redone.revision })).toMatchObject({ structuredContent: { output: { changed: false, revision: redone.revision } } })
    } finally { await editor.close() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
