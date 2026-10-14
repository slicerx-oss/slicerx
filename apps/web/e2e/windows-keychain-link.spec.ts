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
test.skip(process.platform !== 'win32', 'Windows Credential Manager')
const exec = promisify(execFile)

test('Windows CLI reads its remembered credential and honors the open app grant', async ({ page }) => {
  test.slow()
  const hosting: string[] = []
  page.on('console', (message) => { if (message.text().startsWith('[app link]')) hosting.push(message.text()) })
  await page.addInitScript(() => localStorage.setItem('slicerx.debug', '1'))
  await page.addInitScript((shell) => Object.assign(window, { __sxTestShell: shell }), { url: hub.linkUrl, code: hub.code, hubKey: hub.admin.hubKey })
  await seed(page)
  await plateReady(page)
  await expect.poll(() => hosting.join('\n'), { timeout: 30_000 }).toContain('this window hosts the app link')
  await expect.poll(() => page.evaluate(() => (window as unknown as { __sx: { getState(): { bridgeStatus: { state: string } } } }).__sx.getState().bridgeStatus.state)).toBe('on')
  const dir = mkdtempSync(join(tmpdir(), 'sx-keychain-link-'))
  const policyFile = join(dir, 'policy.json')
  writeFileSync(policyFile, '{}')
  const cli = join(import.meta.dirname, '../../../packages/mcp/dist/cli.js')
  try {
    for (const mode of ['read', 'edit'] as const) {
      const { clientKey } = await hub.admin.clients.create(`keychain-${mode}`, 'agent')
      expect(clientKey).toBeTruthy()
      await withWindowsCredential(clientKey!, async (ref, identifier) => {
        const env = { ...process.env }
        for (const name of Object.keys(env)) if (name.startsWith('SLICERX_MCP_')) delete env[name]
        Object.assign(env, { SLICERX_MCP_LINK_KEY_REF: ref, SLICERX_MCP_APP_IDENTIFIER: identifier, SLICERX_MCP_LINK_URL: hub.linkUrl, SLICERX_MCP_LINK_HUB_KEY: hub.admin.hubKey, SLICERX_MCP_CLI: cli, SLICERX_NODE_BIN: process.execPath })
        // An installed native entry point can exercise the same packaged runtime on the edit path.
        const native = mode === 'edit' ? process.env['SX_MCP_CALL_BIN'] : undefined
        const run = (...calls: string[]) => exec(native || process.execPath, [...(native ? [] : [cli]), 'call', '--app', '--engine', 'sx', '--sx-bin', process.env['SX_CLI_BIN']!, '--out-dir', join(dir, mode), '--profiles-dir', join(dir, 'profiles'), '--policy', policyFile, ...calls], { env, windowsHide: true, timeout: 60_000 }).then((result) => ({ ...result, code: 0 }), (error: { stdout: string; stderr: string; code: number }) => error)
        const pending = run('app_plates', 'design_new', JSON.stringify({ name: `Credential ${mode}` }), 'design_list')
        const grant = page.getByTestId(mode === 'read' ? 'app-link-read' : 'app-link-allow')
        await expect(grant).toBeEnabled({ timeout: 30_000 })
        await grant.click()
        const result = await pending
        expect(`${result.stdout}${result.stderr}`).not.toContain(clientKey)
        const rows = result.stdout.trim().split('\n').map((line) => JSON.parse(line))
        expect(rows[0]).toMatchObject({ tool: 'slicerx_app_plates', ok: true, output: { output: { count: 1, shown: 1 } } })
        expect(result.code).toBe(mode === 'read' ? 1 : 0)
        if (mode === 'read') {
          expect(rows).toHaveLength(2)
          expect(rows[1]).toMatchObject({ tool: 'slicerx_design_new', ok: false })
        } else {
          expect(rows).toHaveLength(3)
          expect(rows[1]).toMatchObject({ tool: 'slicerx_design_new', ok: true })
          expect(rows[2]).toMatchObject({ tool: 'slicerx_design_list', ok: true, output: { output: { designs: [{ name: 'Credential edit' }] } } })
          expect(rows[2].output.output.designs).toHaveLength(1)
        }
      })
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
