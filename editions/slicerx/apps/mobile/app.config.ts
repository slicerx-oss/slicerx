// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//
// The Expo config comes from the edition config (editions/slicerx/edition.config.ts,
// validated by @slicerx/edition-config), so a fork rebrands the app by editing that file
// and its SLICERX_* environment, not this one. Expo loads .env and .env.local from this
// folder before it evaluates this file; see SETUP.md for the variables.
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import type { ConfigContext, ExpoConfig } from 'expo/config'
import type { EditionConfig } from '@slicerx/edition-config'

const ROOT = join(__dirname, '../../../..')
const CONFIG_FILE = process.env['SLICERX_CONFIG'] ?? join(ROOT, 'editions/slicerx/edition.config.ts')

// The loader is async and imports TypeScript, so it runs in its own Node process.
function loadEdition(): EditionConfig {
  const out = execFileSync(process.execPath, [join(ROOT, 'packages/edition-config/src/cli.ts'), 'resolve', CONFIG_FILE], { encoding: 'utf8', env: process.env })
  return JSON.parse(out) as EditionConfig
}

const BACKGROUND = '#121319'

export default ({ config }: ConfigContext): ExpoConfig => {
  const edition = loadEdition()
  const { apps, brand } = edition
  const domains = apps.universalLinkDomains
  const bundleId = apps.ios?.bundleId
  const packageId = apps.android?.applicationId
  if (!bundleId || !packageId) throw new Error('The edition config needs apps.ios.bundleId and apps.android.applicationId for the phone app')

  return {
    ...config,
    name: brand.shortName ?? brand.name,
    slug: `${edition.id}-mobile`,
    version: '0.1.0',
    scheme: apps.deepLinkScheme,
    orientation: 'portrait',
    userInterfaceStyle: 'dark',
    backgroundColor: BACKGROUND,
    icon: './assets/icon.png',
    ios: {
      icon: { dark: './assets/icon.png', light: './assets/icon-light.png', tinted: './assets/icon-tinted.png' },
      bundleIdentifier: bundleId,
      supportsTablet: true,
      associatedDomains: domains.map((d) => `applinks:${d}`),
      usesAppleSignIn: edition.auth.providers.some((p) => p.kind === 'apple'),
      ...(apps.ios?.teamId ? { appleTeamId: apps.ios.teamId } : {}),
      infoPlist: {
        // Printers and sx-link are found and reached on the local network.
        NSLocalNetworkUsageDescription: `${brand.name} connects to printers and to ${brand.name} on your computer over your local network.`,
        NSBonjourServices: ['_slicerx._tcp', '_sx-link._tcp', '_moonraker._tcp', '_octoprint._tcp'],
        ITSAppUsesNonExemptEncryption: false,
      },
    },
    android: {
      package: packageId,
      adaptiveIcon: { foregroundImage: './assets/adaptive-icon.png', monochromeImage: './assets/adaptive-icon-monochrome.png', backgroundColor: BACKGROUND },
      intentFilters: domains.length
        ? [{ action: 'VIEW', autoVerify: true, data: domains.map((host) => ({ scheme: 'https', host })), category: ['BROWSABLE', 'DEFAULT'] }]
        : [],
    },
    plugins: [
      'expo-router',
      'expo-font',
      'expo-secure-store',
      'expo-web-browser',
      ['expo-splash-screen', { image: './assets/splash-icon.png', imageWidth: 160, backgroundColor: BACKGROUND }],
      ['expo-notifications', { color: '#bd93f9' }],
      ['expo-camera', { cameraPermission: `${brand.name} uses the camera to scan the pairing code on your computer.`, microphonePermission: false, recordAudioAndroid: false }],
      ...(edition.auth.providers.some((p) => p.kind === 'apple') ? ['expo-apple-authentication'] : []),
      // Printers and paired computers on the LAN speak plain http and ws on private addresses.
      ['expo-build-properties', { ios: { deploymentTarget: '16.4' }, android: { minSdkVersion: 26, usesCleartextTraffic: true } }],
    ],
    experiments: { typedRoutes: true },
    // `eas init` prints the project id; push tokens need it (SETUP.md).
    extra: { edition, ...(process.env['EXPO_PROJECT_ID'] ? { eas: { projectId: process.env['EXPO_PROJECT_ID'] } } : {}) },
  }
}
