// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The desktop page's build leaves the STEP reader's wasm out. The app ships one copy, beside its MCP server
// (Resources/mcp/step-reader), and the window's STEP worker fetches it from there (src/host/step-wasm.ts). Vite copies
// a file named in new URL('<file>', import.meta.url) into the build; the reader's loader and its Emscripten glue each
// name the wasm that way, so both references are replaced before Vite sees them. Nothing else changes: the glue is
// still bundled, and the web build, which does not use this plugin, keeps its copy.
import type { Plugin } from 'vite'

/** `new URL('./occt-import-js.wasm', import.meta.url)` and the glue's `new URL("occt-import-js.wasm",import.meta.url)`. */
export const STEP_WASM_URL = /new URL\(\s*(['"])(?:\.\/)?occt-import-js\.wasm\1\s*,\s*import\.meta\.url\s*\)/g

/** What stands in for it: a URL nothing can fetch, so a read with no wasm named fails plainly instead of quietly. */
export const NO_BUNDLED_WASM = "new URL('about:blank#step-reader-wasm-is-in-the-app-resources')"

/** Replaces the wasm URLs in a source file of the reader; null when the file names none. */
export function dropStepWasm(code: string): string | null {
  STEP_WASM_URL.lastIndex = 0
  if (!STEP_WASM_URL.test(code)) return null
  return code.replace(STEP_WASM_URL, NO_BUNDLED_WASM)
}

export function stepWasmFromResources(): Plugin {
  return {
    name: 'sx-step-wasm-from-resources',
    enforce: 'pre',
    apply: 'build',
    transform(code, id) {
      if (!/[\\/]step-reader[\\/](?:src|dist)[\\/](?:load\.ts|occt-import-js\.mjs|index\.js|chunk-[^\\/]+\.js)(?:\?|$)/.test(id)) return null
      const out = dropStepWasm(code)
      return out === null ? null : { code: out, map: null }
    },
  }
}
