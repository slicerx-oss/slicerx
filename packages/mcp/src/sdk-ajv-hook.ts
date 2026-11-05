// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Points the SDK's import of its Ajv provider at src/sdk-ajv.ts (built to dist/sdk-ajv.js), so the npm build loads
// Ajv the first time a schema is checked instead of at every start. Only that one import of the SDK's own server and
// client modules is redirected; everything else resolves as usual. Best effort, like the compile cache: without
// module.registerHooks the SDK loads its provider as before.
import module from 'node:module'

/** The SDK modules whose provider import is redirected, and the import itself, as the SDK writes it. */
const SDK_IMPORTER = /\/@modelcontextprotocol\/sdk\/dist\/esm\/(?:server|client)\/index\.js$/
const SDK_PROVIDER = '../validation/ajv-provider.js'

type Resolve = Parameters<typeof module.registerHooks>[0]['resolve']

/** The resolve hook: the SDK's provider import becomes `target`, a file URL. */
export function sdkAjvResolve(target: string): NonNullable<Resolve> {
  return (specifier, context, next) =>
    specifier === SDK_PROVIDER && context.parentURL !== undefined && SDK_IMPORTER.test(context.parentURL)
      ? { url: target, format: 'module', shortCircuit: true }
      : next(specifier, context)
}

/** Registers the hook for the modules loaded after this call. */
export function deferSdkAjv(target: string): void {
  try {
    if (typeof module.registerHooks !== 'function') return
    module.registerHooks({ resolve: sdkAjvResolve(target) })
  } catch {
    // the SDK's own provider loads as before
  }
}
