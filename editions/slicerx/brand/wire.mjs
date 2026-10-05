// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Copies the built kit to the places that ship it: the site, the phone app, the desktop app and the
// README. Run through ./build.sh, after raster.mjs. Each target is listed once here so a move is a
// one line change. Files under apps/site/public/brand are public addresses: regenerate them under
// the same name and never rename one.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fontPaths } from './text.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../../..')
const out = (p) => join(here, 'out', p)
const svg = (p) => join(here, 'svg', p)

const site = join(repo, 'apps/site')
const mobile = join(repo, 'editions/slicerx/apps/mobile/assets')
const desktop = join(repo, 'apps/desktop/src-tauri/icons')
const readme = join(repo, 'docs/readme-assets')

const copies = [
  // Site: the tab, Safari, the home screen, the manifest.
  [out('favicon/icon.svg'), join(site, 'app/icon.svg')],
  [out('favicon/favicon.ico'), join(site, 'app/favicon.ico')],
  [out('favicon/apple-icon.png'), join(site, 'app/apple-icon.png')],
  ...['icon-192.png', 'icon-512.png', 'icon-maskable-512.png'].map((f) => [out(`favicon/${f}`), join(site, 'public/brand', f)]),
  // Site: the mark and lockups by address.
  ...['mark', 'mark-light', 'tile', 'lockup', 'lockup-light'].map((n) => [svg(`slicerx-${n}.svg`), join(site, 'public/brand', `slicerx-${n}.svg`)]),
  ...['png/slicerx-mark-256.png', 'png/slicerx-mark-512.png', 'png/slicerx-tile-512.png', 'png/slicerx-lockup-dark-720.png', 'png/slicerx-lockup-light-720.png']
    .map((f) => [out(f), join(site, 'public/brand', f.split('/')[1])]),
  [out('social/slicerx-og-1200x630.png'), join(site, 'public/brand/slicerx-og-1200x630.png')],
  // Site: what the opengraph-image route reads.
  [svg('slicerx-og-art.svg'), join(site, 'assets/brand/og-art.svg')],
  [svg('slicerx-lockup.svg'), join(site, 'assets/brand/og-lockup.svg')],
  [join(here, 'layout.json'), join(site, 'assets/brand/layout.json')],
  [fontPaths.body, join(site, 'assets/fonts/HankenGrotesk-Medium.ttf')],
  [fontPaths.bodyBold, join(site, 'assets/fonts/HankenGrotesk-SemiBold.ttf')],
  [fontPaths.mono, join(site, 'assets/fonts/JetBrainsMono-Medium.ttf')],

  // The studio web app and the copy of it the site serves: the tab icon.
  [svg('slicerx-tab.svg'), join(repo, 'apps/web/public/favicon.svg')],
  [svg('slicerx-tab.svg'), join(site, 'public/studio/favicon.svg')],

  // Phone app: the names app.config.ts already uses, plus the three iOS appearances and the themed layer.
  [out('ios/icon-dark-1024.png'), join(mobile, 'icon.png')],
  [out('ios/icon-light-1024.png'), join(mobile, 'icon-light.png')],
  [out('ios/icon-tinted-1024.png'), join(mobile, 'icon-tinted.png')],
  [out('android/adaptive-foreground-1024.png'), join(mobile, 'adaptive-icon.png')],
  [out('android/adaptive-monochrome-1024.png'), join(mobile, 'adaptive-icon-monochrome.png')],
  [out('splash/splash-icon-1024.png'), join(mobile, 'splash-icon.png')],
  [out('splash/splash-icon-light-1024.png'), join(mobile, 'splash-icon-light.png')],

  // Desktop: the whole Tauri icon set, and the 1024 source `tauri icon` would start from.
  ...['32x32.png', '64x64.png', '128x128.png', '128x128@2x.png', 'icon.png', 'icon.icns', 'icon.ico', 'StoreLogo.png']
    .map((f) => [out(`desktop/${f}`), join(desktop, f)]),
  ...[30, 44, 71, 89, 107, 142, 150, 284, 310].map((s) => [out(`desktop/Square${s}x${s}Logo.png`), join(desktop, `Square${s}x${s}Logo.png`)]),
  [out('ios/icon-dark-1024.png'), join(repo, 'apps/desktop/icons-src/icon-1024.png')],

  // README banner.
  [svg('slicerx-banner-dark.svg'), join(readme, 'banner-dark.svg')],
  [svg('slicerx-banner-dark.svg'), join(readme, 'banner.svg')],
  [svg('slicerx-banner-light.svg'), join(readme, 'banner-light.svg')],
]

// the site lives outside this repository; its targets are skipped when it is absent
const targets = existsSync(site) ? copies : copies.filter(([, to]) => !to.startsWith(site))
for (const [from, to] of targets) {
  mkdirSync(dirname(to), { recursive: true })
  copyFileSync(from, to)
}
console.log(`${targets.length} files copied to the site, phone app, desktop app and README`)
