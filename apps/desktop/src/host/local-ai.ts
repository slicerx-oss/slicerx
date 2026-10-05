// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Set up local AI through the shell: src-tauri/src/localai.rs reads the hardware and the local
// servers' model lists, and pulls and checks go through the model transport (llm.rs), which only
// reaches 127.0.0.1 for a local model. The webview itself makes no request to a local server.
import type { Hardware, LocalAiHost } from '@slicerx/app'
import { invoke } from '@tauri-apps/api/core'
import { createTauriLlm } from './llm'

export function createTauriLocalAi(): LocalAiHost {
  const llm = createTauriLlm()
  return {
    hardware: async () => ({ ...(await invoke<Omit<Hardware, 'source'>>('local_ai_hardware')), source: 'desktop' }),
    net: {
      get: (url) => invoke<string | null>('local_ai_get', { url }),
      post: (url, body, signal) => llm.stream({ provider: 'openai-compatible', url, method: 'POST', headers: { 'content-type': 'application/json' }, body }, signal),
    },
  }
}
