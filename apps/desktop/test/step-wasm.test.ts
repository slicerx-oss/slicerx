// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// One copy of the STEP reader in the app. The page's build leaves the wasm out (step-wasm-plugin.ts, in both the page and
// worker plugins of vite.config.ts), the window asks for the copy beside the MCP server by its resource path, the asset
// protocol's scope is that one file, and the CSP adds only the asset protocol's origins to connect-src. The scope itself
// is checked with Tauri's own scope in src-tauri/tests/asset_scope.rs.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build, type Plugin, type UserConfig } from 'vite'
import { describe, expect, it } from 'vitest'
import { dropStepWasm, NO_BUNDLED_WASM } from '../step-wasm-plugin'
import desktopConfig from '../vite.config'
import { STEP_WASM_RESOURCE, stepWasmUrl } from '../src/host/step-wasm'

const repo = resolve(import.meta.dirname, '..', '..', '..')
const conf = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8')) as {
  app: { security: { csp: Record<string, string>; assetProtocol: { enable: boolean; scope: { allow: string[]; deny: string[] } } } }
}

/** Builds a page whose worker loads the reader, as step-worker.ts does; returns the built file names. */
async function buildWorkerPage(plugins: Plugin[], worker: NonNullable<UserConfig['worker']>): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), 'sx-step-wasm-build-'))
  try {
    const index = join(repo, 'packages', 'step-reader', 'src', 'index.ts').split('\\').join('/')
    writeFileSync(join(dir, 'w.js'), `import { loadOcct } from ${JSON.stringify(index)}\nself.onmessage = (e) => loadOcct(e.data.wasm ? { wasm: e.data.wasm } : {})\n`)
    writeFileSync(join(dir, 'main.js'), "new Worker(new URL('./w.js', import.meta.url), { type: 'module' })\n")
    writeFileSync(join(dir, 'index.html'), '<!doctype html><script type="module" src="./main.js"></script>\n')
    await build({ configFile: false, root: dir, base: './', logLevel: 'silent', plugins, worker, build: { outDir: join(dir, 'out'), assetsDir: 'static', manifest: false } })
    return readdirSync(join(dir, 'out', 'static'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('the STEP reader wasm in the desktop page', () => {
  it('replaces both references to the bundled wasm, in the loader and in the glue', () => {
    const loader = readFileSync(join(repo, 'packages', 'step-reader', 'src', 'load.ts'), 'utf8')
    const glue = readFileSync(join(repo, 'packages', 'step-reader', 'src', 'occt-import-js.mjs'), 'utf8')
    for (const code of [loader, glue]) {
      const out = dropStepWasm(code)
      expect(out).not.toBeNull()
      expect(out).not.toMatch(/occt-import-js\.wasm['"]\s*,\s*import\.meta\.url/)
      expect(out).toContain(NO_BUNDLED_WASM)
    }
    expect(dropStepWasm("new URL('./other.wasm', import.meta.url)")).toBeNull()
  })

  it('leaves the wasm out of the desktop build, worker included, where a build without the plugin keeps it', async () => {
    const desktop = (await (desktopConfig as unknown as (env: { command: 'build'; mode: string }) => Promise<UserConfig>)({ command: 'build', mode: 'production' }))
    const ours = (desktop.plugins ?? []).filter((p): p is Plugin => !!p && (p as Plugin).name === 'sx-step-wasm-from-resources')
    expect(ours).toHaveLength(1)
    expect(desktop.worker).toBeDefined()
    const withPlugin = await buildWorkerPage(ours, desktop.worker!)
    expect(withPlugin.filter((f) => f.endsWith('.wasm'))).toEqual([])
    const without = await buildWorkerPage([], { format: 'es' })
    expect(without.some((f) => /^occt-import-js-.+\.wasm$/.test(f))).toBe(true)
  }, 120_000)

  it('asks for the copy beside the MCP server, the one file the asset protocol may serve', async () => {
    expect(conf.app.security.assetProtocol.enable).toBe(true)
    expect(conf.app.security.assetProtocol.scope.allow).toEqual([`$RESOURCE/${STEP_WASM_RESOURCE}`])
    const asked: string[] = []
    const url = await stepWasmUrl(
      async (p) => (asked.push(p), `/Applications/SlicerX.app/Contents/Resources/${p}`),
      (p) => `asset://localhost/${encodeURIComponent(p)}`,
    )
    expect(asked).toEqual(['mcp/step-reader/occt-import-js.wasm'])
    expect(url).toBe(`asset://localhost/${encodeURIComponent('/Applications/SlicerX.app/Contents/Resources/mcp/step-reader/occt-import-js.wasm')}`)
  })

  it('adds only the asset protocol origins to connect-src, and nothing to script-src or worker-src', () => {
    const csp = conf.app.security.csp
    expect(csp['connect-src']).toBe("'self' ipc: http://ipc.localhost ws://127.0.0.1:47615 asset: http://asset.localhost")
    expect(csp['script-src']).toBe("'self' 'wasm-unsafe-eval'")
    expect(csp['worker-src']).toBe("'self' blob:")
    expect(csp['default-src']).toBe("'self'")
  })
})
