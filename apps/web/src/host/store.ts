// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The store client loads on first use, so the Supabase client never weighs on
// launch. Every StoreClient method is async except the on*Change subscriptions, so one
// forwarding proxy covers the whole interface as it grows.
import type { StoreClient } from '@slicerx/contracts'
import type { EditionConfig } from '@slicerx/edition-config'

type AnyFn = (...args: unknown[]) => unknown

/** Where sign-in links return and how provider pages open. The web page returns to its own /auth/callback. */
export interface StoreAuth {
  redirectUrl: () => string
  openExternal?: (url: string) => Promise<void>
  /**
   * With no backend, whether the demo catalog starts signed in as its demo member. The web demo does, so the Vault's
   * signed-in pages show; the desktop app starts signed out, as a fresh install would.
   */
  demoSignedIn?: boolean
}

/** The web page's sign-in callback, under the path the build is served from. */
export function webAuth(): StoreAuth {
  return { redirectUrl: () => `${location.origin}${import.meta.env.BASE_URL}auth/callback` }
}

type StoreModule = Pick<typeof import('@slicerx/store'), 'createStore'>

/**
 * The edition's Supabase backend, or the bundled demo catalog when it has none (or asks for demo data). The desktop
 * app passes its deep link here: its page origin (tauri://localhost) is not an address a sign-in link can return to.
 */
export function lazyStore(edition: EditionConfig, auth: StoreAuth = webAuth(), loadModule: () => Promise<StoreModule> = () => import('@slicerx/store')): StoreClient {
  let client: Promise<StoreClient> | null = null
  const sb = edition.features.demoData ? null : edition.backend.supabase
  const load = () =>
    (client ??= loadModule().then((m) =>
      sb ? m.createStore({ url: sb.url, anonKey: sb.anonKey, auth: { redirectUrl: auth.redirectUrl, ...(auth.openExternal ? { openExternal: auth.openExternal } : {}) } }) : m.createStore({ offline: true, ...(auth.demoSignedIn === false ? { signedInAs: null } : {}) }),
    ))
  const method = (c: StoreClient, key: PropertyKey): AnyFn => {
    const fn: unknown = Reflect.get(c, key)
    if (typeof fn !== 'function') throw new Error(`The store has no ${String(key)}`)
    return (fn as AnyFn).bind(c)
  }
  const proxy = new Proxy(
    {},
    {
      get(_target, key) {
        // Not a thenable: awaiting the host must not call into the store.
        if (key === 'then') return undefined
        // Subscriptions (onSessionChange, onTokenChange) return their unsubscribe at once.
        if (typeof key === 'string' && /^on[A-Z]\w*Change$/.test(key)) {
          return (cb: (v: unknown) => void) => {
            let off: (() => void) | null = null
            let live = true
            void load().then((c) => {
              if (live) off = method(c, key)(cb) as () => void
            })
            return () => {
              live = false
              off?.()
            }
          }
        }
        return async (...args: unknown[]) => method(await load(), key)(...args)
      },
    },
  )
  return proxy as StoreClient
}
