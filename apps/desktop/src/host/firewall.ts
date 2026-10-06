// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Whether Windows Firewall lets the app hear printers, and Windows' own page to allow it (src-tauri/src/firewall.rs).
// The shell reads the rules and opens the page; it never adds a rule.
import type { FirewallHost } from '@slicerx/contracts'
import { invoke } from '@tauri-apps/api/core'

export function createTauriFirewall(): FirewallHost {
  return {
    inbound: () => invoke<'allowed' | 'blocked' | 'none' | 'unsupported'>('firewall_inbound'),
    openSettings: () => invoke<void>('firewall_open_settings'),
  }
}
