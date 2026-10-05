// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Renders the edition-dependent parts of supabase/config.toml (the local
// stack): the auth redirect allow-list and the OAuth providers. Hosted
// projects set the same values in their own dashboard.
import type { EditionConfig } from '@slicerx/edition-config'
import { deepLinkCallbackUrl, WEB_CALLBACK_PATH } from './auth/callbacks'

/** The web app's development server, which the local stack always allows. */
const DEV_ORIGINS = ['http://127.0.0.1:5173', 'http://localhost:5173']
const OAUTH = ['github', 'google', 'apple', 'discord'] as const

const q = (s: string) => JSON.stringify(s)

export function renderAuthUrls(config: EditionConfig): string {
  const site = config.apps.web.origin ?? DEV_ORIGINS[0] ?? ''
  const origins = [...new Set([...(config.apps.web.origin ? [config.apps.web.origin] : []), ...DEV_ORIGINS])]
  const urls = [...origins.map((o) => new URL(WEB_CALLBACK_PATH, o).toString()), deepLinkCallbackUrl(config.apps.deepLinkScheme)]
  return [
    '# Generated from the edition config by `pnpm --filter @slicerx/store supabase:config`.',
    '# Web builds return to <origin>/auth/callback; apps return through the',
    '# edition deep link scheme. Both trade the PKCE code for a session.',
    `site_url = ${q(site)}`,
    'additional_redirect_urls = [',
    ...urls.map((u) => `  ${q(u)},`),
    ']',
  ].join('\n')
}

export function renderAuthProviders(config: EditionConfig): string {
  const out = [
    '# Generated from the edition config by `pnpm --filter @slicerx/store supabase:config`.',
    '# Providers listed in auth.providers are enabled with their public client id.',
    '# Secrets come from the environment only and never enter the repository.',
  ]
  for (const kind of OAUTH) {
    const p = config.auth.providers.find((x) => x.kind === kind)
    const clientId = p && 'clientId' in p ? p.clientId : ''
    out.push(
      '',
      `[auth.external.${kind}]`,
      `enabled = ${p ? 'true' : 'false'}`,
      `client_id = ${q(clientId)}`,
      `secret = "env(SUPABASE_AUTH_EXTERNAL_${kind.toUpperCase()}_SECRET)"`,
      'redirect_uri = ""',
      ...(kind === 'google' ? ['# Local sign-in with Google needs the nonce check off.', 'skip_nonce_check = true'] : []),
    )
  }
  return out.join('\n')
}

/** Replaces the text between `# edition:<name> begin` and `# edition:<name> end`. */
export function replaceBlock(toml: string, name: string, body: string): string {
  const begin = `# edition:${name} begin`
  const end = `# edition:${name} end`
  const a = toml.indexOf(begin)
  const b = toml.indexOf(end)
  if (a < 0 || b < a) throw new Error(`supabase/config.toml has no "${begin}" ... "${end}" block`)
  return `${toml.slice(0, a + begin.length)}\n${body}\n${toml.slice(b)}`
}

export function renderSupabaseConfig(toml: string, config: EditionConfig): string {
  return replaceBlock(replaceBlock(toml, 'auth-urls', renderAuthUrls(config)), 'auth-providers', renderAuthProviders(config))
}
