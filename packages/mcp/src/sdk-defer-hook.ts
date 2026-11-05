// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Points two of the SDK's start-time imports at stand-ins that load the real module on first use, so the npm build
// does not load them at every start: the Ajv provider its server and client import (src/sdk-ajv.ts, built to
// dist/sdk-ajv.js) and zod-to-json-schema, which its server imports for Zod 3 schemas (src/sdk-zod-json.ts, built
// to dist/sdk-zod-json.js). Only those imports from those SDK modules are redirected; everything else resolves as
// usual. Best effort, like the compile cache: without module.registerHooks the SDK loads them as before.
import module from 'node:module'

/** Each redirected import: the SDK modules that make it, and the specifier as the SDK writes it. */
export const SDK_IMPORTS = {
  ajv: { importer: /\/@modelcontextprotocol\/sdk\/dist\/esm\/(?:server|client)\/index\.js$/, specifier: '../validation/ajv-provider.js' },
  zodJson: { importer: /\/@modelcontextprotocol\/sdk\/dist\/esm\/server\/zod-json-schema-compat\.js$/, specifier: 'zod-to-json-schema' },
} as const

export type SdkImport = keyof typeof SDK_IMPORTS

type Resolve = Parameters<typeof module.registerHooks>[0]['resolve']

/** The resolve hook: each listed SDK import becomes its target, a file URL. */
export function sdkDeferResolve(targets: Partial<Record<SdkImport, string>>): NonNullable<Resolve> {
  const redirects = (Object.keys(targets) as SdkImport[]).map((k) => ({ ...SDK_IMPORTS[k], url: targets[k]! }))
  return (specifier, context, next) => {
    const parent = context.parentURL
    const hit = parent === undefined ? undefined : redirects.find((r) => r.specifier === specifier && r.importer.test(parent))
    return hit ? { url: hit.url, format: 'module', shortCircuit: true } : next(specifier, context)
  }
}

/** Registers the hook for the modules loaded after this call. */
export function deferSdkImports(targets: Partial<Record<SdkImport, string>>): void {
  try {
    if (typeof module.registerHooks !== 'function') return
    module.registerHooks({ resolve: sdkDeferResolve(targets) })
  } catch {
    // the SDK loads its own modules as before
  }
}
