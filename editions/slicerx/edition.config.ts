// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The SlicerX edition's own configuration: an instance of @slicerx/edition-config.
// Endpoints come from the environment (SLICERX_*), so no deployment detail lives here.
// Forks copy docs/integrating.md's example instead of this file: the name, logo and
// app.slicerx.* identifiers are SlicerX's and the schema refuses them for other ids.
import { defineEditionConfig } from '../../packages/edition-config/src/index.ts'

const env = typeof process === 'undefined' ? {} : process.env
const cloud = env['SLICERX_CLOUD_API_URL'] ?? null
const relay = env['SLICERX_RELAY_URL'] ?? null
const supabase = env['SLICERX_SUPABASE_URL'] && env['SLICERX_SUPABASE_ANON_KEY']
  ? { url: env['SLICERX_SUPABASE_URL'], anonKey: env['SLICERX_SUPABASE_ANON_KEY'] }
  : null

// In-app desktop updates: the manifest publish.sh keeps on the fixed desktop-updates release, which no engine or model
// release touches, and the public half of the update signing key, made once on the release Mac and kept there
// (apps/desktop/release/updates.md). Until the key is set the desktop app never looks for updates.
const UPDATE_FEED = 'https://github.com/slicerx-oss/slicerx/releases/download/desktop-updates/latest.json'
const UPDATE_PUBKEY = 'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDdBQzI4RjU1QTRFNjlCRDgKUldUWW0rYWtWWS9DZWp6L1MvZTBSdDNwNlNOZEVLQWZRK0N4Uzg1dzJQeUdGRzJQZFdkQ3h5WVIK'

export default defineEditionConfig({
  id: 'slicerx',
  brand: {
    name: 'SlicerX',
    shortName: 'SlicerX',
    tagline: 'The AI-ready slicer',
    description: 'Fast, open source 3D print slicer',
    logo: { mark: 'builtin:slicerx-mark' },
    theme: 'subban',
  },
  apps: {
    web: { origin: 'https://slicerx.app' },
    desktop: { identifier: 'app.slicerx.desktop', productName: 'SlicerX' },
    ios: { bundleId: 'app.slicerx.mobile' },
    android: { applicationId: 'app.slicerx.mobile' },
    deepLinkScheme: 'slicerx',
    universalLinkDomains: ['slicerx.app'],
  },
  backend: { supabase, cloudApi: cloud, relay },
  features: {
    store: true,
    feed: true,
    creators: true,
    // Without a backend the store and feed run on the bundled demo catalog.
    demoData: supabase === null,
    // Hosted cloud slicing is invite only. It is on when
    // SLICERX_CLOUD_API_URL names the deployed service; without it the service
    // runs only the library upload scan and the account purge.
    cloudSlicing: cloud !== null,
    phonePairing: relay !== null,
    pilot: true,
  },
  auth: { providers: [{ kind: 'email' }] },
  ai: { provider: 'openai', model: 'gpt-6-sol', keySource: 'keychain' },
  // Download URLs are set when releases exist.
  funding: {
    githubSponsors: 'https://github.com/sponsors/Subydev',
    buyMeACoffee: 'https://buymeacoffee.com/xccyf47w7r',
    payWhatYouWant: 'https://slicerx.app/support',
  },
  downloads: {},
  // The owner approves every upload by hand at first; moderators join later.
  library: { moderation: { mode: 'owner-approves-all', maxFileMb: 100, allowedFormats: ['3mf', 'sx3mf', 'stl'] } },
  routes: {
    landing: '/',
    studio: '/studio',
    login: '/login',
    creators: '/creators',
    creator: '/creators/:handle',
    dashboard: '/dashboard',
    moderation: '/moderation',
  },
  firstRun: { defaultLook: 'slicerx' },
  // Testers and the dev kit get pre-alpha builds: the first run asks them to accept the agreement, and crash reports stay on.
  release: {
    stage: 'pre-alpha',
    bugReportsUrl: 'https://discord.com/channels/1555048815881355324/1556010155802628228',
    ...(UPDATE_PUBKEY ? { updates: { endpoints: [UPDATE_FEED], pubkey: UPDATE_PUBKEY } } : {}),
  },
  legal: {
    sourceUrl: 'https://github.com/slicerx-oss/slicerx/tree/{commit}',
    trademarkNotice: 'SlicerX and its logo are trademarks of the SlicerX project.',
    attribution: { text: 'Made possible by SlicerX', url: 'https://slicerx.app/support' },
    license: 'Apache-2.0; stock printer profiles AGPL-3.0-or-later',
    publisher: 'Sean Leonard',
    copyright: 'Copyright (C) 2026 The SlicerX contributors',
  },
  links: { docs: 'https://slicerx.app/docs', support: 'https://slicerx.app/support', download: 'https://slicerx.app/#download' },
})
