// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// mimir's cloud model, as a Supabase edge function (handler.ts has the routes).
// Secrets: ANTHROPIC_API_KEY (set by the owner); SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY come from the platform. MIMIR_CLIENT_IP_SOURCE picks the
// header the client address is read from. The default, cf-connecting-ip, assumes a
// Cloudflare edge in front that overwrites it; check it on each host before relying on
// the IP cap (two networks must show different IP use on quota).
import { type Env, handle } from './handler.ts'

const src = Deno.env.get('MIMIR_CLIENT_IP_SOURCE') ?? 'cf-connecting-ip'
const env: Env = {
  supabaseUrl: (Deno.env.get('SUPABASE_URL') ?? '').replace(/\/+$/, ''),
  serviceKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  anthropicKey: Deno.env.get('ANTHROPIC_API_KEY') ?? '',
  upstream: (Deno.env.get('MIMIR_UPSTREAM') ?? 'https://api.anthropic.com').replace(/\/+$/, ''),
  ipSource: src as Env['ipSource'],
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
