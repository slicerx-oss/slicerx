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
type Output = { design?: string; steps?: number | { state: string }[]; in?: string; volumeMm3?: number; parts?: unknown[]; sizeMm?: number[] }
type Answer = { isError?: boolean; structuredContent?: { output?: Output; error?: { code: string } } }

test('mesh modeling commands edit live bodies with shared history and grant enforcement', async ({ page }) => {
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
  const dir = mkdtempSync(join(tmpdir(), 'sx-mesh-modeling-'))
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
    const editor = await session('modeling-editor', false)
    try {
      const reader = await session('modeling-reader', true)
      const cases: [string, Record<string, unknown>, number, number | undefined][] = [
        ['cut', { plane: { axis: 'z', at: 4 }, keep: 'both' }, 2, 1600],
        ['split', { build_volume_mm: [12, 12, 12], margin_mm: 0 }, 2, 1600],
        ['mirror', { plane: { axis: 'x', at: 20 }, copy: false }, 1, 1600],
        ['array', { spec: { kind: 'linear', count: 3, step: [25, 0, 0] }, merge: false }, 3, 4800],
        ['repair', {}, 1, 1600],
        ['hollow', { wall_mm: 1 }, 1, undefined],
        ['emboss', { text: 'X', point: [0, 0, 8], normal: [0, 0, 1], size_mm: 3, depth_mm: 1 }, 1, undefined],
        ['build', { solids: [{ type: 'box', min: [-10, -5, 0], max: [10, 5, 8] }] }, 1, 1600],
        ['subtract', { solids: [{ type: 'box', min: [-2, -2, 4], max: [2, 2, 10] }] }, 1, 1536],
      ]
      try {
        for (const [name, args, parts, volume] of cases) {
          const created = await editor.call('design_new', { name: name + ' block' })
          const design = created.structuredContent!.output!.design!
          if (name !== 'build') expect((await editor.call('geom_extrude', { design, shape: { type: 'rectangle', widthMm: 20, heightMm: 10 }, distance_mm: 8 })).isError).not.toBe(true)
          const input = { ...args, design }
          expect(await reader.call('geom_' + name, input)).toMatchObject({ isError: true, structuredContent: { error: { code: 'not_supported' } } })
          const made = await editor.call('geom_' + name, input)
          expect(made.isError, JSON.stringify(made)).not.toBe(true)
          const out = made.structuredContent!.output!
          expect(out).toMatchObject({ in: 'app', steps: name === 'build' ? 1 : 2 })
          expect(out.parts).toHaveLength(parts)
          if (volume !== undefined) expect(out.volumeMm3).toBeCloseTo(volume, 1)
          if (name === 'hollow') { expect(out.volumeMm3).toBeGreaterThan(0); expect(out.volumeMm3).toBeLessThan(1600) }
          if (name === 'emboss') { expect(out.volumeMm3).toBeGreaterThan(1600); expect(out.sizeMm![2]).toBeCloseTo(9, 3) }
          expect(JSON.stringify(made)).not.toMatch(/positions|indices/)
          const history = (await reader.call('design_steps', { design })).structuredContent!.output!.steps as { state: string }[]
          expect(history).toHaveLength(name === 'build' ? 1 : 2)
          expect(history.every((s) => s.state === 'done')).toBe(true)
          expect((await editor.call('design_undo', { design })).isError).not.toBe(true)
          expect((await reader.call('design_steps', { design })).structuredContent!.output!.steps).toHaveLength(name === 'build' ? 0 : 1)

          // A code-only CLI client reaches the command but cannot bypass the app's grant.
          const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('SLICERX_')))
          const tool = 'geom_' + name
          const result = await promisify(execFile)(process.execPath, [join(import.meta.dirname, '../../../packages/mcp/dist/cli.js'), '--app', '--link-url', hub.linkUrl, '--sx-bin', process.env['SX_CLI_BIN']!, '--out-dir', join(dir, 'cli'), '--profiles-dir', join(dir, 'profiles'), '--policy', policyFile, 'call', tool, JSON.stringify(input), 'design_list'], { env: { ...env, SLICERX_MCP_LINK_CODE: hub.code, SLICERX_MCP_LINK_HUB_KEY: hub.admin.hubKey }, timeout: 30_000 }).then(() => { throw new Error('Expected grant refusal') }, (e: unknown) => e as { code: number; stdout: string })
          expect(result.code).toBe(1)
          const rows = result.stdout.trim().split('\n').map((line) => JSON.parse(line))
          expect(rows).toHaveLength(1)
          expect(rows[0]).toMatchObject({ tool: 'slicerx_' + tool, ok: false, output: { error: { code: 'not_configured' } } })
        }
      } finally { await reader.close() }
    } finally { await editor.close() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
