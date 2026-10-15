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

test('the native command line edits live volumes and reads every result back', async ({ page }) => {
  test.slow()
  const hosting: string[] = []
  page.on('console', (m) => { if (m.text().startsWith('[app link]')) hosting.push(m.text()) })
  await page.addInitScript((shell) => Object.assign(window, { __sxTestShell: shell }), { url: hub.linkUrl, code: hub.code, hubKey: hub.admin.hubKey })
  await seed(page)
  await plateReady(page)
  await expect.poll(() => hosting.join('\n'), { timeout: 30_000 }).toContain('this window hosts the app link')
  const dir = mkdtempSync(join(tmpdir(), 'sx-volumes-native-'))
  const policyFile = join(dir, 'policy.json')
  writeFileSync(policyFile, '{}')
  try {
    const { clientKey } = await hub.admin.clients.create('volume-native', 'agent')
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
      const body = await make('Native volume block')
      const initial = await call('app_volumes', { object: body })
      expect(initial.volumes).toEqual([])
      const added = await call('app_volume_add', { object: body, role: 'modifier', shape: 'box', sizeMm: [8, 6, 3], settings: { wall_loops: 4 } })
      const id = added.changed[0]
      expect(added.volumes[0]).toMatchObject({ id, role: 'modifier', settings: { wall_loops: 4 } })
      expect((await call('app_volumes', { object: body })).volumes).toEqual(added.volumes)
      const changed = await call('app_volume_set', { object: body, volume: id, positionMm: [1, 2, 3], rotationDeg: [0, 0, 30], set: { wall_loops: 6 } })
      expect(changed.volumes[0]).toMatchObject({ positionMm: [1, 2, 3], settings: { wall_loops: 6 } })
      expect((await call('app_volumes', { object: body })).volumes).toEqual(changed.volumes)
      const copied = await call('app_volume_copy', { object: body, volume: id })
      expect(copied.volumes).toHaveLength(2)
      expect((await call('app_volumes', { object: body })).volumes).toEqual(copied.volumes)
      const removed = await call('app_volume_remove', { object: body, volume: copied.changed[0] })
      expect(removed.removed).toEqual(copied.changed)
      expect((await call('app_volumes', { object: body })).volumes).toHaveLength(1)
      const source = await make('Native cutter')
      const converted = await call('app_volume_from_object', { object: body, source, role: 'negative' })
      expect(converted.consumedObject).toBe(source)
      expect(converted.volumes).toHaveLength(2)
      expect((await call('app_volumes', { object: body })).volumes).toEqual(converted.volumes)
      await page.getByTestId('plate-tools-group').getByRole('button', { name: 'Undo', exact: true }).click()
      expect((await call('app_volumes', { object: body })).volumes).toHaveLength(1)
      expect((await call('app_volumes', { object: source })).object.id).toBe(source)
    })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
