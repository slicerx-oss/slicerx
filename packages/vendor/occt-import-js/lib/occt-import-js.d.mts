// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Types for the Emscripten module built by ../build.sh. Only what SlicerX calls.

export interface OcctModuleOptions {
  /** Where to fetch occt-import-js.wasm from. */
  locateFile?: (file: string, prefix: string) => string
}

declare function occtimportjs(options?: OcctModuleOptions): Promise<unknown>
export default occtimportjs
