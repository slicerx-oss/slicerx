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
type Row = { id: string; parts: number; minMm: number[]; sizeMm: number[]; printable: boolean }
type Output = { design?: string; changed?: boolean; removed?: string; ids?: string[]; objects?: Row[]; reports?: { report: { connectors: number[][]; belowVolumeMm3: number; aboveVolumeMm3: number } }[] }
type Answer = { isError?: boolean; structuredContent?: { output?: Output; error?: { code: string } } }

test('a client cuts the shown object with dowels, reads the actual pieces and restores it with toolbar Undo', async ({ page }) => {
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
  const dir = mkdtempSync(join(tmpdir(), 'sx-cut-link-'))
  const policyFile = join(dir, 'policy.json')
  writeFileSync(policyFile, '{}')
  const session = async (name: string, readOnly: boolean) => {
    const { clientKey } = await hub.admin.clients.create(name, 'agent')
    const ctx = await createContext({ engine: 'sx', sxBin: process.env['SX_CLI_BIN'], printers: 'link', linkUrl: hub.linkUrl, linkHubKey: hub.admin.hubKey, linkClientKey: clientKey, app: 'required', outDir: join(dir, name), profilesDir: join(dir, 'profiles'), policyFile })
    const server = createSlicerxServer(ctx)
    const client = new Client({ name, version: '0.0.0' })
    const [a,b] = InMemoryTransport.createLinkedPair()
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
    const reader = await session('cut-reader', true)
    try {
      expect(await reader.call('project_cut', { object: 'unknown', plane: { axis: 'z', at: 15 } })).toMatchObject({ isError: true, structuredContent: { error: { code: 'not_supported' } } })
    } finally { await reader.close() }
    const editor = await session('cut-editor', false)
    try {
      const call = async (name: string, args = {}) => {
        const out = await editor.call(name, args)
        expect(out.isError, JSON.stringify(out)).not.toBe(true)
        return out.structuredContent!.output!
      }
      const design = (await call('design_new', { name: 'Dowel block' })).design!
      await call('geom_extrude', { design, shape: { type: 'rectangle', widthMm: 60, heightMm: 40 }, distance_mm: 30 })
      const before = (await editor.read()).objects.find((e) => e.id === design)!
      const x = before.minMm[0]! + before.sizeMm[0]! / 2
      const y = before.minMm[1]! + before.sizeMm[1]! / 2
      const z = before.minMm[2]! + 15
      const positions = [[x-10,y,z],[x+10,y,z]]
      const cut = await call('project_cut', { object: design, plane: { axis: 'z', at: z }, connector: { kind: 'dowel', diameter_mm: 5, depth_mm: 6, positions } })
      expect(cut).toMatchObject({ changed: true, removed: design })
      expect(cut.ids).toHaveLength(4)
      expect(cut.reports![0]!.report.connectors).toEqual(positions)
      expect(cut.reports![0]!.report.belowVolumeMm3).toBeGreaterThan(0)
      const actual = (await editor.read()).objects
      expect(actual.some((e) => e.id === design)).toBe(false)
      expect(actual.filter((e) => cut.ids!.includes(e.id))).toEqual(cut.objects)
      const undo = page.getByTestId('plate-tools-group').getByRole('button', { name: 'Undo', exact: true })
      await undo.click()
      expect((await editor.read()).objects.find((e) => e.id === design)).toEqual(before)
      expect(await editor.call('project_cut', { object: design, plane: { point: [0,0,0], normal: [0,0,0] } })).toMatchObject({ isError: true })
      expect((await editor.read()).objects.find((e) => e.id === design)).toEqual(before)
    } finally { await editor.close() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
