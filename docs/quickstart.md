# Kickstart your slicer app

Two ways to get a slicer of your own on top of SlicerX. Pick by how much of the app you want.

| You want | Do this | License you take on |
| --- | --- | --- |
| A slicing feature inside your own product | Embed the base kit: the npm package, the `sx` CLI, the Rust crate, the C ABI or the MCP server. See [embedding.md](embedding.md). | Apache-2.0, open or closed product, with the "Made possible by SlicerX" credit |
| A whole slicer app with your name, colors and printers | Fork the repository and write one edition config, as below. | Apache-2.0, but the app ships the AGPL stock profiles, so you publish your source |

The rest of this page is the fork path. It takes about ten minutes plus build time.

## 1. Fork and install

You need Node 24 or newer, pnpm 10 and Rust 1.98.1 ([install.md](install.md#requirements)).

```sh
git clone https://github.com/slicerx-oss/slicerx.git tinyslice && cd tinyslice
pnpm install
```

## 2. Write the edition config

Create `tinyslice.config.ts` in the repository root. This example is complete and passes the checker:

```ts
import { defineEditionConfig } from '@slicerx/edition-config'

export default defineEditionConfig({
  id: 'tinyslice',
  brand: {
    name: 'TinySlice',
    shortName: 'Tiny',
    tagline: 'A slicer for the Tiny Makers club',
    theme: { base: 'subban', tokens: { colors: { purple: '#4fb3bf' } } },
  },
  apps: {
    web: { origin: 'https://slice.tinymakers.example' },
    desktop: { identifier: 'example.tinymakers.slice', productName: 'TinySlice' },
  },
  features: { pilot: false, printers: { duet: false } },
  ai: { provider: 'none' },
  funding: { buyMeACoffee: 'https://buymeacoffee.com/tinymakers' },
  routes: { studio: '/app' },
  firstRun: { defaultLook: 'bambu-studio' },
})
```

What each part does:

- `brand`: the name, tagline, logo files and theme. `subban` is the built-in theme; `tokens` overrides its colors and fonts.
- `features`: switches for the store, feed, creators, cloud slicing, mimir and each printer family. Anything you leave out takes the neutral default. mimir needs an AI provider, which is why the example turns it off along with `ai.provider: 'none'`.
- `funding`: links shown in the app for supporting your project (`payWhatYouWant`, `buyMeACoffee`, `githubSponsors`). Unset links are hidden. Nothing is sold in the app.
- `routes`: public paths. Here the web app moves from `/studio` to `/app`.
- `firstRun.defaultLook`: the look and feel preset preselected on first run (`slicerx`, `bambu-studio`, `prusaslicer` or `orcaslicer`). The first-run setup offers the choice and preselects this one.
- `id`: an edition whose id is not `slicerx` cannot use the SlicerX name, logo or `app.slicerx.*` identifiers.

Every section and its rules are in [integrating.md](integrating.md). The JSON Schema at `packages/edition-config/schema/edition-config.schema.json` gives your editor completion.

Check it:

```sh
node packages/edition-config/src/cli.ts check tinyslice.config.ts
```

A mistake names the field and the reason. If you turn on the store, cloud slicing or any other edition feature, the checker also asks for `legal.sourceUrl`, so your users can get the source of your builds.

## 3. Build

```sh
export SLICERX_CONFIG=$PWD/tinyslice.config.ts

# Web app, output in apps/web/dist
pnpm --filter @slicerx/web build

# Desktop app: the Tauri identifiers and deep links come from the config
pnpm --filter @slicerx/desktop build:app

# MCP server for AI tools
pnpm --filter @slicerx/mcp build
cargo build -p sx-cli -p sx-geom --release
```

The web build was checked with the example above. The desktop build runs `tauri build` with the config's settings and has been tried on macOS only. Build the phone app and the site the same way: [integrating.md](integrating.md#build-it).

Run the web build locally with `pnpm --filter @slicerx/web preview`, or serve `apps/web/dist` from any static host.

## 4. Add your own tools to the MCP server

The MCP server takes extra tools from your code, and they go through the same permission policy as the built-in ones. Start it in-process:

```ts
import { createContext, createSlicerxServer } from '@slicerx/mcp'
import { defineTool } from '@slicerx/pilot'
import { z } from 'zod'

const clubInfo = defineTool({
  name: 'club.info',
  version: '1.0.0',
  source: 'command',
  permission: 'read',
  description: 'Opening hours and printer rules of the Tiny Makers club.',
  input: z.object({}),
  async run() {
    return { summary: 'Club rules', output: { hours: 'Sat 10:00 to 16:00', rule: 'Clean the bed after every print' } }
  },
})

const ctx = await createContext({ engine: 'auto', extraTools: [clubInfo] })
const server = createSlicerxServer(ctx)
```

Connect `server` to a stdio or HTTP transport from the MCP SDK. The tool appears to clients as `slicerx_club_info`. A tool with any permission other than `read` is asked about, allowed or refused according to the user's policy ([packages/mcp/README.md](../packages/mcp/README.md#permissions)).

## 5. Publish under your own name

- Ship under your name and logo. You may say the app is built on SlicerX.
- Publish the source of every build that includes edition code, and set `legal.sourceUrl` to it.
- Keep secrets out of the config. It holds public values only, and the checker refuses API keys and private keys.
