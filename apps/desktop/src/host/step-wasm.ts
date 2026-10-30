// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The app ships one copy of the STEP reader, beside its MCP server (Resources/mcp/step-reader, packed by
// release/prepare-sidecars.mjs). The window's STEP worker fetches the wasm from there over the asset protocol, whose
// scope in tauri.conf.json is this one file; the page's build leaves its own copy out (step-wasm-plugin.ts).
import { convertFileSrc } from '@tauri-apps/api/core'
import { resolveResource } from '@tauri-apps/api/path'

/** The wasm's path inside the app's resources; tauri.conf.json's asset protocol scope is `$RESOURCE/` plus this. */
export const STEP_WASM_RESOURCE = 'mcp/step-reader/occt-import-js.wasm'

/** The asset protocol URL of the bundled wasm. */
export async function stepWasmUrl(resolve: (path: string) => Promise<string> = resolveResource, toUrl: (path: string) => string = convertFileSrc): Promise<string> {
  return toUrl(await resolve(STEP_WASM_RESOURCE))
}
