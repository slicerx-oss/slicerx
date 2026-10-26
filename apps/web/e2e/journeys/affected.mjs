// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Which journeys cover which source paths, for scripts/test-affected.mjs. A changed file takes the rows whose prefix is
// the longest one that matches it, so a narrow row (prepare/sketch-) wins over a wide one (prepare/). A journey name
// is a file in this folder without .spec.ts. A file no row matches but CI's browser paths include gets the @smoke
// tests; one under a `smoke` row gets them too, since it reaches every screen. Update a row when a journey moves or
// a source folder is renamed: the script names any journey here that has no file.

export const smoke = [
  'apps/web/src/',
  'apps/web/index.html',
  'apps/web/vite.config.ts',
  'apps/web/vite.shared.ts',
  'packages/app/src/app.tsx',
  'packages/app/src/host.tsx',
  'packages/app/src/index.ts',
  'packages/app/src/features.tsx',
  'packages/app/src/state/',
  'packages/app/src/lib/',
]

const cad = ['cad-ops', 'cad-sketch', 'phone-cad']
const model = ['model-viewport', 'phone-model']
const shell = ['shell', 'phone-shell', 'phone-responsive']
const settings = ['sidebar', 'slicing-preview', 'phone-shell']
const slicing = ['slicing-preview', 'tower', 'phone-slice']
const bridge = ['printer-bridge', 'phone-slice']
const session = ['boot-session', 'phone-session']

export const journeys = [
  // modeling: the CAD tools, the sketch, the design workspace and the geometry engine as the browser loads it
  { paths: ['packages/app/src/cad/', 'packages/app/src/geom/', 'packages/app/src/workspaces/design/', 'packages/cad-history/', 'packages/geom/wasm/', 'packages/brep/'], journeys: cad },
  { paths: ['packages/app/src/workspaces/prepare/sketch-'], journeys: ['cad-sketch', 'phone-cad'] },
  // the 3D view and picking
  { paths: ['packages/app/src/viewport/', 'packages/ui/viewport/', 'packages/app/src/plate/pick-filter.ts', 'packages/app/src/plate/select-other-pick.ts', 'packages/app/src/plate/sub-pick.ts'], journeys: model },
  // plates, objects and files
  { paths: ['packages/app/src/plate/'], journeys: ['plates', 'sidebar', 'phone-model'] },
  { paths: ['packages/app/src/plate/tower.ts'], journeys: ['tower', 'tower-plates'] },
  { paths: ['packages/app/src/plate/plates.ts'], journeys: ['plates', 'sidebar', 'phone-model', 'tower-plates'] },
  { paths: ['packages/app/src/project/', 'packages/app/src/export/', 'packages/sx3mf/', 'packages/threemf/'], journeys: ['project', 'file-open', 'tower-plates'] },
  { paths: ['packages/app/src/state/open-', 'packages/app/src/state/import-', 'packages/app/src/state/multi-body.ts'], journeys: ['file-open', 'tower-plates'] },
  // a project's prime tower spot per plate, from the file to the slice request
  { paths: ['packages/app/src/filament/project-kept.ts', 'packages/app/src/filament/slot-config.ts'], journeys: [...settings, 'tower-plates'] },
  { paths: ['packages/app/src/state/slice-plate.ts'], journeys: ['slicing-preview', 'tower', 'tower-plates'] },
  // slicing and the result
  { paths: ['packages/app/src/workspaces/preview/', 'packages/app/src/workspaces/slice-progress.tsx', 'packages/app/src/state/auto-slice', 'packages/core/web/', 'packages/core/wasm/'], journeys: slicing },
  { paths: ['packages/app/src/workspaces/prepare/', 'packages/app/src/presets/', 'packages/app/src/filament/', 'packages/app/src/adapters/', 'packages/app/src/calibration/', 'packages/settings/', 'packages/profiles/'], journeys: settings },
  // printers, the bridge and the phone's live view
  { paths: ['packages/app/src/send/', 'packages/app/src/link/', 'packages/app/src/connected-apps/', 'packages/app/src/camera/', 'packages/app/src/queue/', 'packages/app/src/inventory/', 'packages/app/src/features/fleet/', 'packages/connect/link-client/', 'packages/connect/mock-printers/', 'packages/connect/link/'], journeys: bridge },
  // clients reaching the open app
  { paths: ['packages/app/src/app-link/', 'packages/app/src/agent-bridge/', 'packages/app-bridge/', 'packages/mcp/src/app'], journeys: ['links'] },
  // mimir
  { paths: ['packages/app/src/pilot-connect/', 'packages/app/src/workspaces/mimir/', 'packages/app/src/features/pilot/', 'packages/pilot/src/'], journeys: ['mimir', 'mimir-print-run', 'phone-session'] },
  // the print run from the chat: the guard and its send ledger
  { paths: ['packages/app/src/plate/guard.ts', 'packages/app/src/plate/send-ledger.ts'], journeys: ['plates', 'sidebar', 'phone-model', 'mimir-print-run'] },
  // the start, first-run setup, updates and the Vault
  { paths: ['packages/app/src/first-run/', 'packages/app/src/updates/', 'packages/app/src/bugs/', 'packages/app/src/edition.tsx', 'packages/app/src/lib/chunk-reload.ts'], journeys: session },
  { paths: ['packages/app/src/workspaces/library/', 'packages/app/src/features/store/', 'packages/store/src/'], journeys: ['vault', 'phone-session'] },
  // the frame: top bar, panes, commands, theme and the shared UI kit
  { paths: ['packages/app/src/shell/', 'packages/app/src/commands/', 'packages/app/src/controls/', 'packages/app/src/theme/', 'packages/app/src/styles/', 'packages/ui/src/', 'packages/ui/themes/', 'packages/ui/icons/', 'packages/brand-icons/src/'], journeys: shell },
]
