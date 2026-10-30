// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The release step that packs the app's MCP server (release/prepare-sidecars.mjs) puts the STEP reader beside it in
// Resources/mcp/step-reader: the exact wasm and glue packages/step-reader/SOURCE.md lists, with the NOTICE, the
// license texts and the source offer, and the packed server reads a STEP file with it.
import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const repo = resolve(import.meta.dirname, '..', '..', '..')
const reader = join(repo, 'packages', 'step-reader')
const work = mkdtempSync(join(tmpdir(), 'sx-desktop-mcp-resource-'))
const mcp = join(work, 'resources', 'mcp')
afterAll(() => rmSync(work, { recursive: true, force: true }))

beforeAll(() => {
  const env = { ...process.env }
  // No watch model, so the step packs only the MCP server and builds no Rust.
  delete env['SX_WATCH_MODEL_URL']
  execFileSync(process.execPath, [join(repo, 'apps', 'desktop', 'release', 'prepare-sidecars.mjs'), '--target', 'aarch64-apple-darwin', '--resources', join(work, 'resources')], { stdio: 'pipe', env, timeout: 120_000 })
}, 180_000)

describe('the packed MCP resource', () => {
  it('carries the STEP reader with the wasm and glue SOURCE.md lists, byte for byte', () => {
    const source = readFileSync(join(reader, 'SOURCE.md'), 'utf8')
    for (const f of ['occt-import-js.mjs', 'occt-import-js.wasm']) {
      const bytes = readFileSync(join(mcp, 'step-reader', f))
      const sha = createHash('sha256').update(bytes).digest('hex')
      const line = source.split('\n').find((l) => l.startsWith(`- \`${f}\``))
      expect(line, `SOURCE.md lists ${f}`).toBeDefined()
      expect(line).toContain(sha)
      expect(line).toContain(`(${bytes.length.toLocaleString('en-US')} bytes`)
    }
  })

  it('carries the NOTICE, the license texts and the source offer, the same as the package', () => {
    for (const f of ['NOTICE', 'SOURCE.md', 'LICENSE-APACHE', 'LICENSE-occt-import-js.txt', 'LICENSE-occt.txt', 'OCCT_LGPL_EXCEPTION.txt', 'LICENSE-emscripten.txt', 'LICENSE-musl.txt', 'LICENSE-libcxx.txt']) {
      expect(existsSync(join(mcp, 'step-reader', f)), f).toBe(true)
      expect(readFileSync(join(mcp, 'step-reader', f))).toEqual(readFileSync(join(reader, f)))
    }
  })

  it('reads a STEP file through the packed server', async () => {
    copyFileSync(join(reader, 'test', 'fixtures', 'bracket-inch.stp'), join(work, 'bracket-inch.stp'))
    const env = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !k.startsWith('SLICERX_'))) as Record<string, string>
    const args = [join(mcp, 'slicerx-mcp.mjs'), '--allow-dir', work, '--out-dir', join(work, 'out'), '--printers', 'off', 'call', 'step_read', JSON.stringify({ model: join(work, 'bracket-inch.stp') })]
    const { stdout } = await promisify(execFile)(process.execPath, args, { cwd: work, env: { ...env, HOME: work, USERPROFILE: work }, timeout: 120_000 }).catch((e: { stdout: string }) => e)
    const line = JSON.parse(stdout.trim().split('\n').pop()!) as { ok: boolean; text: string; output: { unit?: string } }
    expect(line.ok, line.text).toBe(true)
    expect(line.output.unit).toBe('inch')
  })
})
