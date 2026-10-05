// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Vite settings the browser and desktop builds share: build info, the edition
// config and the feature switches. apps/desktop imports this file.
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { viteDefines } from '@slicerx/edition-config'
import { buildCommit, editionAssetsPlugin, editionFontAssets, editionFontFiles, editionLogoAssets, loadEditionConfig } from '@slicerx/edition-config/node'
import { loadEnv, type UserConfig } from 'vite'

const root = resolve(import.meta.dirname, '../..')

/**
 * `base` is the public path: './' for the desktop shell, '/studio/' for the hosted web app.
 * Base config for an app entry in `appDir` (its package.json gives the version). The commit comes from
 * SLICERX_COMMIT, the repository or a BUILD_COMMIT file; only the dev server may fall back to `dev`.
 * The edition config (name, theme, features, endpoints) comes from SLICERX_CONFIG,
 * else `editionFile`, else the neutral defaults. SLICERX_* values may also sit in
 * the app's git-ignored .env.local. SX_FEATURES still overrides the feature switches.
 */
export async function sharedConfig(appDir: string, port: number, editionFile?: string, base = './', command: 'build' | 'serve' = 'build'): Promise<UserConfig> {
  const pkg = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8')) as { version: string }
  const env: Record<string, string | undefined> = { ...loadEnv('production', appDir, ['SLICERX_', 'SX_']), ...process.env }
  const file = env['SLICERX_CONFIG'] ?? editionFile
  const loaded = await loadEditionConfig({ env, cwd: root, ...(file ? { file } : {}) })
  // Logo and font files next to the config ship with the build: small logos inline, the rest as files, so a
  // large PNG mark never lands in the startup JS.
  const configFile = file ? resolve(root, file) : null
  const logos = configFile ? editionLogoAssets(loaded, configFile, base) : { config: loaded, assets: [] }
  const fonts = configFile ? editionFontAssets(editionFontFiles(loaded, configFile), base) : { assets: [], css: '' }
  const edition = logos.config
  return {
    base,
    plugins: [react(), editionAssetsPlugin([...logos.assets, ...fonts.assets], fonts.css, base)],
    define: {
      __SX_VERSION__: JSON.stringify(pkg.version),
      __SX_COMMIT__: JSON.stringify(buildCommit(root, command === 'serve', env)),
      // Only the end-to-end test build sets this (apps/web/playwright.config.ts).
      __SX_E2E__: JSON.stringify(env['SLICERX_E2E'] === '1'),
      ...viteDefines(edition, env),
    },
    server: { port, strictPort: false, fs: { allow: [root] } },
    build: { target: 'es2023', sourcemap: false, assetsDir: 'static', manifest: true },
    worker: { format: 'es' },
  }
}
