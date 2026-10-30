// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The wasm is found with new URL('./occt-import-js.wasm', import.meta.url). This builds a page that loads the reader
// with Vite, the way the web app does (base /) and the way the desktop app does for Tauri, which serves the built
// files from its own origin (base ./), from the source tree and from the built package, and follows the URL each
// build wrote to the file it emitted. Node is covered by package.test.ts and every test that loads the module.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'vite'
import { defaultWasmUrl } from '../src/index.ts'

const pkg = join(import.meta.dirname, '..')
const work = mkdtempSync(join(tmpdir(), 'sx-step-vite-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))
const WASM_BYTES = statSync(join(pkg, 'src', 'occt-import-js.wasm')).size
// The package as it is published, built here so this file never races package.test.ts over dist/.
const built = join(work, 'package-dist')
beforeAll(() => void execFileSync(process.execPath, [join(pkg, 'scripts', 'build.mjs'), built], { stdio: 'pipe', timeout: 120_000 }), 180_000)

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]))
}

/** Builds a page whose script loads the reader from `entry`, and returns the files of the build. */
async function buildPage(name: string, entry: string, base: string): Promise<string> {
  const root = join(work, name)
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'index.html'), '<!doctype html><script type="module" src="./main.js"></script>')
  writeFileSync(join(root, 'main.js'), `import { defaultWasmUrl, loadOcct } from ${JSON.stringify(entry)}\nwindow.reader = { url: defaultWasmUrl(), loadOcct }\n`)
  await build({ root, base, logLevel: 'silent', configFile: false, build: { outDir: join(root, 'dist'), emptyOutDir: true, assetsInlineLimit: 0, target: 'es2022' } })
  return join(root, 'dist')
}

/**
 * Follows every URL of an emitted occt-import-js wasm (a hashed name) the build wrote, from the chunk that holds it,
 * served at `origin`, the way the browser resolves new URL(spec, import.meta.url): a relative spec against the chunk,
 * an absolute path against the origin.
 */
function wasmTargets(dist: string, origin: string): string[] {
  const found: string[] = []
  for (const f of files(dist).filter((f) => f.endsWith('.js'))) {
    const text = readFileSync(f, 'utf8')
    const chunk = new URL(f.slice(dist.length + 1).split('\\').join('/'), `${origin}/`)
    for (const m of text.matchAll(/(["'`])([^"'`\s]*occt-import-js-[\w-]+\.wasm)\1/g)) {
      const target = new URL(m[2]!, chunk)
      expect(target.origin).toBe(new URL(origin).origin)
      found.push(join(dist, decodeURIComponent(target.pathname)))
    }
  }
  return found
}

describe('finding the wasm', () => {
  it('in Node, next to the module that loads it', () => {
    const url = defaultWasmUrl()
    expect(url.protocol).toBe('file:')
    expect(statSync(fileURLToPath(url)).size).toBe(WASM_BYTES)
  })

  for (const [what, entry] of [
    ['the source tree', join(pkg, 'src', 'index.ts')],
    ['the built package', join(built, 'index.js')],
  ] as const) {
    for (const [host, base, origin] of [
      ['Vite for the web (base /)', '/', 'https://slicer.example'],
      ['Vite for Tauri (base ./)', './', 'tauri://localhost'],
    ] as const) {
      it(`${host}, from ${what}`, async () => {
        const dist = await buildPage(`${base === '/' ? 'web' : 'tauri'}-${what === 'the source tree' ? 'src' : 'dist'}`, entry, base)
        const wasm = files(dist).filter((f) => /occt-import-js[^/\\]*\.wasm$/.test(f))
        expect(wasm.length).toBeGreaterThan(0)
        for (const f of wasm) expect(statSync(f).size).toBe(WASM_BYTES)
        const targets = wasmTargets(dist, origin)
        expect(targets.length).toBeGreaterThan(0)
        console.log(`${host}, ${what}: ${targets.map((t) => t.slice(dist.length + 1)).join(', ')}`)
        for (const t of targets) expect(existsSync(t), t).toBe(true)
      })
    }
  }
})
