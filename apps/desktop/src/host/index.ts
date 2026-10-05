// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The desktop Host: native slicing and native file dialogs through Tauri
// commands, and the rest shared with the browser build until the Rust
// connectors and approval broker are wired in (README). The model transport is native:
// tokens stay in Rust (src-tauri/src/llm.rs).
import type { Host } from '@slicerx/contracts'
import { createWebHost } from '@slicerx/web/host'
import { createTauriFiles } from './files'
import { createTauriLlm } from './llm'
import { createTauriSlicer } from './slicer'
import { createTauriThemes } from './themes'

export async function createDesktopHost(): Promise<Host> {
  const host = await createWebHost({
    kind: 'desktop',
    slicer: createTauriSlicer(),
    files: createTauriFiles(),
    themes: createTauriThemes(),
    nativeSlicing: true,
    threads: navigator.hardwareConcurrency || 8,
    llm: createTauriLlm(),
  })
  // Keys and the ChatGPT connection live in the system keychain behind Rust, so the app uses
  // this host's transport instead of the browser key store.
  host.capabilities.secureStorage = true
  return host
}
