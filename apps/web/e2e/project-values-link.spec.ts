// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The real hub enforces the grant; MCP edits the open project's values and geometry.
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Page } from '@playwright/test'
import { hub, seed, useBridge } from './bridge-hub'
import { expect, plateReady, test } from './fixtures'

useBridge([], async () => { await hub.admin.settings.set({ appLink: true }) }, { hostAppLink: true })
const from = createRequire(join(import.meta.dirname, '../../../packages/mcp/package.json'))
type Answer = { isError?: boolean; structuredContent?: { output?: { design?: string }; error?: { code: string } } }

async function allowed<T>(page: Page, pending: Promise<T>, button: 'app-link-read' | 'app-link-allow'): Promise<T> {
  const first = await Promise.race([page.getByTestId(button).waitFor({ state: 'visible', timeout: 30_000 }).then(() => ({ prompt: true as const })), pending.then((reply) => ({ reply }))])
  if ('reply' in first) throw new Error(`The tool answered before a grant: ${JSON.stringify(first.reply)}`)
  await expect(page.getByTestId(button)).toBeEnabled({ timeout: 30_000 })
  await page.getByTestId(button).click()
  return pending
}

test('project expressions update a bound solid over MCP and a read-only grant refuses edits', async ({ page }) => {
  test.slow()
  const hosting: string[] = []
  page.on('console', (message) => { if (message.text().startsWith('[app link]')) hosting.push(message.text()) })
  await page.addInitScript(() => localStorage.setItem('slicerx.debug', '1'))
  await page.addInitScript((shell) => Object.assign(window, { __sxTestShell: shell }), { url: hub.linkUrl, code: hub.code, hubKey: hub.admin.hubKey })
  await seed(page)
  await plateReady(page)
  await expect.poll(() => hosting.join('\n'), { timeout: 30_000 }).toContain('this window hosts the app link')
  await expect.poll(() => page.evaluate(() => (window as unknown as { __sx: { getState(): { bridgeStatus: { state: string } } } }).__sx.getState().bridgeStatus.state)).toBe('on')
  const { Client } = await import(pathToFileURL(from.resolve('@modelcontextprotocol/sdk/client/index.js')).href)
  const { InMemoryTransport } = await import(pathToFileURL(from.resolve('@modelcontextprotocol/sdk/inMemory.js')).href)
  const { createContext, createSlicerxServer } = await import(pathToFileURL(join(import.meta.dirname, '../../../packages/mcp/dist/index.js')).href)
  const dir = mkdtempSync(join(tmpdir(), 'sx-project-values-'))
  const policyFile = join(dir, 'policy.json')
  writeFileSync(policyFile, '{}')
  const session = async (name: string) => {
    const { clientKey } = await hub.admin.clients.create(name, 'agent')
    const ctx = await createContext({ engine: 'sx', sxBin: process.env['SX_CLI_BIN'], printers: 'link', linkUrl: hub.linkUrl, linkHubKey: hub.admin.hubKey, linkClientKey: clientKey, app: 'required', outDir: join(dir, name), profilesDir: join(dir, 'profiles'), policyFile })
    const server = createSlicerxServer(ctx)
    const client = new Client({ name, version: '0.0.0' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(a), client.connect(b)])
    return { call: (name: string, args = {}) => client.callTool({ name: `slicerx_${name}`, arguments: args }, undefined, { timeout: 60_000 }) as Promise<Answer>, close: async () => { await client.close(); await server.close(); ctx.printers?.close?.() } }
  }
  try {
    const reader = await session('value-reader')
    try {
      expect((await allowed(page, reader.call('app_values'), 'app-link-read')).isError).not.toBe(true)
      expect(await reader.call('app_value_set', { name: 'height', expression: '3' })).toMatchObject({ isError: true, structuredContent: { error: { code: 'not_supported' } } })
    } finally { await reader.close() }
    const editor = await session('value-editor')
    try {
      expect((await allowed(page, editor.call('app_value_set', { name: 'height', expression: '3' }), 'app-link-allow')).isError).not.toBe(true)
      const created = await editor.call('design_new', { name: 'Bound bracket' })
      const design = created.structuredContent!.output!.design!
      expect((await editor.call('geom_extrude', { design, shape: { type: 'rectangle', widthMm: 20, heightMm: 10 }, distance_mm: 3 })).isError).not.toBe(true)
      expect((await editor.call('app_step_bind', { design, step: 1, expression: 'height * 2' })).isError).not.toBe(true)
      expect((await editor.call('app_value_set', { name: 'height', expression: '5' })).isError).not.toBe(true)
      expect(await editor.call('app_values')).toMatchObject({ structuredContent: { output: { values: [{ name: 'height', value: 5 }], bindings: [{ design, value: 10, state: 'current' }] } } })
      expect(await editor.call('design_steps', { design })).toMatchObject({ structuredContent: { output: { sizeMm: [20, 10, 10], volumeMm3: 2000 } } })
      expect((await editor.call('design_edit_step', { design, step: 1, value: 7 })).isError).not.toBe(true)
      expect(await editor.call('app_values')).toMatchObject({ structuredContent: { output: { bindings: [] } } })
      expect((await editor.call('app_value_set', { name: 'height', expression: '6' })).isError).not.toBe(true)
      expect(await editor.call('design_steps', { design })).toMatchObject({ structuredContent: { output: { sizeMm: [20, 10, 7] } } })
      expect((await editor.call('app_step_bind', { design, step: 1, expression: 'height * 2' })).isError).not.toBe(true)
      expect(await editor.call('app_value_set', { name: 'height', expression: 'missing' })).toMatchObject({ isError: true, structuredContent: { error: { details: { applied: true, bindings: [{ state: 'broken', value: 12 }] } } } })
      expect((await editor.call('app_step_bind', { design, step: 1, expression: null })).isError).toBe(true)
      // The binding edit applied; the unresolved project value still needs removal.
      expect((await editor.call('app_value_remove', { name: 'height' })).isError).not.toBe(true)
      expect(await editor.call('app_values')).toMatchObject({ structuredContent: { output: { values: [], bindings: [], issues: [] } } })
    } finally { await editor.close() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
