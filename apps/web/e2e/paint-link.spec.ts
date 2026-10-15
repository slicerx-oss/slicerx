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
import { expect, plateReady, test } from './fixtures'

useBridge([], async () => { await hub.admin.settings.set({ appLink: true }) }, { hostAppLink: true })
const repo = join(import.meta.dirname, '../../..')
const from = createRequire(join(repo, 'packages/mcp/package.json'))
let runtimeDir: string | undefined
test.beforeAll(async () => {
  const { build } = await import(pathToFileURL(from.resolve('esbuild')).href)
  runtimeDir = mkdtempSync(join(repo, 'packages/mcp/.paint-runtime-'))
  await build({ entryPoints: [join(repo, 'packages/mcp/src/index.ts')], outfile: join(runtimeDir, 'index.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node24', logLevel: 'warning', external: ['@modelcontextprotocol/sdk', 'zod', 'yaml', '@noble/*'] })
})
test.afterAll(() => { if (runtimeDir) rmSync(runtimeDir, { recursive: true, force: true }) })

type Paint = { preview?: string; revision: string; changed?: boolean; object: string; parts: { states: { state: number; areaMm2: number }[] }[] }
type Answer = { isError?: boolean; structuredContent?: { output?: Paint; error?: { code: string } } }

test('clients paint the live object through MCP and native CLI, read brush layers and undo', async ({ page }) => {
  test.slow()
  const hosting: string[] = []
  page.on('console', (m) => { if (m.text().startsWith('[app link]')) hosting.push(m.text()) })
  await page.addInitScript((shell) => { Object.assign(window, { __sxTestShell: shell }) }, { url: hub.linkUrl, code: hub.code, hubKey: hub.admin.hubKey })
  await seed(page)
  await plateReady(page)
  await expect.poll(() => hosting.join('\n'), { timeout: 30_000 }).toContain('this window hosts the app link')
  const { Client } = await import(pathToFileURL(from.resolve('@modelcontextprotocol/sdk/client/index.js')).href)
  const { InMemoryTransport } = await import(pathToFileURL(from.resolve('@modelcontextprotocol/sdk/inMemory.js')).href)
  const { createContext, createSlicerxServer } = await import(pathToFileURL(join(runtimeDir!, 'index.mjs')).href)
  const dir = mkdtempSync(join(tmpdir(), 'sx-paint-link-'))
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
    const pending = raw('app_history')
    const grant = page.getByTestId(readOnly ? 'app-link-read' : 'app-link-allow')
    await expect(grant).toBeEnabled({ timeout: 30_000 })
    await grant.click()
    const initial = await pending
    expect(initial.isError).not.toBe(true)
    const state = initial.structuredContent.output
    const object = state.plates.find((p: { id: string }) => p.id === state.activePlate).objects[0].id
    return { raw: raw as (name: string, args?: Record<string, unknown>) => Promise<Answer>, clientKey, object, close: async () => { await client.close(); await server.close(); ctx.printers?.close?.() } }
  }
  try {
    const reader = await session('paint-reader', true)
    try {
      const pv = (await reader.raw('app_paint_preview', { object: reader.object, layer: 'seam', state: 1, target: { kind: 'direction', direction: 'top' } })).structuredContent!.output!
      expect(pv.preview).toBeTruthy()
      expect(await reader.raw('app_paint_apply', { preview: pv.preview })).toMatchObject({ isError: true, structuredContent: { error: { code: 'not_supported' } } })
    } finally { await reader.close() }
    const editor = await session('paint-editor', false)
    try {
      const object = editor.object
      const call = async (name: string, args: Record<string, unknown>) => {
        const reply = await editor.raw(name, args)
        expect(reply.isError, JSON.stringify(reply)).not.toBe(true)
        return reply.structuredContent!.output!
      }
      const undo = page.getByTestId('plate-tools-group').getByRole('button', { name: 'Undo', exact: true })
      const exercise = async (native?: (name: string, args: Record<string, unknown>) => Promise<Paint>) => {
        const invoke = native ?? call
        for (const layer of ['color', 'seam', 'support', 'fuzzy']) {
          const initial = await invoke('app_paint', { object, layer })
          const pv = await invoke('app_paint_preview', { object, layer, state: 1, target: { kind: 'direction', direction: 'top' } })
          expect(pv.changed).toBe(true)
          expect((await call('app_paint', { object, layer })).parts).toEqual(initial.parts)
          const applied = await invoke('app_paint_apply', { preview: pv.preview })
          expect(applied.parts).toEqual(pv.parts)
          expect(applied.parts.flatMap((p) => p.states).some((s) => s.state === 1 && s.areaMm2 > 0)).toBe(true)
          expect((await call('app_paint', { object, layer })).parts).toEqual(applied.parts)
          await undo.click()
          expect((await call('app_paint', { object, layer })).parts).toEqual(initial.parts)
          const again = await call('app_paint_preview', { object, layer, state: 1, target: { kind: 'part' } })
          await call('app_paint_apply', { preview: again.preview })
          const painted = await call('app_paint', { object, layer })
          const cleared = await invoke('app_paint_clear', { object, layer, revision: painted.revision })
          expect(cleared.parts.every((p) => p.states.length === 0)).toBe(true)
          await undo.click()
          expect((await call('app_paint', { object, layer })).parts).toEqual(painted.parts)
          await undo.click()
          expect((await call('app_paint', { object, layer })).parts).toEqual(initial.parts)
        }
      }
      if (process.platform === 'win32') {
        await withWindowsCredential(editor.clientKey!, async (ref, identifier) => {
          const env = { ...process.env }
          for (const key of Object.keys(env)) if (key.startsWith('SLICERX_MCP_')) delete env[key]
          Object.assign(env, { SLICERX_MCP_LINK_KEY_REF: ref, SLICERX_MCP_APP_IDENTIFIER: identifier, SLICERX_MCP_LINK_URL: hub.linkUrl, SLICERX_MCP_LINK_HUB_KEY: hub.admin.hubKey, SLICERX_MCP_CLI: join(repo, 'packages/mcp/dist/cli.js'), SLICERX_NODE_BIN: process.execPath })
          const native = process.env['SX_CLI_BIN']!
          expect(native).toBeTruthy()
          await exercise(async (name, args) => {
            const result = await promisify(execFile)(native, ['call', '--app', '--engine', 'sx', '--sx-bin', native, '--policy', policyFile, '--out-dir', join(dir, 'cli'), '--profiles-dir', join(dir, 'profiles'), name, JSON.stringify(args)], { env, windowsHide: true, timeout: 60_000 })
            expect(result.stdout + result.stderr).not.toContain(editor.clientKey)
            const row = JSON.parse(result.stdout.trim())
            expect(row.ok, JSON.stringify(row)).toBe(true)
            return row.output.output
          })
        })
      } else await exercise()
      const pv = await call('app_paint_preview', { object, state: 1, target: { kind: 'part' } })
      const next = await call('app_paint_preview', { object, layer: 'support', state: 1, target: { kind: 'part' } })
      await call('app_paint_apply', { preview: next.preview })
      expect(await editor.raw('app_paint_apply', { preview: pv.preview })).toMatchObject({ isError: true, structuredContent: { error: { code: 'busy' } } })
      await undo.click()
    } finally { await editor.close() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

