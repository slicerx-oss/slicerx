// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
/** A refusal with a code the hub passes on (invalid_input, not_found, not_ready, refused, busy). */
export class LinkError extends Error {
  constructor(
    readonly code: 'invalid_input' | 'not_found' | 'not_ready' | 'refused' | 'busy',
    message: string,
  ) {
    super(message)
  }
}
