// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The store client loads on first use, so the Supabase client never weighs on
// launch. Every StoreClient method is async except the on*Change subscriptions, so one
// forwarding proxy covers the whole interface as it grows.
import type { StoreClient } from '@slicerx/contracts'
import type { EditionConfig } from '@slicerx/edition-config'

type AnyFn = (...args: unknown[]) => unknown

/** The edition's Supabase backend, or the bundled demo catalog when it has none (or asks for demo data). */
export function lazyStore(edition: EditionConfig): StoreClient {
  let client: Promise<StoreClient> | null = null
  const sb = edition.features.demoData ? null : edition.backend.supabase
  const load = () =>
    (client ??= import('@slicerx/store').then((m) =>
      sb ? m.createStore({ url: sb.url, anonKey: sb.anonKey, auth: { redirectUrl: () => `${location.origin}${import.meta.env.BASE_URL}auth/callback` } }) : m.createStore({ offline: true }),
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
