#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The built entry (dist/cli.js, slicerx-mcp.mjs): turns Node's compile cache on, then loads the server (src/cli.ts),
// so the server's modules are compiled from the cache. It stays a small file of its own because a module's imports
// are all loaded before its first line runs. The build sets SX_MCP_MAIN to the server's file beside this one; from
// source, through tsx, it loads cli.ts. The npm build also sets SX_MCP_DEFER to its stand-ins for SDK imports a start
// does not need (src/sdk-defer-hook.ts), and those imports are pointed there, so they load on first use.
import { saveCompileCache, startCompileCache } from './compile-cache'
import { deferSdkImports, type SdkImport } from './sdk-defer-hook'

declare const SX_MCP_MAIN: string | undefined
declare const SX_MCP_DEFER: Record<SdkImport, string> | undefined

startCompileCache()
if (typeof SX_MCP_DEFER === 'object') {
  deferSdkImports(Object.fromEntries(Object.entries(SX_MCP_DEFER).map(([k, file]) => [k, new URL(file, import.meta.url).href])))
}
await import(new URL(typeof SX_MCP_MAIN === 'string' ? SX_MCP_MAIN : './cli.ts', import.meta.url).href)
// Saved a moment after the start, off the path to the first answer; a run that ends sooner is saved as it exits.
setTimeout(saveCompileCache, 2000).unref()
