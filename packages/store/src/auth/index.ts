// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The auth part of @slicerx/store on its own: sign-in, sessions and personal
// API tokens. A build without the store module imports only this entry point.
import type { AuthClient, SignInMethod } from '@slicerx/contracts'
import { createOfflineContext, offlineAuth, type OfflineOptions } from './offline'
import { createSupabaseClient, supabaseAuth, type SupabaseOptions } from './supabase'

export type AuthOptions = SupabaseOptions | OfflineOptions

export function createAuth(opts: AuthOptions): AuthClient {
  const auth = 'offline' in opts ? offlineAuth(createOfflineContext(opts)) : supabaseAuth(createSupabaseClient(opts), opts)
  return limitSignIn(auth, opts.signIn ?? ['email'])
}

/**
 * Offers only the given sign-in methods (in that order) and refuses the rest,
 * so a build never starts a flow its edition did not configure.
 */
export function limitSignIn<T extends AuthClient>(auth: T, methods: readonly SignInMethod[]): T {
  const supported = new Set(auth.signInMethods())
  const allowed = [...new Set(methods)].filter((m) => supported.has(m))
  const refuse = (m: SignInMethod) => ({ ok: false as const, code: 'forbidden' as const, message: `${m === 'email' ? 'Email' : m.charAt(0).toUpperCase() + m.slice(1)} sign-in is not enabled` })
  return {
    ...auth,
    signInMethods: () => [...allowed],
    signInWithEmail: (email) => (allowed.includes('email') ? auth.signInWithEmail(email) : Promise.resolve(refuse('email'))),
    signInWithOAuth: (p) => (allowed.includes(p) ? auth.signInWithOAuth(p) : Promise.resolve(refuse(p))),
  }
}

export type { OfflineOptions } from './offline'
export type { SupabaseOptions } from './supabase'
export { WEB_CALLBACK_PATH, deepLinkCallbackUrl, isAuthCallback, memoryAuthStorage, webAuthStorage, type AuthStorage } from './callbacks'
