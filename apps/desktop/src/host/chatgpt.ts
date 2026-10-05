// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Sign in with ChatGPT through the Tauri commands in src-tauri/src/chatgpt.rs.
import type { ChatGptAccount, ChatGptHost } from '@slicerx/app'
import { invoke } from '@tauri-apps/api/core'

export function createTauriChatGpt(): ChatGptHost {
  return {
    connect: () => invoke<ChatGptAccount>('chatgpt_connect'),
    account: () => invoke<ChatGptAccount | null>('chatgpt_account'),
    disconnect: () => invoke<void>('chatgpt_disconnect'),
    setApiKey: (provider, key) => invoke<void>('chatgpt_set_api_key', { provider, key }),
    hasApiKey: (provider) => invoke<boolean>('chatgpt_has_api_key', { provider }),
    clearApiKey: (provider) => invoke<void>('chatgpt_clear_api_key', { provider }),
  }
}
