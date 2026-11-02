#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The built entry (dist/cli.js, slicerx-mcp.mjs): turns Node's compile cache on, then loads the server (src/cli.ts),
// so the server's modules are compiled from the cache. It stays a small file of its own because a module's imports
// are all loaded before its first line runs. The build sets SX_MCP_MAIN to the server's file beside this one; from
// source, through tsx, it loads cli.ts.
import { saveCompileCache, startCompileCache } from './compile-cache'

declare const SX_MCP_MAIN: string | undefined

startCompileCache()
await import(new URL(typeof SX_MCP_MAIN === 'string' ? SX_MCP_MAIN : './cli.ts', import.meta.url).href)
// Saved a moment after the start, off the path to the first answer; a run that ends sooner is saved as it exits.
setTimeout(saveCompileCache, 2000).unref()
