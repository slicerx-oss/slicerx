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
  runtimeDir = mkdtempSync(join(import.meta.dirname, '../../../packages/mcp/.reorder-runtime-'))
  await build({ entryPoints: [join(import.meta.dirname, '../../../packages/mcp/src/index.ts')], outfile: join(runtimeDir, 'index.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node24', logLevel: 'warning', external: ['@modelcontextprotocol/sdk', 'zod', 'yaml', '@noble/*'] })
})
test.afterAll(() => { if (runtimeDir) rmSync(runtimeDir, { recursive: true, force: true }) })

type State = { design: string; steps: { id: string; state: string; follows: unknown[] }[]; sizeMm: number[]; parts: { name: string; sizeMm: number[] }[]; detached?: unknown[]; items?: { kind: string; id: string; body?: string }[] }
type Answer = { isError?: boolean; structuredContent?: { ok?: boolean; output?: State; error?: { code: string } } }

test('a client reorders features through the hub, reads failures, and restores the order with toolbar Undo', async ({ page }) => {
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
  const dir = mkdtempSync(join(tmpdir(), 'sx-reorder-link-'))
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
    const reader = await session('feature-reader', true)
    try {
      expect(await reader.call('design_reorder_step', { design: 'unknown', step: 1, to: 1 })).toMatchObject({ isError: true, structuredContent: { error: { code: 'not_supported' } } })
    } finally { await reader.close() }
    const editor = await session('feature-editor', false)
    const call = async (name: string, args = {}) => {
      const out = await editor.call(name, args)
      expect(out.isError, JSON.stringify(out)).not.toBe(true)
      return out.structuredContent!.output!
    }
    try {
      const design = (await call('design_new', { name: 'Boss' })).design
      await call('geom_extrude', { design, shape: { type: 'rectangle', widthMm: 20, heightMm: 10 }, distance_mm: 3 })
      await call('geom_extrude', { design, shape: { type: 'rectangle', widthMm: 6, heightMm: 6 }, frame: { origin: [0, 0, 3], normal: [0, 0, 1] }, distance_mm: 4, operation: 'join' })
      await call('geom_push_pull', { design, face: { at: [0, 0, 7], normal: [0, 0, 1] }, distance_mm: 2 })
      const original = await call('design_steps', { design })
      expect(original.sizeMm).toEqual([20, 10, 9])
      const broken = await editor.call('design_reorder_step', { design, step: original.steps[2]!.id, to: 2 })
      expect(broken.isError).toBe(true)
      expect(broken.structuredContent!.ok).toBe(false)
      const changed = broken.structuredContent!.output!
      expect(changed.steps.map((s) => s.state)).toEqual(['done', 'broken', 'skipped'])
      expect(changed.detached).toHaveLength(1)
      expect((await call('design_steps', { design })).steps).toEqual(changed.steps)
      expect((await call('design_timeline')).items!.filter((i) => i.kind === 'feature' && i.body === design).map((i) => i.id)).toEqual(changed.steps.map((s) => s.id))
      const toolbar = page.getByTestId('plate-tools-group')
      await toolbar.getByRole('button', { name: 'Undo', exact: true }).click()
      expect((await call('design_steps', { design })).steps).toEqual(original.steps)
      expect((await call('design_timeline')).items!.filter((i) => i.kind === 'feature' && i.body === design).map((i) => i.id)).toEqual(original.steps.map((s) => s.id))
      await toolbar.getByRole('button', { name: 'Redo', exact: true }).click()
      expect((await call('design_steps', { design })).steps).toEqual(changed.steps)
      const restored = await call('design_reorder_step', { design, step: 2, to: 3 })
      expect(restored.steps.map((s) => s.id)).toEqual(original.steps.map((s) => s.id))
      expect(restored.steps.every((s) => s.state === 'done')).toBe(true)
      expect(restored.sizeMm).toEqual(original.sizeMm)
      // Creating a second body first must preserve both bodies and the later edit's target.
      const multi = (await call('design_new', { name: 'Two bodies' })).design
      await call('geom_extrude', { design: multi, name: 'Base', shape: { type: 'rectangle', widthMm: 20, heightMm: 10 }, distance_mm: 3 })
      await call('geom_extrude', { design: multi, name: 'Peg', shape: { type: 'rectangle', widthMm: 4, heightMm: 4 }, frame: { origin: [30, 0, 0], normal: [0, 0, 1] }, distance_mm: 2 })
      await call('geom_push_pull', { design: multi, face: { at: [0, 0, 3], normal: [0, 0, 1] }, distance_mm: 2 })
      const before = await call('design_steps', { design: multi })
      const reordered = await call('design_reorder_step', { design: multi, step: 2, to: 1 })
      expect(reordered.parts).toHaveLength(2)
      expect(reordered.sizeMm).toEqual(before.sizeMm)
      expect(reordered.parts.find((p) => p.name === 'Base')!.sizeMm).toEqual([20, 10, 5])
      expect(reordered.parts.find((p) => p.name === 'Peg')!.sizeMm).toEqual([4, 4, 2])
      await toolbar.getByRole('button', { name: 'Undo', exact: true }).click()
      expect((await call('design_steps', { design: multi })).steps).toEqual(before.steps)
    } finally { await editor.close() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
