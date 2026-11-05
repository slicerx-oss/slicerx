// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Loads zod-to-json-schema for src/sdk-zod-json.ts, which only the server's CLI entries use. It is a dependency of the
// SDK, not of this package, so the npm build requires it from beside the SDK; the self-contained build replaces this
// file with a bundled require() (scripts/build.mjs).
import { createRequire } from 'node:module'
import type { ZodToJsonSchema } from './sdk-zod-json'

/** zod-to-json-schema's converter, resolved the way the SDK resolves it. */
export const sdkZodToJsonSchema = (): ZodToJsonSchema => {
  const sdk = createRequire(import.meta.url).resolve('@modelcontextprotocol/sdk/server/mcp.js')
  return (createRequire(sdk)('zod-to-json-schema') as { zodToJsonSchema: ZodToJsonSchema }).zodToJsonSchema
}
