// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Sign-in from the desktop app: links and provider pages open in the system browser, and they come back as the
// edition's deep link (<scheme>://auth/callback?code=...), which the shell holds until the page takes it.
import type { AuthHost } from '@slicerx/contracts'
import type { EditionConfig } from '@slicerx/edition-config'

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>
type Listen = (event: string, cb: () => void) => Promise<() => void>

export interface ShellBridge {
  invoke: Invoke
  listen: Listen
}

async function tauriBridge(): Promise<ShellBridge> {
  const [{ invoke }, { listen }] = await Promise.all([import('@tauri-apps/api/core'), import('@tauri-apps/api/event')])
  return { invoke, listen: (event, cb) => listen(event, () => cb()) }
}

/** The deep link magic links and providers return to, such as `slicerx://auth/callback`. */
export function desktopRedirectUrl(config: EditionConfig): string {
  return `${config.apps.deepLinkScheme}://auth/callback`
}

export function createDesktopAuth(config: EditionConfig, bridge: () => Promise<ShellBridge> = tauriBridge): AuthHost & { demoSignedIn: false } {
  return {
    // A build with no backend serves the demo catalog; the app starts signed out of it, as a fresh install does.
    demoSignedIn: false,
    redirectUrl: () => desktopRedirectUrl(config),
    openExternal: async (url) => {
      const { invoke } = await bridge()
      await invoke('open_external', { url })
    },
    // Links that opened the app arrive before anyone listens, so the page takes what is waiting, then each new one.
    onDeepLink(cb) {
      let live = true
      let off: (() => void) | null = null
      void bridge().then(async ({ invoke, listen }) => {
        const take = () =>
          void invoke<string[]>('auth_callback_take').then(
            (urls) => urls.forEach((u) => live && cb(u)),
            () => undefined,
          )
        const stop = await listen('sx-auth-callback', take)
        if (live) off = stop
        else stop()
        take()
      })
      return () => {
        live = false
        off?.()
      }
    },
  }
}
