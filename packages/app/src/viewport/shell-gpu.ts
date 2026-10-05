// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The GL renderer as the desktop shell sees it. WebKit gives pages a made-up GPU name on Linux, so the shell reads
// the real one and the viewport trusts it over WebGL's. Null where the shell has none (browsers, Windows, macOS).

let reader: (() => Promise<string | null>) | null = null

export function registerShellGpu(read: () => Promise<string | null>): void {
  reader = read
}

export async function shellGpu(): Promise<string | null> {
  if (!reader) return null
  try {
    return await reader()
  } catch {
    return null
  }
}
