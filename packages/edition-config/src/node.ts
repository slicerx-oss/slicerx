// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Node-only loaders: config files and the environment. Import from '@slicerx/edition-config/node'.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, extname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { NEUTRAL_EDITION } from './defaults.ts'
import { parseEditionConfig } from './define.ts'
import { envLayer } from './env.ts'
import { fontFaceCss } from './fonts.ts'
import { mergeLayers } from './merge.ts'
import type { EditionConfig } from './schema.ts'

/**
 * Loads a config for a running service or a build script: the file (TypeScript or JSON), then
 * `SLICERX_*` overrides from the environment, validated. `file` defaults to `SLICERX_CONFIG`, then
 * `slicerx.config.json` in the working directory; with neither, the neutral defaults are used.
 */
export async function loadEditionConfig(opts: { file?: string; env?: Record<string, string | undefined>; cwd?: string; inlineLogo?: boolean } = {}): Promise<EditionConfig> {
  const env = opts.env ?? process.env
  const cwd = opts.cwd ?? process.cwd()
  const named = opts.file ?? env['SLICERX_CONFIG']
  const file = named ? resolve(cwd, named) : existsSync(resolve(cwd, 'slicerx.config.json')) ? resolve(cwd, 'slicerx.config.json') : null
  if (named && file && !existsSync(file)) throw new Error(`edition config not found: ${file}`)
  let base: unknown = NEUTRAL_EDITION
  if (file) base = /\.json$/i.test(file) ? JSON.parse(readFileSync(file, 'utf8')) : ((await import(pathToFileURL(file).href)) as { default: unknown }).default
  const config = parseEditionConfig(mergeLayers(base, envLayer(env, base as { auth?: { providers?: readonly unknown[] } })))
  return opts.inlineLogo && file ? inlineLogo(config, file) : config
}

const IMAGE_TYPES: Record<string, string> = { '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }

/** The file an edition asset names, resolved against the config file. Null for `builtin:` artwork and URLs. */
export function editionAssetPath(configFile: string, asset: string | undefined): string | null {
  if (!asset || /^(builtin:|https:|data:)/.test(asset)) return null
  return resolve(dirname(configFile), asset)
}

/** The edition's mark and wordmark files as data URLs, so a build shows them without serving the files. */
export function inlineLogo(config: EditionConfig, configFile: string): EditionConfig {
  const logo = { ...config.brand.logo }
  for (const key of ['mark', 'wordmark'] as const) {
    const path = editionAssetPath(configFile, logo[key])
    const type = path ? IMAGE_TYPES[extname(path).toLowerCase()] : undefined
    if (!path || !type) continue
    if (!existsSync(path)) throw new Error(`brand.logo.${key} not found: ${path}`)
    logo[key] = `data:${type};base64,${readFileSync(path).toString('base64')}`
  }
  return Object.freeze({ ...config, brand: { ...config.brand, logo } })
}

/** A font file the edition bundles, resolved to its path on disk. */
export interface EditionFontFile {
  family: string
  path: string
  weight?: string | undefined
  style?: 'normal' | 'italic' | undefined
}

/** The edition's `fontFiles`, resolved against the config file. Throws when a file is missing. */
export function editionFontFiles(config: EditionConfig, configFile: string): EditionFontFile[] {
  const t = config.brand.theme
  if (typeof t === 'string') return []
  return (t.tokens.fontFiles ?? []).map((f, i) => {
    const path = editionAssetPath(configFile, f.src)
    if (!path) throw new Error(`brand.theme.tokens.fontFiles[${i}].src must be a file next to the config, not a URL`)
    if (!existsSync(path)) throw new Error(`brand.theme.tokens.fontFiles[${i}].src not found: ${path}`)
    return { family: f.family, path, weight: f.weight, style: f.style }
  })
}

/** A file the build copies into its output, under `name` (relative to the output folder). */
export interface BuildAsset {
  name: string
  bytes: Uint8Array
}

function buildAsset(path: string, dir: string): BuildAsset {
  const bytes = readFileSync(path)
  return { name: `static/${dir}/${createHash('sha256').update(bytes).digest('hex').slice(0, 8)}-${basename(path)}`, bytes }
}

/** The edition's font files as build assets, with the @font-face rules that load them from `base`. */
export function editionFontAssets(files: readonly EditionFontFile[], base: string): { assets: BuildAsset[]; css: string } {
  const assets = files.map((f) => buildAsset(f.path, 'fonts'))
  const css = fontFaceCss(files.map((f, i) => ({ family: f.family, url: `${base}${assets[i]!.name}`, weight: f.weight, style: f.style })))
  return { assets, css }
}

/** Logo files up to this size are inlined as data URLs; bigger ones ship as files, so they stay out of the startup JS. */
export const INLINE_LOGO_BYTES = 8 * 1024

/** The edition's mark and wordmark for a build: small files inlined, bigger ones as assets under static/brand. */
export function editionLogoAssets(config: EditionConfig, configFile: string, base: string): { config: EditionConfig; assets: BuildAsset[] } {
  const logo = { ...config.brand.logo }
  const assets: BuildAsset[] = []
  for (const key of ['mark', 'wordmark'] as const) {
    const path = editionAssetPath(configFile, logo[key])
    const type = path ? IMAGE_TYPES[extname(path).toLowerCase()] : undefined
    if (!path || !type) continue
    if (!existsSync(path)) throw new Error(`brand.logo.${key} not found: ${path}`)
    const bytes = readFileSync(path)
    if (bytes.length <= INLINE_LOGO_BYTES) {
      logo[key] = `data:${type};base64,${bytes.toString('base64')}`
      continue
    }
    const asset = buildAsset(path, 'brand')
    assets.push(asset)
    logo[key] = `${base}${asset.name}`
  }
  return { config: Object.freeze({ ...config, brand: { ...config.brand, logo } }), assets }
}

/** The parts of a Vite plugin the asset bundler uses, so this package needs no Vite dependency. */
export interface EditionAssetsPlugin {
  name: string
  configureServer(server: { middlewares: { use(fn: (req: { url?: string | undefined }, res: { setHeader(k: string, v: string): void; end(body: Uint8Array): void }, next: () => void) => void): void } }): void
  generateBundle(this: { emitFile(file: { type: 'asset'; fileName: string; source: Uint8Array }): string }): void
  transformIndexHtml(): { tag: string; attrs: Record<string, string>; children: string; injectTo: 'head-prepend' }[]
}

const CONTENT_TYPES: Record<string, string> = { ...IMAGE_TYPES, '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf' }

/**
 * A Vite plugin that copies the edition's fonts and logos into the build (and serves them in dev) and puts the
 * @font-face rules in the page head, so the brand loads from the app itself in the browser and desktop builds.
 */
export function editionAssetsPlugin(assets: readonly BuildAsset[], css: string, base: string): EditionAssetsPlugin {
  const served = base.replace(/^\.\//, '/')
  return {
    name: 'slicerx-edition-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const hit = assets.find((a) => req.url?.split('?')[0] === `${served}${a.name}`)
        if (!hit) return next()
        res.setHeader('Content-Type', CONTENT_TYPES[extname(hit.name).toLowerCase()] ?? 'application/octet-stream')
        res.end(hit.bytes)
      })
    },
    generateBundle() {
      for (const a of assets) this.emitFile({ type: 'asset', fileName: a.name, source: a.bytes })
    },
    transformIndexHtml() {
      return css ? [{ tag: 'style', attrs: { 'data-edition-fonts': '' }, children: css, injectTo: 'head-prepend' }] : []
    },
  }
}

export { buildCommit, resolveCommit, type CommitSources } from './build-info.ts'
