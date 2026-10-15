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
import { expect, plateReady, tab, test } from './fixtures'
import { command } from './cad-helpers'

useBridge([], async () => { await hub.admin.settings.set({ appLink: true }) }, { hostAppLink: true })
const repo = join(import.meta.dirname, '../../..')
const from = createRequire(join(repo, 'packages/mcp/package.json'))
let runtimeDir: string | undefined
test.beforeAll(async () => {
  const { build } = await import(pathToFileURL(from.resolve('esbuild')).href)
  runtimeDir = mkdtempSync(join(repo, 'packages/mcp/.dimensions-runtime-'))
  await build({ entryPoints: [join(repo, 'packages/mcp/src/index.ts')], outfile: join(runtimeDir, 'index.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node24', logLevel: 'warning', external: ['@modelcontextprotocol/sdk', 'zod', 'yaml', '@noble/*'] })
})
test.afterAll(() => { if (runtimeDir) rmSync(runtimeDir, { recursive: true, force: true }) })

test('clients keep real dimensions with visible read-back, permissions, native CLI and toolbar Undo', async ({ page }) => {
  test.slow()
  page.setDefaultTimeout(30_000)
  const hosting: string[] = []
  page.on('console', (m) => { if (m.text().startsWith('[app link]')) hosting.push(m.text()) })
  await page.addInitScript((shell) => Object.assign(window, { __sxTestShell: shell }), { url: hub.linkUrl, code: hub.code, hubKey: hub.admin.hubKey })
  await page.addInitScript(() => localStorage.setItem('slicerx.debug', '1'))
  await seed(page)
  await plateReady(page)
  await tab(page, 'model').click()
  await expect.poll(() => hosting.join('\n'), { timeout: 30_000 }).toContain('this window hosts the app link')
  const { Client } = await import(pathToFileURL(from.resolve('@modelcontextprotocol/sdk/client/index.js')).href)
  const { InMemoryTransport } = await import(pathToFileURL(from.resolve('@modelcontextprotocol/sdk/inMemory.js')).href)
  const { createContext, createSlicerxServer } = await import(pathToFileURL(join(runtimeDir!, 'index.mjs')).href)
  const dir = mkdtempSync(join(tmpdir(), 'sx-dimensions-link-'))
  const policyFile = join(dir, 'policy.json')
  writeFileSync(policyFile, '{}')
  const session = async (name: string, readOnly: boolean) => {
    const { clientKey } = await hub.admin.clients.create(name, 'agent')
    const ctx = await createContext({ engine: 'sx', sxBin: process.env['SX_CLI_BIN'], printers: 'link', linkUrl: hub.linkUrl, linkHubKey: hub.admin.hubKey, linkClientKey: clientKey, app: 'required', outDir: join(dir, name), profilesDir: join(dir, 'profiles'), policyFile })
    const server = createSlicerxServer(ctx)
    const client = new Client({ name, version: '0.0.0' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(a), client.connect(b)])
    await client.listTools()
    const raw = (name: string, args = {}) => client.callTool({ name: `slicerx_${name}`, arguments: args }, undefined, { timeout: 60_000 })
    const pending = raw('app_dimensions')
    const grant = page.getByTestId(readOnly ? 'app-link-read' : 'app-link-allow')
    await expect(grant).toBeEnabled({ timeout: 30_000 })
    await grant.click()
    expect((await pending).isError).not.toBe(true)
    const call = async (name: string, args = {}) => {
      const result = await raw(name, args)
      expect(result.isError, JSON.stringify(result)).not.toBe(true)
      return result.structuredContent.output
    }
    return { raw, call, clientKey, close: async () => { await client.close(); await server.close(); ctx.printers?.close?.() } }
  }
  const editor = await session('dimension-editor', false)
  try {
    const prior = await editor.call('app_history')
    const known = new Set(prior.plates.flatMap((p: { objects: { id: string }[] }) => p.objects.map((o) => o.id)))
    await command(page, 'Add a box')
    const added = async () => {
      const current = await editor.call('app_history')
      return current.plates.flatMap((p: { objects: { id: string; sizeMm: number[] }[] }) => p.objects).filter((o: { id: string }) => !known.has(o.id))
    }
    await expect.poll(async () => (await added()).length).toBe(1)
    const box = (await added())[0]
    const id: string = box.id
    const height: number = box.sizeMm[2]
    expect(height).toBeCloseTo(20)
    const listed = await editor.call('geom_faces', { design: id })
    type Face = { part: number; triangle: number; at: number[]; normal: number[] }
    const top = listed.faces.find((f: Face) => f.normal[2]! > 0.99) as Face
    const bottom = listed.faces.find((f: Face) => f.normal[2]! < -0.99) as Face
    expect(top).toBeTruthy()
    expect(bottom).toBeTruthy()
    const pick = (p: Face) => ({ object: id, part: p.part, triangle: p.triangle, at: p.at })
    const request = { kind: 'distance', a: pick(top), b: pick(bottom) }
    const read = () => editor.call('app_dimensions')
    const before = await editor.call('app_history')
    await command(page, 'Measure distance, angle and radius')
    const kept = await editor.call('app_dimension_keep', request)
    expect(kept.dimensions).toHaveLength(1)
    expect(kept.dimensions[0]).toMatchObject({ id: kept.kept, status: 'ok', unit: 'mm', visible: true })
    expect(kept.dimensions[0].value).toBeCloseTo(height)
    expect((await read()).dimensions).toEqual(kept.dimensions)
    expect((await editor.call('app_history')).undo).toBe(before.undo + 1)
    const list = page.getByRole('list', { name: 'Kept dimensions' })
    await expect(list).toContainText(`${height.toFixed(2)} mm`)
    const drawn = () => page.evaluate(() => {
      const group = (window as unknown as { __vp: { dims: { group: { children: { type: string; geometry?: { attributes: { position: { array: ArrayLike<number> } } } }[] } } } }).__vp.dims.group
      return Array.from(group.children.find((c) => c.type === 'LineSegments')?.geometry?.attributes.position.array ?? [])
    })
    await expect.poll(async () => (await drawn()).length).toBe(6)
    const vertices = await drawn()
    const annotation = kept.dimensions[0].annotation
    vertices.forEach((v, i) => expect(v).toBeCloseTo([...annotation.from, ...annotation.to][i], 3))
    const show = page.getByRole('switch', { name: 'Show all kept dimensions' })
    const revision = (await editor.call('app_history')).revision
    await expect(show).toHaveAttribute('aria-checked', 'false')
    await show.click()
    await expect(show).toHaveAttribute('aria-checked', 'true')
    expect((await read()).showAll).toBe(true)
    await editor.call('app_dimensions_show', { showAll: false })
    await expect(show).toHaveAttribute('aria-checked', 'false')
    expect((await editor.call('app_history')).revision).toBe(revision)
    const reader = await session('dimension-reader', true)
    try {
      expect(await reader.call('app_dimensions')).toMatchObject({ dimensions: [{ id: kept.kept }] })
      expect(await reader.raw('app_dimension_keep', request)).toMatchObject({ isError: true, structuredContent: { error: { code: 'not_supported' } } })
      expect(await reader.raw('app_dimension_remove', { dimension: kept.kept })).toMatchObject({ isError: true, structuredContent: { error: { code: 'not_supported' } } })
    } finally { await reader.close() }
    expect(await editor.raw('app_dimension_keep', { ...request, value: 999 })).toMatchObject({ isError: true })
    expect((await read()).dimensions).toEqual(kept.dimensions)
    await page.getByRole('button', { name: 'Done', exact: true }).click()
    await editor.call('project_scale', { object: id, scale: [1, 1, 2] })
    expect((await read()).dimensions[0].value).toBeCloseTo(height * 2)
    const undo = page.getByTestId('plate-tools-group').getByRole('button', { name: 'Undo', exact: true })
    await undo.click()
    expect((await read()).dimensions[0].value).toBeCloseTo(height)
    if (process.platform === 'win32') {
      await withWindowsCredential(editor.clientKey!, async (ref, identifier) => {
        const env = { ...process.env }
        for (const key of Object.keys(env)) if (key.startsWith('SLICERX_MCP_')) delete env[key]
        Object.assign(env, { SLICERX_MCP_LINK_KEY_REF: ref, SLICERX_MCP_APP_IDENTIFIER: identifier, SLICERX_MCP_LINK_URL: hub.linkUrl, SLICERX_MCP_LINK_HUB_KEY: hub.admin.hubKey, SLICERX_MCP_CLI: join(repo, 'packages/mcp/dist/cli.js'), SLICERX_NODE_BIN: process.execPath })
        const native = process.env['SX_CLI_BIN']!
        expect(native).toBeTruthy()
        const result = await promisify(execFile)(native, ['call', '--app', '--engine', 'sx', '--sx-bin', native, '--policy', policyFile, '--out-dir', join(dir, 'cli'), '--profiles-dir', join(dir, 'profiles'), 'app_dimension_remove', JSON.stringify({ dimension: kept.kept }), 'app_dimensions'], { env, windowsHide: true, timeout: 60_000 })
        expect(result.stdout + result.stderr).not.toContain(editor.clientKey)
        const rows = result.stdout.trim().split('\n').map((line) => JSON.parse(line))
        expect(rows).toHaveLength(2)
        for (const row of rows) { expect(row.ok).toBe(true); expect(row.output.output.dimensions).toEqual([]) }
        expect(rows[0].output.output.removed).toBe(kept.kept)
        expect((await read()).dimensions).toEqual([])
      })
      await expect.poll(async () => (await drawn()).length).toBe(0)
      await undo.click()
      expect((await read()).dimensions[0].id).toBe(kept.kept)
    }
    await command(page, 'Measure distance, angle and radius')
    await expect(list).toContainText(`${height.toFixed(2)} mm`)
    await list.getByRole('button', { name: 'Remove the distance' }).click()
    expect((await read()).dimensions).toEqual([])
  } finally { await editor.close(); rmSync(dir, { recursive: true, force: true }) }
})
