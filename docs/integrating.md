# Building your own edition

SlicerX has two layers. The base kit (the slicing engine, settings, viewport, printer connectors, mimir and the MCP server) is Apache-2.0 and can be embedded anywhere; `docs/embedding.md` covers that. The edition is the full product built on the base: accounts, cloud slicing, the free model library with creator pages, the branded desktop, web and phone apps, and the site. The edition is Apache-2.0 too. The stock printer profiles it ships (`packages/profiles`) are AGPL-3.0-or-later, so a build that includes them is covered by the AGPL as a whole.

To ship your own edition (a print farm's customer app, a printer maker's slicer, a school's lab tool), you do not edit the code. You write one configuration file, and every edition surface reads it: the web and desktop apps, the phone app, the site, the cloud service and `sx-link`.

Status: the schema, loaders and build helpers are in `packages/edition-config`, and the desktop and web apps take their name, logo, links, link scheme and installer details from it. A few messages from base kit packages (printer catalog notes, the preset import report) still name SlicerX.

## What the configuration covers

| Section | What it sets |
| --- | --- |
| `id` | a short machine id (`harbor`), used in file names, storage keys and user agents |
| `brand` | product name, short name, tagline, a one-line description for installers, logo files (mark, wordmark, app icon), theme (`subban` or token overrides on it), support email |
| `apps` | web origin, desktop identifier and product name, iOS bundle id and team id, Android application id and signing fingerprints, the deep link scheme, universal link domains |
| `backend` | Supabase URL and anon key, the cloud API, the relay for phone pairing, the local `sx-link` port |
| `features` | `store`, `feed`, `creators`, `cloudSlicing`, `phonePairing`, `pilot`, `localAi` (Set up local AI, on by default), `demoData`, and each printer family (`bambu`, `moonraker`, `prusalink`, `octoprint`, `duet`, `creality`, `elegoo`, `snapmaker`, `spoolman`, `homeassistant`) |
| `auth` | sign-in providers (`email`, `github`, `google`, `apple`, `discord`) with their public client ids |

| `ai` | mimir's provider (`openai`, `anthropic`, `openai-compatible`, `none`), default model, base URL, where the key comes from (`keychain`, `env`, `cloud`), and `allowedLocalModels`, the local model ids Set up local AI may offer (all when unset) |
| `legal` | terms, privacy and imprint links, the source link for your builds, a trademark notice, the credit About shows, the publisher and copyright line installers show |
| `links` | your docs, support and download pages (Help, Documentation and the first run's download link); unset ones fall back to SlicerX's |
| `release` | the release stage and your bug report link |

Everything you leave out comes from neutral defaults: a plain reference slicer with mimir and every printer family on, and no store, cloud or phone features. The JSON Schema is `packages/edition-config/schema/edition-config.schema.json`, so editors can complete and check the file for you.

## Worked example: Harbor Slice

Harbor Print Co. (a fictional print service) wants a slicer for its customers. Customers sign in, buy prints of Harbor's catalog, and slice in Harbor's cloud; there is no creator feed and no phone pairing. Harbor runs its own model behind an OpenAI-compatible endpoint, and its customers do not use Duet, Snapmaker or Home Assistant.

`harbor.config.ts` in Harbor's fork:

```ts
import { defineEditionConfig } from '@slicerx/edition-config'

export default defineEditionConfig({
  id: 'harbor',
  brand: {
    name: 'Harbor Slice',
    shortName: 'Harbor',
    tagline: 'Slicing and print management for Harbor Print Co. customers',
    logo: { mark: 'brand/harbor-mark.svg', wordmark: 'brand/harbor-wordmark.svg', appIcon: 'brand/harbor-icon.png' },
    theme: { base: 'subban', tokens: { colors: { purple: '#4fb3bf', pink: '#f2a65a' }, fonts: { display: 'Space Grotesk' } } },
    supportEmail: 'support@harborprint.example',
  },
  apps: {
    web: { origin: 'https://slice.harborprint.example' },
    desktop: { identifier: 'com.harborprint.slice', productName: 'Harbor Slice' },
    ios: { bundleId: 'com.harborprint.slice', teamId: 'ABCDE12345' },
    android: { applicationId: 'com.harborprint.slice', sha256CertFingerprints: ['AA:BB:...:99'] },
    deepLinkScheme: 'harborslice',
    universalLinkDomains: ['slice.harborprint.example'],
  },
  backend: {
    supabase: { url: 'https://abcdefghijklmnop.supabase.co', anonKey: 'public-anon-key-from-the-supabase-dashboard' },
    cloudApi: 'https://cloud.harborprint.example',
  },
  features: {
    store: true,
    cloudSlicing: true,
    printers: { duet: false, snapmaker: false, homeassistant: false },
  },
  auth: { providers: [{ kind: 'email' }, { kind: 'google', clientId: '1234567890-abc.apps.googleusercontent.com' }] },
  ai: { provider: 'openai-compatible', model: 'llama-4-scout', baseUrl: 'https://llm.harborprint.example/v1', keySource: 'cloud' },
  legal: {
    terms: 'https://harborprint.example/terms',
    privacy: 'https://harborprint.example/privacy',
    sourceUrl: 'https://git.harborprint.example/harbor-slice/tree/{commit}',
    trademarkNotice: 'Harbor Slice is built on SlicerX. SlicerX is a trademark of its owners and is not affiliated with Harbor Print Co.',
    publisher: 'Harbor Print Co.',
    copyright: 'Copyright (C) 2026 Harbor Print Co.',
  },
  links: { docs: 'https://slice.harborprint.example/help', download: 'https://slice.harborprint.example/download' },
})
```

The same example as JSON is `packages/edition-config/fixtures/fork-harbor.json`.

What this gives Harbor:

- The apps say "Harbor Slice" everywhere: title bar, menus, dialogs, the installer's publisher and copyright, file type names, and the MCP server AI clients list (`harborslice`). They use Harbor's logo, app icon and colors, and open `harborslice://` links and links on `slice.harborprint.example`.
- About shows the required credit, "Made possible by SlicerX", in small type, linked to https://slicerx.app/support. The edition check accepts no other wording or link.
- Bug reports go only to Harbor: its own `release.bugReportsUrl` and its own backend. With neither, Report a bug and crash reports are off. A fork never sends people or reports to SlicerX's channels, unless its config sets `bugs.upstream: true` (default false): then each crash report is also copied to SlicerX with the edition id in the title (crashes only, never manual reports, no account token).
- Sign-in offers email and Google. The store and cloud slicing are on; the Feed and phone pairing never appear.
- mimir talks to Harbor's model through Harbor's cloud, which holds the model key, so no customer needs a key of their own.
- The Printers workspace offers Bambu Lab, Klipper, PrusaLink, OctoPrint, Creality and Elegoo printers and Spoolman, and hides the rest.
- About screens and the site footer link to the exact source of each build.

### Check it

```sh
node packages/edition-config/src/cli.ts check harbor.config.ts
```

A mistake names the field and the reason:

```
Invalid edition config:
  features.feed: feed needs store
  legal.sourceUrl: edition builds ship the AGPL-3.0 stock profiles: set legal.sourceUrl so users can get the source (section 13)
```

### Build it

```sh
# web app
pnpm edition:build harbor.config.ts --target web

# desktop app: writes the Tauri overlay (name, window title, publisher, copyright, file types,
# link scheme, identifiers), makes the app icons from brand.logo.appIcon, then builds
pnpm edition:build harbor.config.ts --target desktop

# the phone app and the site read the config from the environment
export SLICERX_CONFIG=$PWD/harbor.config.ts

# phone app
node packages/edition-config/src/cli.ts tauri harbor.config.ts mobile > harbor.tauri-mobile.json
pnpm --filter @slicerx/mobile tauri ios build --config harbor.tauri-mobile.json

# site, with the files that let the apps open universal links
node packages/edition-config/src/cli.ts well-known harbor.config.ts apps/site/public/.well-known
pnpm --filter @slicerx/site build
```

An Expo-based phone app can use `expoConfig(config)` for the name, slug, scheme, bundle ids, associated domains and Android intent filters. Expo loads `app.config.ts` synchronously, so run `node packages/edition-config/src/cli.ts expo harbor.config.ts` and spread the JSON it prints.

### Run the services

Services read resolved JSON, which is the config with every default filled in. The Rust services (the cloud service and `sx-link`) read it through the `sx-edition-config` crate.

```sh
node packages/edition-config/src/cli.ts resolve harbor.config.ts > slicerx.config.json
SLICERX_CONFIG=slicerx.config.json ./cloud-service
```

## Environment overrides

Every loader, in TypeScript and in Rust, applies these on top of the file. They suit values that differ between staging and production.

| Variable | Sets |
| --- | --- |
| `SLICERX_CONFIG` | path of the config file (TypeScript or JSON) |
| `SLICERX_SUPABASE_URL`, `SLICERX_SUPABASE_ANON_KEY` | `backend.supabase` |
| `SLICERX_CLOUD_API_URL` | `backend.cloudApi` |
| `SLICERX_RELAY_URL` | `backend.relay` |
| `SLICERX_LINK_PORT` | `backend.linkPort` |
| `SLICERX_FEATURES` | the enabled features as a comma list (`store,cloudSlicing,pilot`); replaces the file's toggles |
| `SLICERX_AI_PROVIDER`, `SLICERX_AI_MODEL`, `SLICERX_AI_BASE_URL` | `ai` |
| `SLICERX_AUTH_PROVIDERS` | the sign-in providers as a comma list (`email,github,google,apple`); replaces the file's list |
| `SLICERX_AUTH_GITHUB_CLIENT_ID`, `SLICERX_AUTH_GOOGLE_CLIENT_ID`, `SLICERX_AUTH_APPLE_CLIENT_ID`, `SLICERX_AUTH_DISCORD_CLIENT_ID` | each provider's public client id; one alone updates that provider in the file's list |
| `SLICERX_APPLE_TEAM_ID` | `apps.ios.teamId`, for Sign in with Apple and universal links |

`SX_FEATURES` is a build-only switch that decides which feature code is compiled in, for example `SX_FEATURES=` builds with no optional features at all. When it is unset, the configuration decides.

## Rules the checker enforces

- Features need what they depend on: the feed needs the store; the store needs Supabase (or `demoData`, which serves a bundled demo catalog); cloud slicing needs `backend.cloudApi`; phone pairing needs a relay; mimir needs an AI provider, and `keySource: 'cloud'` needs the cloud API.
- Every edition other than SlicerX's own needs `legal.sourceUrl`, because every build ships the AGPL-3.0 stock profiles and printer images (see `REUSE.toml`) and users of your apps and site are entitled to the source. The unbranded reference build links SlicerX's source.
- No secrets. The Supabase anon key and OAuth client ids are public by design; the checker refuses a Supabase service role key, API keys (`sk-...`) and private keys. Secrets go in your server's environment or a secret manager, and model keys in the OS keychain or your cloud.
- Your own name and identity. An edition whose `id` is not `slicerx` cannot use the SlicerX name, the SlicerX logo, the `slicerx://` scheme or `app.slicerx.*` identifiers, and must set `brand.logo.appIcon` so the desktop build does not ship the SlicerX icon.

## Licenses and the name

- SlicerX code, base and edition, is Apache-2.0. You can combine it with code under any license.
- The stock profile data (`packages/profiles`) is AGPL-3.0-or-later. If you ship or host a build that includes it, as the apps do, offer your users its complete source; `legal.sourceUrl` is where the apps link to it.
- SlicerX contains no OrcaSlicer, Bambu Studio or PrusaSlicer code. Their stock profiles are the only data taken from them, and `docs/licensing.md` says how to leave them out. [THIRD-PARTY.md](../THIRD-PARTY.md) lists the third-party libraries, model weights and fonts that ship.
- "SlicerX" and its logo are trademarks. You are free to fork and white-label; ship under your own name and logo and keep the "Made possible by SlicerX" credit. [TRADEMARK.md](../TRADEMARK.md) has the details.
