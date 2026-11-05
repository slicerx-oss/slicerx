// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Loads the SDK's Ajv provider for src/sdk-ajv.ts, which only the server's CLI entries use. The npm build requires it
// from node_modules; the self-contained build replaces this file with a bundled require() (scripts/build.mjs).
import { createRequire } from 'node:module'

/** The SDK's Ajv validator provider (@modelcontextprotocol/sdk/validation/ajv). */
export const sdkAjv = (): typeof import('@modelcontextprotocol/sdk/validation/ajv') =>
  createRequire(import.meta.url)('@modelcontextprotocol/sdk/validation/ajv') as typeof import('@modelcontextprotocol/sdk/validation/ajv')
