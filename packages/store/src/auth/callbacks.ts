// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Session persistence and callback helpers for the web and Tauri builds.
//
// Web: PKCE redirect to <origin>/auth/callback; the session persists in
// localStorage (the Supabase default). The route calls
// store.completeSignIn(location.href), then replaces the URL.
//
// Desktop and phone: PKCE with the <scheme>://auth/callback deep link, where
// the scheme is the edition's apps.deepLinkScheme. The provider page
// opens in the system browser (AuthHost.openExternal); AuthHost.onDeepLink
// hands the URL to store.completeSignIn. The session (with its refresh token)
// persists through an AuthStorage the desktop host backs with the OS keychain.

/** Async key-value storage in the shape supabase-js accepts. */
export interface AuthStorage {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
  removeItem(key: string): Promise<void>
}

export const WEB_CALLBACK_PATH = '/auth/callback'

/** The deep link an app registers for auth callbacks, such as `myslicer://auth/callback`. */
export function deepLinkCallbackUrl(scheme: string): string {
  return `${scheme}://auth/callback`
}

/**
 * True when a URL is an auth callback carrying a PKCE code or an auth error:
 * a web /auth/callback URL, or the deep link for the given scheme.
 */
export function isAuthCallback(url: string, scheme?: string): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  const ours =
    (scheme !== undefined && u.protocol === `${scheme}:` && `${u.host}${u.pathname}` === 'auth/callback') ||
    ((u.protocol === 'http:' || u.protocol === 'https:') && u.pathname === WEB_CALLBACK_PATH)
  return ours && (u.searchParams.has('code') || u.searchParams.has('error'))
}

/**
 * AuthStorage over the browser's localStorage (or any Storage), for the web
 * build. Desktop and phone hosts pass a keychain-backed AuthStorage instead.
 */
export function webAuthStorage(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>): AuthStorage {
  return {
    getItem: async (k) => storage.getItem(k),
    setItem: async (k, v) => storage.setItem(k, v),
    removeItem: async (k) => storage.removeItem(k),
  }
}

/** In-memory AuthStorage, for tests and for sessions that must not persist. */
export function memoryAuthStorage(): AuthStorage {
  const m = new Map<string, string>()
  return {
    getItem: async (k) => m.get(k) ?? null,
    setItem: async (k, v) => {
      m.set(k, v)
    },
    removeItem: async (k) => {
      m.delete(k)
    },
  }
}
