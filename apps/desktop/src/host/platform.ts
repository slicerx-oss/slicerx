// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What the page cannot read about this computer itself (src-tauri/src/platform.rs): the CPU the shell runs on.
import type { ShellArch } from '@slicerx/app'
import { invoke } from '@tauri-apps/api/core'

export const shellArch: ShellArch = () => invoke<string>('shell_arch')
