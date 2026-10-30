// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// slicerx_step_read in the self-contained server, as the desktop app ships it: slicerx-mcp.mjs run with plain node from
// a folder with no node_modules anywhere above it. Built with --step-reader, the reader sits beside it in step-reader/
// (with its NOTICE, license texts and SOURCE.md) and reads a file; SLICERX_STEP_READER_DIR names the folder from
// anywhere; built without it, the call is refused with not_supported and no npm advice, which a person with only the
// app could not follow.
import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const run = promisify(execFile)
const pkg = resolve(import.meta.dirname, '..')
const reader = resolve(pkg, '..', 'step-reader')
const work = mkdtempSync(join(tmpdir(), 'sx-mcp-standalone-step-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

const withReader = join(work, 'with-reader')
const without = join(work, 'without-reader')
const models = join(work, 'models')

beforeAll(() => {
  execFileSync(process.execPath, [join(pkg, 'scripts', 'build.mjs'), '--standalone', withReader, '--step-reader'], { stdio: 'pipe', timeout: 120_000 })
  // The same server with the reader folder taken out, as a build without --step-reader ships it.
  cpSync(withReader, without, { recursive: true })
  rmSync(join(without, 'step-reader'), { recursive: true, force: true })
  mkdirSync(models)
  copyFileSync(join(reader, 'test', 'fixtures', 'assembly-colors.step'), join(models, 'assembly-colors.step'))
}, 180_000)

type Line = { tool: string; ok: boolean; text: string; output: { triangles?: number; objects?: { name: string }[]; error?: { code: string; message: string; details?: Record<string, unknown> } } }

async function stepRead(server: string, extraEnv: Record<string, string> = {}): Promise<Line> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !k.startsWith('SLICERX_'))) as Record<string, string>
  const args = [join(server, 'slicerx-mcp.mjs'), '--allow-dir', models, '--out-dir', join(work, 'out'), '--printers', 'off', 'call', 'step_read', JSON.stringify({ model: join(models, 'assembly-colors.step') })]
  const { stdout } = await run(process.execPath, args, { cwd: work, env: { ...env, HOME: work, USERPROFILE: work, ...extraEnv }, timeout: 120_000 }).catch((e: { stdout: string }) => e)
  return JSON.parse(stdout.trim().split('\n').pop()!) as Line
}

describe('the self-contained server and the STEP reader', () => {
  it('has no node_modules to fall back on', () => {
    for (let dir = work; dir !== resolve(dir, '..'); dir = resolve(dir, '..')) expect(existsSync(join(dir, 'node_modules')), dir).toBe(false)
  })

  it('ships the reader beside the server with its NOTICE, license texts and source offer', () => {
    const names = readdirSync(join(withReader, 'step-reader'))
    for (const f of ['node.js', 'node-worker.js', 'index.js', 'occt-import-js.mjs', 'occt-import-js.wasm', 'package.json', 'NOTICE', 'SOURCE.md', 'LICENSE-APACHE', 'LICENSE-occt-import-js.txt', 'LICENSE-occt.txt', 'OCCT_LGPL_EXCEPTION.txt', 'LICENSE-emscripten.txt', 'LICENSE-musl.txt', 'LICENSE-libcxx.txt']) {
      expect(names).toContain(f)
    }
    expect(names.filter((n) => n.endsWith('.d.ts'))).toEqual([])
    const source = readFileSync(join(reader, 'SOURCE.md'), 'utf8')
    for (const f of ['occt-import-js.mjs', 'occt-import-js.wasm']) {
      const sha = createHash('sha256').update(readFileSync(join(withReader, 'step-reader', f))).digest('hex')
      expect(source).toMatch(new RegExp(`\`${f.replace('.', '\\.')}\` \\([\\d,]+ bytes[^)]*\\): ${sha}`))
    }
  })

  it('reads a STEP file with the reader beside it', async () => {
    const r = await stepRead(withReader)
    expect(r.ok, r.text).toBe(true)
    expect(r.output.triangles).toBe(328)
    expect(r.output.objects?.map((o) => o.name)).toEqual(['assembly-colors', 'cube'])
  })

  it('reads a STEP file with the reader in the folder SLICERX_STEP_READER_DIR names', async () => {
    const moved = join(work, 'reader-elsewhere')
    renameSync(join(withReader, 'step-reader'), moved)
    try {
      const r = await stepRead(withReader, { SLICERX_STEP_READER_DIR: moved })
      expect(r.ok, r.text).toBe(true)
      expect(r.output.triangles).toBe(328)
      const wrong = await stepRead(withReader, { SLICERX_STEP_READER_DIR: join(work, 'models') })
      expect(wrong.output.error).toMatchObject({ code: 'not_supported' })
      expect(wrong.output.error?.message).toContain('SLICERX_STEP_READER_DIR')
    } finally {
      renameSync(moved, join(withReader, 'step-reader'))
    }
  })

  it('without the reader, refuses with not_supported and does not tell a person to run npm', async () => {
    const r = await stepRead(without)
    expect(r.ok).toBe(false)
    expect(r.output.error).toMatchObject({ code: 'not_supported' })
    expect(r.output.error?.message).not.toMatch(/npm/)
    expect(r.output.error?.details?.['install']).toBeUndefined()
  })
})
