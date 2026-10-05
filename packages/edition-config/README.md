# @slicerx/edition-config

License: Apache-2.0.

One typed configuration for every edition surface: the web and desktop apps, the phone app, the site, the cloud service and `sx-link`. It holds backend endpoints, branding, feature toggles, auth providers, the AI provider and model, and legal links. Only public values go in it; the schema refuses secrets. The public guide is `docs/integrating.md`.

## Public API

```ts
import { defineEditionConfig, viteDefines, tauriConfig, expoConfig, wellKnown, editionFromBuild } from '@slicerx/edition-config'
import { loadEditionConfig } from '@slicerx/edition-config/node'
```

- `defineEditionConfig(layer, { extends })`: merge a layer over the neutral defaults (or another config) and validate. Use it in a config file's default export.
- `loadEditionConfig({ file, env })` (Node): read a TypeScript or JSON config (`SLICERX_CONFIG`, else `slicerx.config.json`), apply `SLICERX_*` overrides, validate.
- `viteDefines(config)`: `__SX_EDITION__` plus the `__SX_FEATURE_*__` switches. `SX_FEATURES` still overrides the switches.
- `editionFromBuild()`: the config inside a running web, desktop or phone build.
- `tauriConfig(config, 'desktop' | 'mobile')`, `expoConfig(config)`, `wellKnown(config)`: identifiers, deep links and universal link files. The desktop overlay also sets the window title, publisher, copyright, description, file type names, icons and the shell's link permissions, so nothing of SlicerX's is left in a white-label build.
- `editionLinks`, `attribution`, `mcpServerId`, `logoImage`, `isFork`, `reportsUpload`: what an edition shows in place of SlicerX's pages, credit ("Made possible by SlicerX", fixed), MCP server name and logo, and where its bug reports may go.
- CLI: `node src/cli.ts resolve|check|schema|tauri|expo|well-known [file] [target]`. `expo` prints `expoConfig(config)` as JSON for synchronous `app.config.ts` files.

Rust services use `rust/` (crate `sx-edition-config`), which reads the JSON that `resolve` writes and applies the same environment overrides and rules. `schema/edition-config.schema.json` is the JSON Schema for editors and other languages (`pnpm --filter @slicerx/edition-config schema`).

## Files

- `src/schema.ts`: the zod schema and the rules (feature dependencies, secrets, trademark).
- `src/defaults.ts`: neutral defaults with no SlicerX branding.
- `fixtures/`: the worked example fork (`fork-harbor.json`), the white-label test edition (`acme/`, with the desktop overlay its tests pin) and resolved JSON that the TypeScript and Rust tests share. Regenerate the resolved files with the CLI after a schema change.
- SlicerX's own values: `editions/slicerx/edition.config.ts` Apache-2.0.

## State

Schema, loaders, build helpers, CLI and Rust crate written. `release.stage` marks pre-alpha builds (crashReportsRequired) and `release.bugReportsUrl` names where bugs go. `bugs.upstream` (default false) also copies crash reports to SlicerX, tagged with the edition id.
