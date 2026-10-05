// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// @slicerx/store. See README.md for the public API.
import type { StoreClient } from '@slicerx/contracts'
import { limitSignIn, type AuthOptions } from './auth/index'
import { createOfflineStore } from './offline'
import { createSupabaseStore } from './supabase'

/** Store parts an edition can switch off. All default to on. */
export interface StoreFeatures {
  feed?: boolean
  /** Library comments. The SlicerX edition keeps them off until after v1. */
  comments?: boolean
  /** Collections of listings. The SlicerX edition keeps them off until after v1. */
  collections?: boolean
}

export type StoreOptions = AuthOptions & { features?: StoreFeatures }

/**
 * `{ offline: true }` serves the bundled seed in memory, signed in as the demo
 * member. `{ url, anonKey, auth }` talks to a Supabase project. Apps normally
 * call createEditionStore(config, platform) instead, which fills these in from
 * the edition config.
 */
export function createStore(opts: StoreOptions): StoreClient {
  const client = 'offline' in opts ? createOfflineStore(opts) : createSupabaseStore(opts)
  return withFeatures(limitSignIn(client, opts.signIn ?? ['email']), opts.features ?? {})
}

const off = (what: string) => async () => ({ ok: false as const, code: 'unavailable' as const, message: `${what} are not open yet` })

/** Turns off the parts an edition switched off, leaving the rest untouched. */
export function withFeatures(client: StoreClient, features: StoreFeatures): StoreClient {
  const out: StoreClient = { ...client }
  if (features.feed === false) {
    out.feed = async () => ({ items: [] })
  }
  if (features.comments === false) {
    out.comments = async () => []
    out.addComment = off('Comments')
    out.editComment = off('Comments')
    out.deleteComment = off('Comments')
  }
  if (features.collections === false) {
    out.collections = async () => []
    out.createCollection = off('Collections')
    out.setInCollection = off('Collections')
  }
  return out
}

export {
  createAuth,
  limitSignIn,
  deepLinkCallbackUrl,
  WEB_CALLBACK_PATH,
  isAuthCallback,
  memoryAuthStorage,
  webAuthStorage,
  type AuthOptions,
  type AuthStorage,
  type OfflineOptions,
  type SupabaseOptions,
} from './auth/index'
export { authRedirectUrl, createEditionAuth, createEditionStore, editionSignInMethods, type EditionPlatform } from './edition'
export type { SupabaseStoreOptions } from './supabase'
export {
  DEFAULT_MAX_FILE_MB,
  HANDLE_PATTERN,
  LINK_DOMAINS,
  MAX_CREATOR_LINKS,
  MAX_FEATURED,
  MAX_UPLOAD_BYTES,
  RESERVED_HANDLES,
  UPLOAD_EXTENSIONS,
  slugify,
  validateCreatorLink,
  validateCreatorLinks,
  validateDevice,
  validateHandle,
  validateUpload,
  type Checked,
} from './validate'
