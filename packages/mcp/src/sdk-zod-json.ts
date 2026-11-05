// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Stands in for the zod-to-json-schema package in the built server. The SDK's server imports it at start (through
// server/zod-json-schema-compat.js), which loaded about forty files on every start, though the SDK only calls it for
// Zod 3 schemas and every SlicerX tool schema is Zod 4. This function has the same name and arguments and loads the
// package the first time it is called. The npm build points the SDK's import here with a module hook
// (src/sdk-defer-hook.ts); the self-contained build swaps the import when it bundles.
import { sdkZodToJsonSchema } from './sdk-zod-json-load'

/** As the SDK calls it: a Zod 3 schema and options, returning a JSON Schema. */
export type ZodToJsonSchema = (schema: unknown, options?: unknown) => unknown

export const zodToJsonSchema = ((...args: Parameters<ZodToJsonSchema>) => sdkZodToJsonSchema()(...args)) as ZodToJsonSchema
