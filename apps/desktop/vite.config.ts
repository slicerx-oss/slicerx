// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { resolve } from 'node:path'
import { sharedConfig } from '@slicerx/web/vite'
import { defineConfig } from 'vite'
import { stepWasmFromResources } from './step-wasm-plugin'

// Tauri serves dist/ from its own origin; the dev server must keep one fixed port.
export default defineConfig(async ({ command }) => {
  const shared = await sharedConfig(import.meta.dirname, 5174, resolve(import.meta.dirname, '../../editions/slicerx/edition.config.ts'), './', command)
  // The agent bridge's page side (docs/agent-bridge.md): only a dev or test build made with SLICERX_AGENT_BRIDGE=1 has it.
  // Release builds never set it (apps/desktop/release/check-agent-bridge.mjs); with it off the bridge code is dropped.
  const define = { ...shared.define, __SX_AGENT_BRIDGE__: JSON.stringify(process.env['SLICERX_AGENT_BRIDGE'] === '1') }
  // The STEP reader's wasm ships once, beside the MCP server, and the worker fetches it from there (src/host/step-wasm.ts).
  const plugins = [...(shared.plugins ?? []), stepWasmFromResources()]
  const worker = { ...shared.worker, plugins: () => [stepWasmFromResources()] }
  return { ...shared, define, plugins, worker, server: { ...shared.server, strictPort: true }, clearScreen: false }
})
