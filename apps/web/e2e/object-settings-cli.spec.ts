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

test('the native command line edits live object and part settings and reads every result back', async ({ page }) => {
  test.slow()
  const hosting: string[] = []
  page.on('console', (m) => { if (m.text().startsWith('[app link]')) hosting.push(m.text()) })
  await page.addInitScript((shell) => Object.assign(window, { __sxTestShell: shell }), { url: hub.linkUrl, code: hub.code, hubKey: hub.admin.hubKey })
  await seed(page)
  await plateReady(page)
  await expect.poll(() => hosting.join('\n'), { timeout: 30_000 }).toContain('this window hosts the app link')
  const dir = mkdtempSync(join(tmpdir(), 'sx-settings-native-'))
  const policyFile = join(dir, 'policy.json')
  writeFileSync(policyFile, '{}')
  try {
    const { clientKey } = await hub.admin.clients.create('settings-native', 'agent')
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
      const body = await make('Native settings block')
      const read = () => call('app_object_settings', { object: body, keys: ['wall_loops'] })
      const initial = await read()
      const part = initial.parts[0].name
      const own = await call('project_object_settings', { object: body, set: { wall_loops: 4 } })
      expect(own.object.settings).toEqual({ wall_loops: 4 })
      expect((await read()).object.settings).toEqual({ wall_loops: 4 })
      const changed = await call('app_object_settings_set', { object: body, part, set: { wall_loops: 6 } })
      expect(changed.parts[0]).toMatchObject({ name: part, settings: { wall_loops: 6 }, effective: { wall_loops: 6 } })
      expect((await read()).parts[0].effective).toEqual({ wall_loops: 6 })
      const cleared = await call('app_object_settings_set', { object: body, part, clear: ['wall_loops'] })
      expect(cleared.parts[0]).toMatchObject({ settings: {}, effective: { wall_loops: 4 } })
      expect((await read()).parts[0].effective).toEqual({ wall_loops: 4 })
      const undo = page.getByTestId('plate-tools-group').getByRole('button', { name: 'Undo', exact: true })
      await undo.click()
      expect((await read()).parts[0].effective).toEqual({ wall_loops: 6 })
      await undo.click()
      expect((await read()).parts[0].effective).toEqual({ wall_loops: 4 })
      await undo.click()
      expect((await read()).object.effective).toEqual(initial.object.effective)
    })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})