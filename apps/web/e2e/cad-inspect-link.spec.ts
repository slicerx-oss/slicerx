// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { hub, seed, useBridge } from './bridge-hub'
import { expect, plateReady, test } from './fixtures'

useBridge([], async () => { await hub.admin.settings.set({ appLink: true }) }, { hostAppLink: true })
const from = createRequire(join(import.meta.dirname, '../../../packages/mcp/package.json'))
type Output = { design?: string; steps?: number; in?: string; parts?: { volumeMm3: number; watertight: boolean }[]; measurement?: { distanceMm: number } }
type Answer = { isError?: boolean; structuredContent?: { output?: Output; error?: { code: string } } }

test('shell and measurement commands operate on the live body with read and edit grants', async ({ page }) => {
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
  const dir = mkdtempSync(join(tmpdir(), 'sx-cad-inspect-'))
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
    const editor = await session('cad-editor', false)
    try {
      const created = await editor.call('design_new', { name: 'Measured tray' })
      const design = created.structuredContent!.output!.design!
      expect((await editor.call('geom_extrude', { design, shape: { type: 'rectangle', widthMm: 20, heightMm: 10 }, distance_mm: 8 })).isError).not.toBe(true)
      const shell = { design, open: [{ at: [0, 0, 8], normal: [0, 0, 1] }], wall_mm: 1 }
      const reader = await session('cad-reader', true)
      try {
        expect(await reader.call('geom_info', { design })).toMatchObject({ structuredContent: { output: { in: 'app', parts: [{ watertight: true, volumeMm3: expect.closeTo(1600, 4) }] } } })
        expect(await reader.call('geom_shell', shell)).toMatchObject({ isError: true, structuredContent: { error: { code: 'not_supported' } } })
        const made = await editor.call('geom_shell', shell)
        expect(made).toMatchObject({ structuredContent: { output: { in: 'app', steps: 2 } } })
        const now = await reader.call('geom_info', { design })
        expect(now).toMatchObject({ structuredContent: { output: { parts: [{ watertight: true, volumeMm3: expect.closeTo(592, 3) }] } } })
        expect(await reader.call('geom_measure', { design, a: { at: [0, 0, 1], normal: [0, 0, 1] }, b: { at: [0, 0, 0], normal: [0, 0, -1] } })).toMatchObject({ structuredContent: { output: { in: 'app', measurement: { distanceMm: 1 } } } })
        expect(await reader.call('geom_info', { design, step: 1 })).toMatchObject({ structuredContent: { output: { parts: [{ volumeMm3: expect.closeTo(1600, 4) }] } } })
        expect(await reader.call('geom_measure', { design, step: 1, a: { at: [0, 0, 8], normal: [0, 0, 1] }, b: { at: [0, 0, 0], normal: [0, 0, -1] } })).toMatchObject({ structuredContent: { output: { measurement: { distanceMm: 8 } } } })
        expect(await reader.call('geom_info', { design })).toEqual(now)
        expect(JSON.stringify([made, now])).not.toMatch(/positions|indices/)
        expect((await editor.call('design_undo', { design })).isError).not.toBe(true)
        expect(await reader.call('geom_info', { design })).toMatchObject({ structuredContent: { output: { parts: [{ volumeMm3: expect.closeTo(1600, 4) }] } } })

        // A code-only CLI client reaches each command but cannot bypass the app's grant.
        const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('SLICERX_')))
        for (const [tool, args] of [['geom_info', { design }], ['geom_measure', { design, a: { at: [0, 0, 8] } }], ['geom_shell', shell]] as const) {
          const result = await promisify(execFile)(process.execPath, [join(import.meta.dirname, '../../../packages/mcp/dist/cli.js'), '--app', '--link-url', hub.linkUrl, '--sx-bin', process.env['SX_CLI_BIN']!, '--out-dir', join(dir, 'cli'), '--profiles-dir', join(dir, 'profiles'), '--policy', policyFile, 'call', tool, JSON.stringify(args), 'design_list'], { env: { ...env, SLICERX_MCP_LINK_CODE: hub.code, SLICERX_MCP_LINK_HUB_KEY: hub.admin.hubKey }, timeout: 30_000 }).then(() => { throw new Error('Expected grant refusal') }, (e: unknown) => e as { code: number; stdout: string })
          expect(result.code).toBe(1)
          const rows = result.stdout.trim().split('\n').map((line) => JSON.parse(line))
          expect(rows).toHaveLength(1)
          expect(rows[0]).toMatchObject({ tool: `slicerx_${tool}`, ok: false, output: { error: { code: 'not_configured' } } })
        }
      } finally { await reader.close() }
    } finally { await editor.close() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
