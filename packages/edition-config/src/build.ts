// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Build-time outputs: bundler defines, Tauri and Expo settings, universal link files.
import { editionLinks } from './links.ts'
import type { EditionConfig } from './schema.ts'

/** Global the web, desktop and phone builds define; read it with editionFromBuild(). */
export const EDITION_GLOBAL = '__SX_EDITION__'

/**
 * Vite `define` entries: the whole config as `__SX_EDITION__`, plus the `__SX_FEATURE_*__` switches
 * the apps use for dead-code elimination. `SX_FEATURES`, when set, still decides those switches
 * (it is how CI builds the no-features variant); `orca` is never set from the config.
 */
export function viteDefines(config: EditionConfig, env: Record<string, string | undefined> = {}): Record<string, string> {
  const f = config.features
  const fromConfig: Record<string, boolean> = {
    store: f.store || f.feed || f.creators,
    pilot: f.pilot,
    connect: Object.values(f.printers).some(Boolean),
    cloud: f.cloudSlicing,
  }
  const list = env['SX_FEATURES']
  const switches = list === undefined ? fromConfig : Object.fromEntries(Object.keys(fromConfig).map((k) => [k, list.split(',').map((s) => s.trim()).includes(k)]))
  return {
    [EDITION_GLOBAL]: JSON.stringify(config),
    ...Object.fromEntries(Object.entries(switches).map(([k, v]) => [`__SX_FEATURE_${k.toUpperCase()}__`, JSON.stringify(v)])),
  }
}

/**
 * The desktop webview's own connect-src (apps/desktop/src-tauri/tauri.conf.json); the backend's origins are added to it.
 * It includes the printer bridge the app starts on 127.0.0.1 (sx-link's DEFAULT_PORT), which the page connects to.
 */
/** Every optional part of the geometry engine (sx-geom's cargo features). */
export const GEOM_FEATURES = ['cad', 'holes', 'threads', 'shell', 'text', 'svg', 'nest', 'calib', 'hollow'] as const

/**
 * The geometry engine's cargo features for an edition, or null for the default build with all of them. An edition
 * without the modeling tools leaves out `cad` and the hole, thread and shell tools built on it.
 */
export function geomFeatures(config: EditionConfig): string[] | null {
  return config.features.cad ? null : GEOM_FEATURES.filter((f) => f !== 'cad' && f !== 'holes' && f !== 'threads' && f !== 'shell')
}

export const DESKTOP_CONNECT_SRC = "'self' ipc: http://ipc.localhost ws://127.0.0.1:47615"

/** The desktop webview's own img-src (tauri.conf.json); the backend's public storage is added to it. */
export const DESKTOP_IMG_SRC = "'self' data: blob:"

/** Where a Supabase project serves public storage objects: Vault covers, creator logos and banners. */
export function publicStorageSource(supabaseUrl: string): string {
  return `${new URL(supabaseUrl).origin}/storage/v1/object/public/`
}

/** Pages capabilities/default.json already lets the desktop shell open. */
const SLICERX_PAGES = ['https://slicerx.app/', 'https://discord.com/channels/1555048815881355324/']

/** The main window, as apps/desktop/src-tauri/tauri.conf.json has it apart from the title (a test keeps them in step). */
/** On macOS the title bar is an overlay with no title: the traffic lights sit in the app's top bar (the keys are macOS-only; other systems keep their title bar). */
export const DESKTOP_WINDOW = {
  label: 'main',
  width: 1440,
  height: 900,
  minWidth: 960,
  minHeight: 600,
  backgroundColor: '#121319',
  dragDropEnabled: false,
  titleBarStyle: 'Overlay',
  hiddenTitle: true,
  trafficLightPosition: { x: 18, y: 20 },
} as const

/** The file types the desktop app opens. The overlay replaces tauri.conf.json's list, so the whole list lives here. */
export function desktopFileTypes(config: EditionConfig): { ext: string[]; name: string; role: 'Editor' | 'Viewer' }[] {
  const name = config.brand.name
  return [
    { ext: ['3mf'], name: '3MF model', role: 'Editor' },
    { ext: ['stl'], name: 'STL model', role: 'Editor' },
    { ext: ['obj'], name: 'OBJ model', role: 'Editor' },
    { ext: ['amf'], name: 'AMF model', role: 'Editor' },
    { ext: ['step', 'stp'], name: 'STEP model', role: 'Editor' },
    { ext: ['sx3mf'], name: `${name} 3MF file`, role: 'Editor' },
    { ext: ['sxlock'], name: `Locked ${name} project`, role: 'Editor' },
    { ext: ['gcode'], name: 'G-code', role: 'Viewer' },
  ]
}

/** Where the desktop build writes the icons it makes from `brand.logo.appIcon`, relative to src-tauri. */
export const DESKTOP_ICON_DIR = 'gen/icons'
export const DESKTOP_ICONS = ['32x32.png', '128x128.png', '128x128@2x.png', 'icon.icns', 'icon.ico'] as const

/** What installers show: the publisher, the copyright line and the one-line description. */
export function publisherOf(config: EditionConfig): { publisher: string; copyright: string; description: string } {
  const publisher = config.legal.publisher ?? config.brand.name
  return {
    publisher,
    copyright: config.legal.copyright ?? `Copyright (C) ${publisher}`,
    description: config.brand.description ?? config.brand.tagline ?? config.brand.name,
  }
}

