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
  runtimeDir = mkdtempSync(join(import.meta.dirname, '../../../packages/mcp/.volumes-runtime-'))
  await build({ entryPoints: [join(import.meta.dirname, '../../../packages/mcp/src/index.ts')], outfile: join(runtimeDir, 'index.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node24', logLevel: 'warning', external: ['@modelcontextprotocol/sdk', 'zod', 'yaml', '@noble/*'] })
})
test.afterAll(() => { if (runtimeDir) rmSync(runtimeDir, { recursive: true, force: true }) })

type Volume = { id: string; role: string; settings: Record<string, unknown>; positionMm: number[]; sizeMm: number[] }
type Output = { design: string; object: { id: string }; volumes: Volume[]; changed?: string[]; removed?: string[]; consumedObject?: string }
type Answer = { isError?: boolean; structuredContent?: { output?: Output; error?: { code: string } } }

test('clients edit live volumes with read-back, permission checks and toolbar Undo', async ({ page }) => {
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
  const dir = mkdtempSync(join(tmpdir(), 'sx-volumes-link-'))
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
    const editor = await session('volume-editor', false)
    try {
      const call = async (name: string, args = {}) => {
        const out = await editor.call(name, args)
        expect(out.isError, JSON.stringify(out)).not.toBe(true)
        return out.structuredContent!.output!
      }
      const make = async (name: string) => {
        const design = (await call('design_new', { name })).design
        await call('geom_extrude', { design, shape: { type: 'rectangle', widthMm: 20, heightMm: 10 }, distance_mm: 3 })
        return design
      }
      const body = await make('Volume block')
      const read = () => call('app_volumes', { object: body })
      expect((await read()).volumes).toEqual([])
      const added = await call('app_volume_add', { object: body, role: 'modifier', shape: 'box', sizeMm: [8, 6, 3], settings: { wall_loops: 4 } })
      const id = added.changed![0]!
      expect(added.volumes[0]).toMatchObject({ id, role: 'modifier', settings: { wall_loops: 4 } })
      added.volumes[0]!.sizeMm.forEach((n, i) => expect(n).toBeCloseTo([8, 6, 3][i]!, 3))
      const changed = await call('app_volume_set', { object: body, volume: id, positionMm: [3, 2, 1], rotationDeg: [0, 0, 30], set: { wall_loops: 6 } })
      expect(changed.volumes[0]).toMatchObject({ positionMm: [3, 2, 1], settings: { wall_loops: 6 } })
      expect((await read()).volumes).toEqual(changed.volumes)
      expect(await editor.call('app_volume_set', { object: body, volume: id, positionMm: [8, 9, 10], set: { wall_loops: -2 } })).toMatchObject({ isError: true, structuredContent: { error: { code: 'invalid_input' } } })
      expect((await read()).volumes).toEqual(changed.volumes)
      const reader = await session('volume-reader', true)
      try {
        expect(await reader.call('app_volumes', { object: body })).toMatchObject({ structuredContent: { output: { volumes: [{ id, settings: { wall_loops: 6 } }] } } })
        const requests: [string, Record<string, unknown>][] = [
          ['app_volume_add', { object: body, role: 'negative', shape: 'box' }],
          ['app_volume_set', { object: body, volume: id, role: 'negative' }],
          ['app_volume_copy', { object: body, volume: id }],
          ['app_volume_remove', { object: body, volume: id }],
          ['app_volume_from_object', { object: body, source: body, role: 'negative' }],
        ]
        for (const [name, args] of requests) expect(await reader.call(name, args)).toMatchObject({ isError: true, structuredContent: { error: { code: 'not_supported' } } })
      } finally { await reader.close() }
      const undo = page.getByTestId('plate-tools-group').getByRole('button', { name: 'Undo', exact: true })
      await undo.click()
      expect((await read()).volumes[0]?.settings).toEqual({ wall_loops: 4 })
      const copied = await call('app_volume_copy', { object: body, volume: id })
      expect(copied.volumes).toHaveLength(2)
      expect(copied.changed![0]).not.toBe(id)
      const role = await call('app_volume_set', { object: body, volume: copied.changed![0], role: 'support_enforcer' })
      expect(role.volumes[1]).toMatchObject({ role: 'support_enforcer', settings: {} })
      const removed = await call('app_volume_remove', { object: body, volume: copied.changed![0] })
      expect(removed.volumes).toHaveLength(1)
      expect(removed.removed).toEqual(copied.changed)
      await undo.click()
      expect((await read()).volumes).toHaveLength(2)
      const source = await make('Cutter source')
      const converted = await call('app_volume_from_object', { object: body, source, role: 'support_blocker' })
      expect(converted.consumedObject).toBe(source)
      expect(converted.volumes).toHaveLength(3)
      expect(await editor.call('app_volumes', { object: source })).toMatchObject({ isError: true, structuredContent: { error: { code: 'not_found' } } })
      await undo.click()
      expect((await read()).volumes).toHaveLength(2)
      expect((await call('app_volumes', { object: source })).object.id).toBe(source)
      const movedCopy = await call('app_volume_copy', { object: body, volume: id, target: source })
      expect(movedCopy.object.id).toBe(source)
      expect(movedCopy.volumes[0]?.settings).toEqual({ wall_loops: 4 })
    } finally { await editor.close() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})