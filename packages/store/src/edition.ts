// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Builds the auth and store clients from an edition config
// (@slicerx/edition-config): endpoints, feature toggles, sign-in providers and
// the deep link scheme. Apps pass editionFromBuild(); Node services pass
// loadEditionConfig().
import type { AuthClient, SignInMethod, StoreClient } from '@slicerx/contracts'
import type { EditionConfig } from '@slicerx/edition-config'
import { createAuth, type AuthOptions } from './auth/index'
import { deepLinkCallbackUrl, WEB_CALLBACK_PATH, type AuthStorage } from './auth/callbacks'
import { createStore } from './index'

/** What the running app contributes: its kind and the host's sign-in plumbing. */
export interface EditionPlatform {
  kind: 'web' | 'desktop' | 'mobile'
  /** Desktop and phone: open the provider page in the system browser. */
  openExternal?: (url: string) => Promise<void>
  /** Session persistence; desktop and phone pass a keychain-backed store. */
  storage?: AuthStorage
  /** Web only: the page's origin, used when the config sets no apps.web.origin (local development). */
  origin?: string
}

/** Where magic links and OAuth return for this platform. */
export function authRedirectUrl(config: EditionConfig, platform: EditionPlatform): string {
  if (platform.kind !== 'web') return deepLinkCallbackUrl(config.apps.deepLinkScheme)
  const origin = config.apps.web.origin ?? platform.origin
  if (!origin) throw new Error('the web build needs apps.web.origin in the edition config, or the page origin')
  return new URL(WEB_CALLBACK_PATH, origin).toString()
}

/** The sign-in methods the edition configures, in its order. */
export function editionSignInMethods(config: EditionConfig): SignInMethod[] {
  return config.auth.providers.map((p) => p.kind)
}

function options(config: EditionConfig, platform: EditionPlatform): AuthOptions | null {
  const signIn = editionSignInMethods(config)
  if (config.features.demoData) return { offline: true, signIn }
  const sb = config.backend.supabase
  if (!sb) return null
  return {
    url: sb.url,
    anonKey: sb.anonKey,
    signIn,
    auth: {
      redirectUrl: () => authRedirectUrl(config, platform),
      ...(platform.openExternal ? { openExternal: platform.openExternal } : {}),
      ...(platform.storage ? { storage: platform.storage } : {}),
    },
  }
}

/**
 * Accounts for this edition, or null when it has no backend (a plain
 * reference build). Works with the store switched off.
 */
export function createEditionAuth(config: EditionConfig, platform: EditionPlatform): AuthClient | null {
  const opts = options(config, platform)
  return opts ? createAuth(opts) : null
}

/** Library parts deferred past v1: off in every edition client until then. */
export const DEFERRED_PAST_V1 = { comments: false, collections: false } as const

/**
 * The store client for this edition, or null when features.store is off.
 * features.demoData serves the bundled demo catalog with no backend. The feed
 * follows its feature toggle; comments and collections are off for v1.
 */
export function createEditionStore(config: EditionConfig, platform: EditionPlatform): StoreClient | null {
  if (!config.features.store) return null
  const opts = options(config, platform)
  if (!opts) return null
  return createStore({
    ...opts,
    features: { feed: config.features.feed, ...DEFERRED_PAST_V1 },
  })
}
