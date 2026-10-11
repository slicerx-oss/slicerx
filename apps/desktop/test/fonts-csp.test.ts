// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The desktop shell's CSP takes fonts only from its own origin (font-src 'self'), so a font must never reach the built
// CSS as a data: URL: WebKitGTK refuses it on Linux ("Refused by font-src"). Vite inlines small assets by default, which
// caught the smallest subsets of the bundled variable fonts.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { describe, expect, it } from 'vitest'
import { inlineAsset, sharedConfig } from '@slicerx/web/vite'

const csp = (JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8')) as { app: { security: { csp: Record<string, string> } } }).app.security.csp

describe('fonts and the CSP', () => {
  it('never inlines a font file, and leaves other assets to Vite', () => {
    for (const f of ['/n/m/@fontsource-variable/unbounded/files/unbounded-vietnamese-wght-normal.woff2', 'a.woff', 'b.TTF', 'c.otf']) expect(inlineAsset(f), f).toBe(false)
    for (const f of ['logo.png', 'mark.svg', 'x.wasm']) expect(inlineAsset(f), f).toBeUndefined()
  })

  it('builds a bundled font with its smallest subsets as files, none as data: URLs', async () => {
    const config = await sharedConfig(fileURLToPath(new URL('..', import.meta.url)), 5174)
    expect(config.build?.assetsInlineLimit).toBe(inlineAsset)
    // One of the app's own fonts, whose smallest subsets fall under Vite's 4 KB inline limit. packages/app depends on
    // it, so it is resolved from there.
    const font = createRequire(fileURLToPath(new URL('../../../packages/app/package.json', import.meta.url))).resolve('@fontsource-variable/unbounded')
    const dir = mkdtempSync(join(tmpdir(), 'sx-fonts-'))
    try {
      writeFileSync(join(dir, 'main.js'), `import ${JSON.stringify(font.split('\\').join('/'))}\n`)
      writeFileSync(join(dir, 'index.html'), '<!doctype html><script type="module" src="./main.js"></script>\n')
      await build({ configFile: false, root: dir, base: './', logLevel: 'silent', build: { ...config.build, outDir: join(dir, 'out'), manifest: false } })
      const files = readdirSync(join(dir, 'out', 'static'))
      const css = files
        .filter((f) => f.endsWith('.css'))
        .map((f) => readFileSync(join(dir, 'out', 'static', f), 'utf8'))
        .join('\n')
      expect(css).toContain('@font-face')
      expect(css).not.toMatch(/url\(\s*["']?data:/)
      expect(files.some((f) => f.endsWith('.woff2'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('keeps font-src to the app itself, with no data: fonts allowed', () => {
    expect(csp['font-src']?.split(/\s+/)).toContain("'self'")
    expect(csp['font-src']).not.toContain('data:')
  })
})
