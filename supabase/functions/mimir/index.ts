// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// mimir's cloud model, as a Supabase edge function (handler.ts has the routes).
// Secrets: ANTHROPIC_API_KEY, and ANTHROPIC_API_KEY_WEB for the web edition (set by the
// owner); SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY come from the platform.
//
// The client address: Supabase's hosted functions sit behind Cloudflare, which sets
// cf-connecting-ip itself and overwrites what a client sends. Supabase's gateway appends
// the real address to x-forwarded-for after anything the client wrote, so its first entry
// is the client's to choose (github.com/orgs/supabase/discussions/34647 shows both
// headers on a spoofed request to a project's API; functions were not tested there). So the default is cf-connecting-ip, x-forwarded-for-last
// is the one other choice (MIMIR_CLIENT_IP_SOURCE), and a request with neither is refused.
// Check it on the host before relying on the IP cap: two networks must show different
// IP use on quota, and a spoofed x-forwarded-for must change nothing.
import { type Env, handle } from './handler.ts'
import { Jwks } from './jwt.ts'

const src = Deno.env.get('MIMIR_CLIENT_IP_SOURCE') === 'x-forwarded-for-last' ? 'x-forwarded-for-last' : 'cf-connecting-ip'
const supabaseUrl = (Deno.env.get('SUPABASE_URL') ?? '').replace(/\/+$/, '')
const env: Env = {
  supabaseUrl,
  serviceKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  anthropicKey: Deno.env.get('ANTHROPIC_API_KEY') ?? '',
  anthropicWebKey: Deno.env.get('ANTHROPIC_API_KEY_WEB') ?? '',
  issuer: Deno.env.get('MIMIR_AUTH_ISSUER') ?? '',
  jwks: new Jwks(`${supabaseUrl}/auth/v1/.well-known/jwks.json`),
  upstream: (Deno.env.get('MIMIR_UPSTREAM') ?? 'https://api.anthropic.com').replace(/\/+$/, ''),
  ipSource: src,
  waitUntil: (p) => (globalThis as { EdgeRuntime?: { waitUntil(p: Promise<unknown>): void } }).EdgeRuntime?.waitUntil(p),
}

Deno.serve((req) => {
  if (!env.anthropicKey || !env.serviceKey) {
    return new Response(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'mimir is not set up on this server.' } }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    })
  }
  return handle(req, env)
})
