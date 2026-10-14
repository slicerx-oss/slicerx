// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { withWindowsCredential } from '../../../packages/mcp/test/helpers/windows-credential'
import { hub, seed, useBridge } from './bridge-hub'
import { expect, plateReady, test } from './fixtures'

useBridge([], async () => { await hub.admin.settings.set({ appLink: true }) }, { hostAppLink: true })
const from = createRequire(join(import.meta.dirname, '../../../packages/mcp/package.json'))
let runtimeDir: string | undefined
test.beforeAll(async () => {
  const { build } = await import(pathToFileURL(from.resolve('esbuild')).href)
  runtimeDir = mkdtempSync(join(import.meta.dirname, '../../../packages/mcp/.object-runtime-'))
  await build({ entryPoints: [join(import.meta.dirname, '../../../packages/mcp/src/index.ts')], outfile: join(runtimeDir, 'index.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node24', logLevel: 'warning', external: ['@modelcontextprotocol/sdk', 'zod', 'yaml', '@noble/*'] })
})
test.afterAll(() => { if (runtimeDir) rmSync(runtimeDir, { recursive: true, force: true }) })


type Row = { id: string; parts: number; locked: boolean; printable: boolean; minMm: number[]; maxMm: number[]; sizeMm: number[]; partDetails: { name: string; slot: number }[] }
type State = { design: string; objects: Row[]; parts: number; ids: string[] }
type Answer = { isError?: boolean; structuredContent?: { output?: State; error?: { code: string } } }

test('clients edit live objects with read-back and toolbar Undo while the command line refuses partner access', async ({ page }) => {
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
  const dir = mkdtempSync(join(tmpdir(), 'sx-object-link-'))
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
    const reader = await session('object-reader', true)
    try {
      for (const name of ['project_lock', 'project_printable', 'project_center', 'project_split_parts', 'project_split_objects']) {
        expect(await reader.call(name, { object: 'unknown', ...(name === 'project_printable' ? { printable: false } : {}) })).toMatchObject({ isError: true, structuredContent: { error: { code: 'not_supported' } } })
      }
    } finally { await reader.close() }
    const editor = await session('object-editor', false)
    const call = async (name: string, args = {}) => {
      const out = await editor.call(name, args)
      expect(out.isError, JSON.stringify(out)).not.toBe(true)
      return out.structuredContent!.output!
    }
    try {
      const design = (await call('design_new', { name: 'Two bodies' })).design
      await call('geom_extrude', { design, shape: { type: 'rectangle', widthMm: 20, heightMm: 10 }, distance_mm: 3 })
      await call('geom_extrude', { design, shape: { type: 'rectangle', widthMm: 4, heightMm: 4 }, frame: { origin: [30, 0, 0], normal: [0, 0, 1] }, distance_mm: 2 })
      await call('geom_boolean', { design, op: 'union', part: 0, with_parts: [1] })
      const initial = (await editor.read()).objects.find((o) => o.id === design)!
      expect(initial.parts).toBe(1)
      const moved = await call('project_move', { object: design, x: 50, y: 60 })
      expect(moved.objects[0]!.sizeMm).toEqual(initial.sizeMm)
      expect(moved.objects[0]).toEqual((await editor.read()).objects.find((o) => o.id === design))
      expect((await call('project_lock', { object: design })).objects[0]!.locked).toBe(true)
      expect(await editor.call('project_center', { object: design })).toMatchObject({ isError: true, structuredContent: { error: { code: 'not_supported' } } })
      await call('project_lock', { object: design, locked: false })
      const before = (await editor.read()).objects.find((o) => o.id === design)!
      const { clientKey } = await hub.admin.clients.create('command client', 'agent', { partner: true })
      const commands = [
        ['project_center', { object: design }],
        ['project_lock', { object: design }],
        ['project_printable', { object: design, printable: false }],
        ['project_lock', { object: design, locked: false }],
        ['project_split_parts', { object: design }],
        ['project_split_objects', { object: design }],
      ] as const
      const refusal = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/cli.ts', '--engine', 'sx', '--sx-bin', process.env['SX_CLI_BIN']!, '--printers', 'link', '--link-url', hub.linkUrl, '--app', '--policy', policyFile, '--out-dir', join(dir, 'cli'), '--profiles-dir', join(dir, 'profiles'), 'call', 'project_center', JSON.stringify({ object: design })], {
        cwd: join(import.meta.dirname, '../../../packages/mcp'), timeout: 60_000, env: { ...process.env, SLICERX_MCP_LINK_KEY_REF: '', SLICERX_MCP_LINK_KEY: clientKey, SLICERX_MCP_LINK_HUB_KEY: hub.admin.hubKey },
      }).then(() => { throw new Error('The partner command unexpectedly succeeded') }, (error: { code: number; stdout: string }) => error)
      expect(refusal.code).toBe(1)
      expect(JSON.parse(refusal.stdout.trim())).toMatchObject({ ok: false, output: { error: { code: 'not_configured' } } })
      expect((await editor.read()).objects.find((o) => o.id === design)).toEqual(before)
      const answers: State[] = []
      for (const [name, args] of commands) answers.push(await call(name, args))
      expect(answers).toHaveLength(6)
      expect(answers[1]!.objects[0]!.locked).toBe(true)
      expect(answers[2]!.objects[0]!.printable).toBe(false)
      expect(answers[4]!.parts).toBe(2)
      const pieces = answers[5]!.objects
      expect(pieces).toHaveLength(2)
      expect(pieces.every((o) => o.parts === 1 && !o.locked && !o.printable)).toBe(true)
      expect((await editor.read()).objects.filter((o) => pieces.some((p) => p.id === o.id))).toEqual(pieces)
      expect((await editor.read()).objects.some((o) => o.id === design)).toBe(false)
      const toolbar = page.getByTestId('plate-tools-group')
      await toolbar.getByRole('button', { name: 'Undo', exact: true }).click()
      expect((await editor.read()).objects.find((o) => o.id === design)).toMatchObject({ parts: 2, printable: false })
      await toolbar.getByRole('button', { name: 'Undo', exact: true }).click()
      expect((await editor.read()).objects.find((o) => o.id === design)).toMatchObject({ parts: 1, printable: false, sizeMm: before.sizeMm })
      if (process.platform === 'win32') {
        const { clientKey: cliKey } = await hub.admin.clients.create('object-native-editor', 'agent')
        expect(cliKey).toBeTruthy()
        await withWindowsCredential(cliKey!, async (ref, identifier) => {
          const env = { ...process.env }
          for (const name of Object.keys(env)) if (name.startsWith('SLICERX_MCP_')) delete env[name]
          const cli = join(import.meta.dirname, '../../../packages/mcp/dist/cli.js')
          Object.assign(env, { SLICERX_MCP_LINK_KEY_REF: ref, SLICERX_MCP_APP_IDENTIFIER: identifier, SLICERX_MCP_LINK_URL: hub.linkUrl, SLICERX_MCP_LINK_HUB_KEY: hub.admin.hubKey, SLICERX_MCP_CLI: cli, SLICERX_NODE_BIN: process.execPath })
          const native = process.env['SX_MCP_CALL_BIN']
          const commands = [
            ['project_move', { object: design, x: 50, y: 60 }],
            ['project_center', { object: design }],
            ['project_lock', { object: design, locked: true }],
            ['project_printable', { object: design, printable: true }],
            ['project_lock', { object: design, locked: false }],
            ['project_split_parts', { object: design }],
            ['project_split_objects', { object: design }],
          ] as const
          const pending = promisify(execFile)(native || process.execPath, [...(native ? [] : [cli]), 'call', '--app', '--engine', 'sx', '--sx-bin', process.env['SX_CLI_BIN']!, '--out-dir', join(dir, 'native'), '--profiles-dir', join(dir, 'profiles'), '--policy', policyFile, ...commands.flatMap(([name, args]) => [name, JSON.stringify(args)])], { env, windowsHide: true, timeout: 90_000 })
          await expect(page.getByTestId('app-link-allow')).toBeEnabled({ timeout: 30_000 })
          await page.getByTestId('app-link-allow').click()
          const result = await pending
          expect(`${result.stdout}${result.stderr}`).not.toContain(cliKey)
          const lines = result.stdout.trim().split('\n').map((line) => JSON.parse(line))
          expect(lines).toHaveLength(commands.length)
          lines.forEach((line) => expect(line.ok, JSON.stringify(line)).toBe(true))
          const rows = lines.map((line) => line.output.output as State)
          expect(rows[1]!.objects[0]!.minMm).not.toEqual(rows[0]!.objects[0]!.minMm)
          expect(rows[2]!.objects[0]!.locked).toBe(true)
          expect(rows[3]!.objects[0]!.printable).toBe(true)
          expect(rows[4]!.objects[0]!.locked).toBe(false)
          expect(rows[5]!.parts).toBe(2)
          const split = rows[6]!.objects
          expect(split).toHaveLength(2)
          expect(split.every((o) => o.parts === 1 && !o.locked && o.printable)).toBe(true)
          const final = (await editor.read()).objects
          expect(final.some((o) => o.id === design)).toBe(false)
          for (const part of split) expect(final.find((o) => o.id === part.id)).toEqual(part)
          await toolbar.getByRole('button', { name: 'Undo', exact: true }).click()
          expect((await editor.read()).objects.find((o) => o.id === design)).toMatchObject({ parts: 2, printable: true })
          await toolbar.getByRole('button', { name: 'Undo', exact: true }).click()
          expect((await editor.read()).objects.find((o) => o.id === design)).toMatchObject({ parts: 1, printable: true, sizeMm: before.sizeMm })
        })
      }
    } finally { await editor.close() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
