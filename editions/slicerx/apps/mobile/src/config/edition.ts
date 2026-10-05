// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The edition config as app.config.ts resolved it at build time (expo.extra.edition).
// Names, backend endpoints and feature toggles come from here, never from constants.
import { parseEditionConfig, type EditionConfig } from '@slicerx/edition-config'
import Constants from 'expo-constants'

/**
 * Expo's web manifest turns every string that came from the environment into `{}`, so the backend
 * endpoints (`supabase.url`, `supabase.anonKey`, `cloudApi`, `relay`) arrive as empty objects and
 * the schema rejects them at boot. A backend part whose strings are not strings counts as not
 * configured, which is what an unset endpoint means everywhere else.
 */
export function repairWebEdition(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw
  const edition = raw as { backend?: Record<string, unknown> }
  const b = edition.backend
  if (!b || typeof b !== 'object') return raw
  const text = (v: unknown) => typeof v === 'string'
  const supabase = b['supabase'] as { url?: unknown; anonKey?: unknown } | null | undefined
  const fixed: Record<string, unknown> = { ...b }
  if (supabase && !(text(supabase.url) && text(supabase.anonKey))) fixed['supabase'] = null
  for (const k of ['cloudApi', 'relay']) if (fixed[k] !== null && fixed[k] !== undefined && !text(fixed[k])) fixed[k] = null
  return { ...edition, backend: fixed }
}

let cached: EditionConfig | null = null

export function edition(): EditionConfig {
  if (cached) return cached
  const extra = Constants.expoConfig?.extra as { edition?: unknown } | undefined
  if (!extra?.edition) throw new Error('expo.extra.edition is missing; app.config.ts sets it from the edition config')
  cached = parseEditionConfig(repairWebEdition(extra.edition))
  return cached
}

/** Where magic links and OAuth return: the app's own scheme. */
export function authCallbackUrl(): string {
  return `${edition().apps.deepLinkScheme}://auth/callback`
}
