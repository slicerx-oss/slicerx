// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { TopologyManifest } from '../../../packages/cad-history/src/topology-manifest'
import { hub, seed, useBridge } from './bridge-hub'
import { expect, plateReady, test } from './fixtures'

useBridge([], async () => { await hub.admin.settings.set({ appLink: true }) }, { hostAppLink: true })
const from = createRequire(join(import.meta.dirname, '../../../packages/mcp/package.json'))

test('scoped exact hole edits use app revisions across a visible undo', async ({ page }) => {
  test.setTimeout(180000)
  const hosting: string[] = [], fallbacks: string[] = []
  page.on('console', m => {
    if (m.text().startsWith('[app link]')) hosting.push(m.text())
    if (/exact solids:.*ran on the mesh/.test(m.text())) fallbacks.push(m.text())
  })
  await page.addInitScript(shell => Object.assign(window, { __sxTestShell: shell }), { url: hub.linkUrl, code: hub.code, hubKey: hub.admin.hubKey })
  await page.addInitScript(() => localStorage.setItem('slicerx.debug', '1'))
  await seed(page)
  await plateReady(page)
  await page.evaluate(() => {
    localStorage.setItem('sx.exactSolids', '1')
    ;(window as unknown as { __sx: { setState(v: unknown): void } }).__sx.setState({ settingsMode: 'developer' })
  })
  await expect.poll(() => hosting.join('\n'), { timeout: 30000 }).toContain('this window hosts the app link')
  const { Client } = await import(pathToFileURL(from.resolve('@modelcontextprotocol/sdk/client/index.js')).href)
  const { InMemoryTransport } = await import(pathToFileURL(from.resolve('@modelcontextprotocol/sdk/inMemory.js')).href)
  const { createContext, createSlicerxServer } = await import(pathToFileURL(join(import.meta.dirname, '../../../packages/mcp/dist/index.js')).href)
  const dir = mkdtempSync(join(tmpdir(), 'sx-topology-link-')), policyFile = join(dir, 'policy.json')
  writeFileSync(policyFile, '{}')
  const { clientKey } = await hub.admin.clients.create('topology-editor', 'agent')
  const ctx = await createContext({ engine: 'sx', sxBin: process.env['SX_CLI_BIN'], printers: 'link', linkUrl: hub.linkUrl, linkHubKey: hub.admin.hubKey, linkClientKey: clientKey, app: 'required', outDir: dir, profilesDir: join(dir, 'profiles'), policyFile })
  const server = createSlicerxServer(ctx), client = new Client({ name: 'topology-editor', version: '0.0.0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  try {
    await Promise.all([server.connect(a), client.connect(b)])
    const call = (name: string, args = {}) => client.callTool({ name: `slicerx_${name}`, arguments: args }, undefined, { timeout: 60000 })
    const ok = async <T,>(name: string, args = {}): Promise<T> => {
      const result = await call(name, args)
      expect(result.isError, JSON.stringify(result)).not.toBe(true)
      return (result.structuredContent as { output: T }).output
    }
    const pending = call('design_list')
    await expect(page.getByTestId('app-link-allow')).toBeEnabled({ timeout: 30000 })
    await page.getByTestId('app-link-allow').click()
    expect((await pending).isError).not.toBe(true)
    expect((await client.listTools()).tools.some((t: { name: string }) => t.name === 'slicerx_geom_faces')).toBe(true)
    type Summary = { design: string; exact: boolean; parts: { sizeMm: number[]; volumeMm3: number }[] }
    const design = (await ok<Summary>('design_new', { name: 'Scoped bracket', exact: true })).design
    await ok('geom_extrude', { design, shape: { type: 'rectangle', widthMm: 30, heightMm: 10 }, placement: { center: [15, 5] }, distance_mm: 3 })
    await ok('geom_extrude', { design, shape: { type: 'circle', diameterMm: 3 }, frame: { origin: [0, 0, 3], normal: [0, 0, 1] }, placement: { center: [5, 5] }, distance_mm: 3, operation: 'cut' })
    const before = await ok<Summary>('geom_extrude', { design, shape: { type: 'rectangle', widthMm: 6, heightMm: 8 }, placement: { center: [50, 5] }, distance_mm: 4 })
    const topology = async () => (await ok<{ topology: TopologyManifest }>('geom_faces', { design, format: 'topology' })).topology
    const read = await topology()
    expect(read).toMatchObject({ representation: 'exact', capabilities: { meshFallback: false, revisionGuard: true } })
    const faces = read.faces.filter(f => f.part === 0 && f.surfaceType === 'cylinder' && f.ambiguity === 'none')
    expect(faces).toHaveLength(1)
    const reference = { bodyId: design, revision: read.revision, part: 0, faceKey: faces[0]!.faceKey }
    const edited = await ok<Summary & { after: { diameterMm: number }; topology: TopologyManifest; operationResult: unknown }>('geom_hole', { design, face: { topology: reference }, diameter_mm: 4 })
    expect(edited.operationResult).toMatchObject({ status: 'applied', verification: { status: 'verified' } })
    expect(edited.after.diameterMm).toBeCloseTo(4, 2)
    expect(edited.parts[1]).toEqual(before.parts[1])
    expect(edited.parts.map(p => p.sizeMm)).toEqual(before.parts.map(p => p.sizeMm))
    await page.getByRole('button', { name: 'Undo', exact: true }).click()
    const undone = await topology()
    expect(undone.revision).not.toBe(read.revision)
    expect(undone.revision).not.toBe(edited.topology.revision)
    expect(undone.faces.find(f => f.part === 0 && f.surfaceType === 'cylinder')?.dimensions.diameterMm).toBeCloseTo(3, 2)
    const stale = await call('geom_hole', { design, face: { topology: reference }, diameter_mm: 5 })
    expect(stale).toMatchObject({ isError: true, structuredContent: { error: { code: 'stale_body', details: { operationResult: { status: 'refused' } } } } })
    expect((await topology()).revision).toBe(undone.revision)
    expect(fallbacks).toEqual([])
  } finally { await client.close(); await server.close(); ctx.printers?.close?.(); rmSync(dir, { recursive: true, force: true }) }
})
