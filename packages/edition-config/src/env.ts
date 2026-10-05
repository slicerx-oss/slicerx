// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Environment overrides, the same names in Node and in the Rust crate (packages/edition-config/rust).
import { AUTH_KINDS, EDITION_FEATURES, type AuthKind } from './schema.ts'
import type { EditionConfigLayer } from './define.ts'

/** Every variable the loaders read, for docs and the Rust mirror. */
export const ENV_VARS = {
  SLICERX_CONFIG: 'path of the config JSON (runtime loaders only)',
  SLICERX_SUPABASE_URL: 'backend.supabase.url',
  SLICERX_SUPABASE_ANON_KEY: 'backend.supabase.anonKey',
  SLICERX_CLOUD_API_URL: 'backend.cloudApi',
  SLICERX_RELAY_URL: 'backend.relay',
  SLICERX_LINK_PORT: 'backend.linkPort',
  SLICERX_FEATURES: `comma list of enabled features from: ${EDITION_FEATURES.join(', ')}; replaces the file's toggles`,
  SLICERX_AI_PROVIDER: 'ai.provider',
  SLICERX_AI_MODEL: 'ai.model',
  SLICERX_AI_BASE_URL: 'ai.baseUrl',
  SLICERX_AUTH_PROVIDERS: `comma list of sign-in providers from: ${AUTH_KINDS.join(', ')}; replaces the file's list`,
  SLICERX_AUTH_GITHUB_CLIENT_ID: 'client id for github (likewise _GOOGLE_, _APPLE_, _DISCORD_)',
  SLICERX_APPLE_TEAM_ID: 'apps.ios.teamId',
} as const

type Provider = { kind: 'email' } | { kind: Exclude<AuthKind, 'email'>; clientId: string }

/**
 * The layer the environment adds. `base` is the config underneath; it is only needed so a
 * `SLICERX_AUTH_<KIND>_CLIENT_ID` without `SLICERX_AUTH_PROVIDERS` can fill in the file's providers.
 */
export function envLayer(env: Record<string, string | undefined>, base?: { auth?: { providers?: readonly unknown[] } }): EditionConfigLayer {
  const layer: EditionConfigLayer = {}
  const backend: NonNullable<EditionConfigLayer['backend']> = {}
  if (env['SLICERX_SUPABASE_URL'] || env['SLICERX_SUPABASE_ANON_KEY']) {
    backend.supabase = { url: env['SLICERX_SUPABASE_URL'] ?? '', anonKey: env['SLICERX_SUPABASE_ANON_KEY'] ?? '' }
  }
  if (env['SLICERX_CLOUD_API_URL']) backend.cloudApi = env['SLICERX_CLOUD_API_URL']
  if (env['SLICERX_RELAY_URL']) backend.relay = env['SLICERX_RELAY_URL']
  if (env['SLICERX_LINK_PORT']) backend.linkPort = Number(env['SLICERX_LINK_PORT'])
  if (Object.keys(backend).length) layer.backend = backend
  const list = env['SLICERX_FEATURES']
  if (list !== undefined) {
    const on = new Set(list.split(',').map((s) => s.trim()).filter(Boolean))
    const unknown = [...on].filter((f) => !(EDITION_FEATURES as readonly string[]).includes(f))
    if (unknown.length) throw new Error(`SLICERX_FEATURES has unknown feature(s): ${unknown.join(', ')}`)
    layer.features = Object.fromEntries(EDITION_FEATURES.map((f) => [f, on.has(f)]))
  }
  const ai: NonNullable<EditionConfigLayer['ai']> = {}
  if (env['SLICERX_AI_PROVIDER']) ai.provider = env['SLICERX_AI_PROVIDER'] as NonNullable<typeof ai.provider>
  if (env['SLICERX_AI_MODEL']) ai.model = env['SLICERX_AI_MODEL']
  if (env['SLICERX_AI_BASE_URL']) ai.baseUrl = env['SLICERX_AI_BASE_URL']
  if (Object.keys(ai).length) layer.ai = ai

  const clientId = (kind: string) => env[`SLICERX_AUTH_${kind.toUpperCase()}_CLIENT_ID`]
  const fileProviders = (base?.auth?.providers ?? []) as { kind?: string; clientId?: string }[]
  const listed = env['SLICERX_AUTH_PROVIDERS']
  const anyClientId = AUTH_KINDS.some((k) => k !== 'email' && clientId(k))
  if (listed !== undefined || anyClientId) {
    const kinds = listed !== undefined
      ? listed.split(',').map((s) => s.trim()).filter(Boolean)
      : fileProviders.map((p) => p.kind ?? '')
    const unknown = kinds.filter((k) => !(AUTH_KINDS as readonly string[]).includes(k))
    if (unknown.length) throw new Error(`SLICERX_AUTH_PROVIDERS has unknown provider(s): ${unknown.join(', ')}`)
    const providers: Provider[] = kinds.map((kind) => {
      if (kind === 'email') return { kind: 'email' }
      const id = clientId(kind) ?? fileProviders.find((p) => p.kind === kind)?.clientId
      if (!id) throw new Error(`sign-in provider ${kind} needs SLICERX_AUTH_${kind.toUpperCase()}_CLIENT_ID`)
      return { kind: kind as Exclude<AuthKind, 'email'>, clientId: id }
    })
    layer.auth = { providers }
  }
  const team = env['SLICERX_APPLE_TEAM_ID']
  if (team) layer.apps = { ios: { teamId: team } }
  return layer
}
