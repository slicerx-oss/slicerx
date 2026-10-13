// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// mimir cloud through the Tauri commands in src-tauri/src/llm.rs. The install token stays in the keychain; only
// the quota and counts come back.
import type { MimirCloudHost, MimirQuota } from '@slicerx/app'
import { invoke } from '@tauri-apps/api/core'

export function createTauriMimirCloud(): MimirCloudHost {
  return {
    quota: () => invoke<MimirQuota>('mimir_cloud_quota'),
    forget: () => invoke<number>('mimir_cloud_forget'),
    register: () => invoke<void>('mimir_cloud_register'),
  }
}
