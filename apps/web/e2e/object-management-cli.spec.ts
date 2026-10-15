// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { withWindowsCredential } from '../../../packages/mcp/test/helpers/windows-credential'
import { hub, seed, useBridge } from './bridge-hub'
import { expect, plateReady, test } from './fixtures'

useBridge([], async () => { await hub.admin.settings.set({ appLink: true }) }, { hostAppLink: true })
test.skip(process.platform !== 'win32' || !process.env['SX_MCP_CALL_BIN'], 'Windows native entry point and Credential Manager')
const exec = promisify(execFile)

test('the native command line edits live object management and reads every result back', async ({ page }) => {
  test.slow()
  const hosting: string[] = []
  page.on('console', (m) => { if (m.text().startsWith('[app link]')) hosting.push(m.text()) })
  await page.addInitScript((shell) => Object.assign(window, { __sxTestShell: shell }), { url: hub.linkUrl, code: hub.code, hubKey: hub.admin.hubKey })
  await seed(page)
  await plateReady(page)
  await expect.poll(() => hosting.join('\n'), { timeout: 30_000 }).toContain('this window hosts the app link')
  const dir = mkdtempSync(join(tmpdir(), 'sx-management-native-'))
  const policyFile = join(dir, 'policy.json')
  writeFileSync(policyFile, '{}')
  try {
    const { clientKey } = await hub.admin.clients.create('management-native', 'agent')
    expect(clientKey).toBeTruthy()
    await withWindowsCredential(clientKey!, async (ref, identifier) => {
      const env = { ...process.env }
      for (const name of Object.keys(env)) if (name.startsWith('SLICERX_MCP_')) delete env[name]
      Object.assign(env, { SLICERX_MCP_LINK_KEY_REF: ref, SLICERX_MCP_APP_IDENTIFIER: identifier, SLICERX_MCP_LINK_URL: hub.linkUrl, SLICERX_MCP_LINK_HUB_KEY: hub.admin.hubKey, SLICERX_MCP_CLI: join(import.meta.dirname, '../../../packages/mcp/dist/cli.js'), SLICERX_NODE_BIN: process.execPath })
      const run = async (...calls: string[]) => {
        const result = await exec(process.env['SX_MCP_CALL_BIN']!, ['call', '--app', '--engine', 'sx', '--sx-bin', process.env['SX_CLI_BIN']!, '--out-dir', dir, '--profiles-dir', join(dir, 'profiles'), '--policy', policyFile, ...calls], { env, windowsHide: true, timeout: 60_000 })
        expect(`${result.stdout}${result.stderr}`).not.toContain(clientKey)
        const rows = result.stdout.trim().split('\n').map((line) => JSON.parse(line))
        rows.forEach((row) => expect(row.ok, JSON.stringify(row)).toBe(true))
        return rows.map((row) => row.output.output)
      }
      const call = async (name: string, args = {}) => (await run(name, JSON.stringify(args)))[0]
      const pending = call('design_list')
      await expect(page.getByTestId('app-link-allow')).toBeEnabled({ timeout: 30_000 })
      await page.getByTestId('app-link-allow').click()
      await pending
      const make = async (name: string) => {
        const { design } = await call('design_new', { name })
        await call('geom_extrude', { design, shape: { type: 'rectangle', widthMm: 20, heightMm: 10 }, distance_mm: 3 })
        return design as string
      }
      const body = await make('Native managed block')
      const read = () => call('app_objects')
      const initial = (await read()).objects.find((o: { id: string }) => o.id === body)
      const renamed = await call('project_rename', { object: body, name: 'Native renamed block' })
      expect(renamed.objects[0].name).toBe('Native renamed block')
      expect((await read()).objects.find((o: { id: string }) => o.id === body)).toEqual(renamed.objects[0])
      const laid = (await call('project_lay_on_face', { object: body, normal: [1, 0, 0] })).objects[0]
      expect(laid.minMm[2]).toBeCloseTo(0)
      expect(laid.sizeMm[2]).toBeCloseTo(initial.sizeMm[0])
      expect((await read()).objects.find((o: { id: string }) => o.id === body)).toEqual(laid)
      const copied = await call('project_duplicate', { object: body, count: 2 })
      expect(copied).toMatchObject({ requested: 2, created: 2 })
      expect(copied.objects).toHaveLength(2)
      const all = (await read()).objects
      for (const row of copied.objects) expect(all.find((o: { id: string }) => o.id === row.id)).toEqual(row)
      const removed = await call('project_remove_object', { object: body })
      expect(removed.removed).toEqual([body])
      expect((await read()).objects.some((o: { id: string }) => o.id === body)).toBe(false)
      const undo = page.getByTestId('plate-tools-group').getByRole('button', { name: 'Undo', exact: true })
      await undo.click()
      expect((await read()).objects.find((o: { id: string }) => o.id === body)).toEqual(laid)
      await undo.click()
      expect((await read()).objects.some((o: { id: string }) => copied.ids.includes(o.id))).toBe(false)
      await undo.click()
      expect((await read()).objects.find((o: { id: string }) => o.id === body).sizeMm).toEqual(initial.sizeMm)
      await undo.click()
      expect((await read()).objects.find((o: { id: string }) => o.id === body).name).toBe('Native managed block')
    })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
