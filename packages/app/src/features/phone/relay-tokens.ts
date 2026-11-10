// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The two calls the app entries make about relay tokens (remote.ts), without remote.ts itself. Only a connected printer
// bridge uses a relay token, so the phone code stays out of the startup code: the latest of each call waits here, and
// remote.ts takes them the moment it loads (the bridge's connection code, or Settings, imports it).
import type { RemoteTokens } from './remote'

type Call<A> = { args: A } | null

let tokens: RemoteTokens | null = null
let configure: Call<Parameters<RemoteTokens['configureRelayTokens']>> = null
let push: Call<Parameters<RemoteTokens['pushAccountToken']>> = null

/** See remote.ts: where relay tokens come from. */
export function configureRelayTokens(...args: Parameters<RemoteTokens['configureRelayTokens']>): void {
  if (tokens) return tokens.configureRelayTokens(...args)
  configure = { args }
}

/** See remote.ts: the account's session on sign-in and every refresh, null on sign-out. */
export function pushAccountToken(...args: Parameters<RemoteTokens['pushAccountToken']>): void {
  if (tokens) return tokens.pushAccountToken(...args)
  push = { args }
}

/** Called by remote.ts once, when it loads: it takes the calls that came before it did. */
export function relayTokensLoaded(t: RemoteTokens): void {
  tokens = t
  const c = configure
  const p = push
  configure = push = null
  if (c) t.configureRelayTokens(...c.args)
  if (p) t.pushAccountToken(...p.args)
}
