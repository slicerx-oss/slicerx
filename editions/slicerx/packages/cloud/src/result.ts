// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Every client call returns a CloudResult and never throws for network or
// service errors, so callers on a phone with no signal keep working.

export type CloudErrorCode =
  | 'unauthorized'
  | 'forbidden'
  /** Hosted cloud slicing is invite only, and this account is not on the list. */
  | 'not_invited'
  | 'not_found'
  | 'bad_request'
  | 'conflict'
  | 'limit'
  | 'unavailable'
  /** The request never reached the service (no network, DNS, TLS, abort). */
  | 'offline'
  /** The service answered with something this client cannot read. */
  | 'invalid_response'
  /** A downloaded file does not match the hash the service reported. */
  | 'hash_mismatch'

export type CloudResult<T> = { ok: true; value: T } | { ok: false; code: CloudErrorCode; message: string }

export const ok = <T>(value: T): CloudResult<T> => ({ ok: true, value })

export const fail = <T = never>(code: CloudErrorCode, message: string): CloudResult<T> => ({ ok: false, code, message })

/** Codes worth retrying later without changing the request. */
export function isRetryable(code: CloudErrorCode): boolean {
  return code === 'offline' || code === 'unavailable'
}
