// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Partner phones: another company's phone app that pairs with SlicerX as a phone, under its own name. The name is
// part of the pairing: the offer is made for one partner name, the phone's hello proves it knows that name, and the
// name goes into the transcript the six digits come from, so neither side can be talked into another partner's name.
// The name never travels in clear: the relay sees only that a hello is a partner hello.
//
// The name labels a pairing. It is what the app says it is called, not proof of who made it: any app can
// pair under any name the person types. The person decides what to trust, and what a partner phone may
// do (`Rights`).

/** Partner phones one host keeps at once, as the hub (sx-link `MAX_PARTNER_PAIRINGS`). */
export const MAX_PARTNER_PHONES = 8

/** Longest partner name, in characters. */
export const PARTNER_NAME_MAX = 64

/**
 * A partner name as people see it: control characters replaced, spaces collapsed and trimmed. Null when nothing is
 * left, when it is longer than PARTNER_NAME_MAX, or when it has no letter or digit.
 */
export function partnerName(input: string): string | null {
  // eslint-disable-next-line no-control-regex
  const t = input.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim()
  if (t.length === 0 || t.length > PARTNER_NAME_MAX || !/[\p{L}\p{N}]/u.test(t)) return null
  return t
}

/**
 * The form both sides mix into the handshake and compare names by: NFKC, lower case, spaces collapsed, so
 * "Example Phone" and "example phone" pair. sx-link folds partner names and partner key names the same way.
 */
export function partnerKey(name: string): string {
  return name.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
}
