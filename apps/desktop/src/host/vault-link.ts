// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Vault links from the website (<scheme>://vault/<slug>, Open in SlicerX on a design's page). The shell holds each
// slug until the page takes it, so a link that started the app is opened once the page is up.
import { tauriBridge, type ShellBridge } from './auth'

/** Calls `cb` with each design slug a Vault link names: the ones already waiting, then each new one. */
export function onVaultLink(cb: (slug: string) => void, bridge: () => Promise<ShellBridge> = tauriBridge): () => void {
  let live = true
  let off: (() => void) | null = null
  void bridge().then(async ({ invoke, listen }) => {
    const take = () =>
      void invoke<string[]>('vault_link_take').then(
        (slugs) => slugs.forEach((s) => live && cb(s)),
        () => undefined,
      )
    const stop = await listen('sx-open-vault', take)
    if (live) off = stop
    else stop()
    take()
  })
  return () => {
    live = false
    off?.()
  }
}