/**
 * Partial tauri.conf.json for `tauri build --config <file>` (desktop or the phone app). Tauri merges it as a JSON
 * merge patch, so lists (windows, file types, icons) are replaced whole and every branded value is set here.
 * An edition with `brand.logo.appIcon` gets icons made from it in DESKTOP_ICON_DIR (the CLI runs `tauri icon`).
 */
export function tauriConfig(config: EditionConfig, target: 'desktop' | 'mobile'): Record<string, unknown> {
  const mobile = target === 'mobile'
  const identifier = mobile ? config.apps.ios?.bundleId ?? config.apps.android?.applicationId ?? config.apps.desktop.identifier : config.apps.desktop.identifier
  const scheme = config.apps.deepLinkScheme
  const plugins = {
    'deep-link': {
      desktop: { schemes: [scheme] },
      mobile: [{ scheme: [scheme], appLink: false }, ...config.apps.universalLinkDomains.map((host) => ({ host, appLink: true }))],
    },
  }
  if (mobile) return { productName: config.brand.shortName ?? config.brand.name, identifier, plugins }
  // In-app updates (apps/desktop/src-tauri/src/updates.rs): on only for an edition with its own feed and key. The
  // signature must name the version the feed announces, so an old signed build cannot pass as a new one.
  const updates = config.release.updates
  const updater = updates ? { updater: { endpoints: updates.endpoints, pubkey: updates.pubkey, requireSignedVersion: true, windows: { installMode: 'passive' } } } : {}
  // The desktop page calls Supabase itself (the library, bug reports), so its origin joins connect-src, and it shows
  // the Vault's covers and creator logos from the project's public storage, so that path joins img-src.
  // Tauri merges this over the CSP directives in tauri.conf.json; only these two change.
  const sbUrl = config.backend.supabase?.url
  const supabase = sbUrl ? new URL(sbUrl).origin : null
  const csp = sbUrl && supabase ? { csp: { 'connect-src': `${DESKTOP_CONNECT_SRC} ${supabase}`, 'img-src': `${DESKTOP_IMG_SRC} ${publicStorageSource(sbUrl)}` } } : {}
  // The shell opens only pages its capabilities allow (capabilities/default.json allows SlicerX's); the edition's own
  // help, download and bug report pages join them.
  const own = [...Object.values(editionLinks(config)), config.release.bugReportsUrl]
    .filter((u): u is string => u !== undefined && !SLICERX_PAGES.some((p) => u.startsWith(p)))
    .map((u) => new URL(u).origin)
    .filter((o, i, all) => all.indexOf(o) === i)
  const capabilities = own.length
    ? { capabilities: ['default', { identifier: 'edition-links', description: "The edition's own web pages, opened in the system browser.", windows: ['main'], permissions: [{ identifier: 'opener:allow-open-url', allow: own.map((o) => ({ url: `${o}/*` })) }] }] }
    : {}
  const security = supabase || own.length ? { security: { ...csp, ...capabilities } } : {}
  const { publisher, copyright, description } = publisherOf(config)
  return {
    productName: config.apps.desktop.productName,
    identifier,
    app: { windows: [{ ...DESKTOP_WINDOW, title: config.brand.name }], ...security },
    bundle: {
      publisher,
      copyright,
      shortDescription: description,
      ...(config.apps.web.origin ? { homepage: config.apps.web.origin } : {}),
      fileAssociations: desktopFileTypes(config),
      ...(config.brand.logo.appIcon ? { icon: DESKTOP_ICONS.map((f) => `${DESKTOP_ICON_DIR}/${f}`) } : {}),
    },
    plugins: { ...plugins, ...updater },
  }
}

/** Fields an Expo `app.config.ts` takes from the edition; spread over the app's own config. */
export function expoConfig(config: EditionConfig): Record<string, unknown> {
  const domains = config.apps.universalLinkDomains
  return {
    name: config.brand.shortName ?? config.brand.name,
    slug: config.id,
    scheme: config.apps.deepLinkScheme,
    ios: config.apps.ios && { bundleIdentifier: config.apps.ios.bundleId, associatedDomains: domains.map((d) => `applinks:${d}`) },
    android: config.apps.android && {
      package: config.apps.android.applicationId,
      intentFilters: domains.length ? [{ action: 'VIEW', autoVerify: true, data: domains.map((host) => ({ scheme: 'https', host })), category: ['BROWSABLE', 'DEFAULT'] }] : [],
    },
    extra: { edition: config },
  }
}

/** Files the site serves under /.well-known so the apps open universal links. */
export function wellKnown(config: EditionConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const ios = config.apps.ios
  if (ios?.teamId) out['apple-app-site-association'] = { applinks: { details: [{ appIDs: [`${ios.teamId}.${ios.bundleId}`], components: [{ '/': '/*' }] }] } }
  const android = config.apps.android
  if (android && android.sha256CertFingerprints.length) {
    out['assetlinks.json'] = [{ relation: ['delegate_permission/common.handle_all_urls'], target: { namespace: 'android_app', package_name: android.applicationId, sha256_cert_fingerprints: android.sha256CertFingerprints } }]
  }
  return out
}

/** The link to this build's source, for About screens and the site footer. */
export function sourceUrl(config: EditionConfig, commit: string): string | null {
  return config.legal.sourceUrl ? config.legal.sourceUrl.replaceAll('{commit}', commit) : null
}
