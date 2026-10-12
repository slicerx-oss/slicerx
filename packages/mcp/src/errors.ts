// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The error a tool returns for input it cannot use, with its code. No Node imports: the app's tools use it too.
/**
 * Stable codes for refused calls. They appear in the error text as `Error: <code>: <message>` and as
 * `structuredContent.error.code`, so an integrating app can branch on them without parsing prose.
 */
export const ERROR_CODES = [
  'invalid_input',
  'file_not_found',
  'path_not_allowed',
  'unsupported_format',
  'invalid_model',
  'no_such_plate',
  'download_failed',
  'urls_disabled',
  'unknown_profile',
  'invalid_settings',
  'engine_unavailable',
  'slice_failed',
  'preflight_blocked',
  'project_gcode_review',
  'project_settings_unused',
  'sequence_clearance',
  'collision',
  'not_configured',
  'auth_failed',
  'not_invited',
  'quota_exceeded',
  'rate_limited',
  'service_error',
  'not_found',
  'not_supported',
  'internal_error',
] as const
/** Locked-project refusals keep the format's own reason after `sxlock_`, such as `sxlock_wrong_account`. */
export type ErrorCode = (typeof ERROR_CODES)[number] | `sxlock_${string}`

export class ToolInputError extends Error {
  override readonly name = 'ToolInputError'
  readonly code: ErrorCode
  /** Structured facts for the integrating app, sent as `structuredContent.error.details`. */
  readonly details: Record<string, unknown> | undefined
  constructor(message: string, code: ErrorCode = 'invalid_input', details?: Record<string, unknown>) {
    super(message)
    this.code = code
    this.details = details
  }
}
