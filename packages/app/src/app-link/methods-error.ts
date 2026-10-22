// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
/**
 * A refusal with a code the hub passes on (invalid_input, not_found, not_ready, refused, busy, and signed_out for a read
 * of the person's own account data while nobody is signed in).
 */
export class LinkError extends Error {
  constructor(
    readonly code: 'invalid_input' | 'not_found' | 'not_ready' | 'refused' | 'busy' | 'stale_body' | 'missing_face' | 'ambiguous_face' | 'signed_out',
    message: string,
    /** Structured facts about the refusal, passed to the client as `error.details`. */
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
  }
}
