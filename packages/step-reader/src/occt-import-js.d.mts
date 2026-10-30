// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Types for the Emscripten module built by ../build.sh. Only what this package calls.

export interface OcctModuleOptions {
  /** Where to fetch occt-import-js.wasm from. */
  locateFile?: (file: string, prefix: string) => string
  /** Instantiates the wasm instead of the module: call `done` with the instance, return {} at once. */
  instantiateWasm?: (imports: WebAssembly.Imports, done: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void) => object
  print?: (s: string) => void
  printErr?: (s: string) => void
}

declare function occtimportjs(options?: OcctModuleOptions): Promise<unknown>
export default occtimportjs
