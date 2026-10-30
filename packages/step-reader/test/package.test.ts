// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The npm package as it ships: `pnpm pack` builds and packs it, and the tarball must stay inside the size budget, carry
// the license texts, NOTICE and the source offer with build.sh and the patch, hold the exact wasm SOURCE.md lists, and
// work once installed: Node finds the wasm and the worker next to dist/ and reads a file both ways. Publishing waits
// for the source archive on the GitHub release (scripts/check-source-release.mjs).
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
// @ts-expect-error a plain .mjs script without declarations
import { checkSourceRelease, sourceArchiveUrl } from '../scripts/check-source-release.mjs'

const pkg = join(import.meta.dirname, '..')
const work = mkdtempSync(join(tmpdir(), 'sx-step-pack-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

/** Size budget of the packed tarball (gzip) and of the files it unpacks to. The wasm alone is 3,084,242 and 7,604,102. */
export const PACKED_BUDGET_BYTES = 3_400_000
export const UNPACKED_BUDGET_BYTES = 8_200_000

let tarball = ''
let unpacked = ''
const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]))

beforeAll(() => {
  const out = execFileSync('pnpm', ['pack', '--pack-destination', work], { cwd: pkg, encoding: 'utf8', timeout: 120_000 })
  tarball = join(work, out.trim().split('\n').pop()!.split('/').pop()!)
  execFileSync('tar', ['-xzf', tarball, '-C', work])
  unpacked = join(work, 'package')
}, 180_000)

describe('the packed package', () => {
  it('stays inside its size budget', () => {
    const packed = statSync(tarball).size
    const total = files(unpacked).reduce((n, f) => n + statSync(f).size, 0)
    console.log(`step-reader tarball: ${packed} bytes packed (budget ${PACKED_BUDGET_BYTES}), ${total} unpacked (budget ${UNPACKED_BUDGET_BYTES})`)
    expect(packed).toBeLessThanOrEqual(PACKED_BUDGET_BYTES)
    expect(total).toBeLessThanOrEqual(UNPACKED_BUDGET_BYTES)
  })

  it('carries the licenses, the NOTICE and the source offer with the build and the patch', () => {
    const names = files(unpacked).map((f) => relative(unpacked, f).split('\\').join('/'))
    for (const f of ['NOTICE', 'SOURCE.md', 'LICENSE-APACHE', 'LICENSE-occt-import-js.txt', 'LICENSE-occt.txt', 'OCCT_LGPL_EXCEPTION.txt', 'LICENSE-emscripten.txt', 'LICENSE-musl.txt', 'LICENSE-libcxx.txt', 'build.sh', 'source-archive.sh', 'patches/0001-mesh-kind.patch', 'README.md']) {
      expect(names).toContain(f)
    }
    for (const f of ['dist/index.js', 'dist/index.d.ts', 'dist/node.js', 'dist/node.d.ts', 'dist/node-worker.js', 'dist/occt-import-js.mjs', 'dist/occt-import-js.wasm']) expect(names).toContain(f)
    // No sources or tests: the TypeScript is built into dist.
    expect(names.filter((n) => n.startsWith('src/') || n.startsWith('test/'))).toEqual([])
    const manifest = JSON.parse(readFileSync(join(unpacked, 'package.json'), 'utf8'))
    expect(manifest.license).toBe('Apache-2.0 AND LGPL-2.1-only AND LGPL-2.1-only WITH OCCT-exception-1.0 AND MIT AND Apache-2.0 WITH LLVM-exception')
    expect(manifest.exports['.'].import).toBe('./dist/index.js')
    expect(manifest.exports['./node'].import).toBe('./dist/node.js')
  })

  it('holds the glue and wasm SOURCE.md lists, byte for byte', () => {
    const source = readFileSync(join(pkg, 'SOURCE.md'), 'utf8')
    for (const f of ['occt-import-js.mjs', 'occt-import-js.wasm']) {
      const listed = new RegExp(`\`${f.replace('.', '\\.')}\` \\(([\\d,]+) bytes[^)]*\\): ([0-9a-f]{64})`).exec(source)
      expect(listed, f).not.toBeNull()
      for (const at of [join(pkg, 'src', f), join(unpacked, 'dist', f)]) {
        const bytes = readFileSync(at)
        expect(bytes.length).toBe(Number(listed![1]!.replaceAll(',', '')))
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(listed![2])
      }
    }
  })

  it('reads a STEP file once installed, in process and in a worker thread', () => {
    const app = join(work, 'app')
    mkdirSync(join(app, 'node_modules', '@slicerx'), { recursive: true })
    cpSync(unpacked, join(app, 'node_modules', '@slicerx', 'step-reader'), { recursive: true })
    cpSync(join(pkg, 'test', 'fixtures', 'assembly.step'), join(app, 'assembly.step'))
    const script = `
      import { readFileSync } from 'node:fs'
      import { loadStepReader, toObj, defaultWasmUrl } from '@slicerx/step-reader'
      import { readStepInWorker } from '@slicerx/step-reader/node'
      const bytes = new Uint8Array(readFileSync('assembly.step'))
      const reader = await loadStepReader()
      const a = reader.read(bytes, { name: 'assembly.step' })
      const b = await readStepInWorker(bytes, { name: 'assembly.step' })
      console.log(JSON.stringify({ wasm: defaultWasmUrl().pathname.split('/').slice(-3).join('/'), inProcess: a.triangles, worker: b.triangles, same: toObj(a) === toObj(b) }))`
    const out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: app, encoding: 'utf8', timeout: 60_000 }))
    expect(out).toEqual({ wasm: 'step-reader/dist/occt-import-js.wasm', inProcess: 328, worker: 328, same: true })
  })
})

describe('publishing', () => {
  const fake = (status: number) => (async () => new Response(status === 206 ? 'x' : null, { status })) as typeof fetch

  it('looks for the source archive on the release tagged for the version', () => {
    expect(sourceArchiveUrl('0.1.0')).toBe('https://github.com/slicerx-oss/slicerx/releases/download/step-reader-v0.1.0/occt-import-js-source-0.0.23.tar.gz')
  })

  it('refuses while the release has no source archive, and goes ahead once it has', async () => {
    await expect(checkSourceRelease('0.1.0', fake(404))).rejects.toThrow(/the source archive is not on the release \(HTTP 404/)
    await expect(checkSourceRelease('0.1.0', (async () => Promise.reject(new Error('offline'))) as typeof fetch)).rejects.toThrow(/could not reach/)
    await expect(checkSourceRelease('0.1.0', fake(206))).resolves.toMatch(/step-reader-v0\.1\.0/)
  })

  it('runs that check before every publish', () => {
    const manifest = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'))
    expect(manifest.scripts.prepublishOnly).toContain('scripts/check-source-release.mjs')
  })
})
