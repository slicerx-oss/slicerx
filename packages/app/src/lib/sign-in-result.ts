// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// How a sign-in link that came back to the app ended, so the sign-in form can show a failure itself.
export type SignInResult = { ok: true; email?: string } | { ok: false; message: string }

const listeners = new Set<(r: SignInResult) => void>()
let last: SignInResult | null = null

/** The host calls this when it has exchanged (or failed to exchange) a sign-in link. */
export function reportSignInResult(r: SignInResult): void {
  // Kept for a form that opens later only when no form is showing now.
  last = listeners.size ? null : r
  for (const cb of listeners) cb(r)
}

/** The latest result, then each new one. Returns the unsubscribe. */
export function onSignInResult(cb: (r: SignInResult) => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** The result that arrived before anyone listened, once. */
export function takeSignInResult(): SignInResult | null {
  const r = last
  last = null
  return r
}
