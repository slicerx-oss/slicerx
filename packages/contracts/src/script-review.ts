// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors

export interface ScriptIdentity {
  model: string
  firmware: string
}

export interface ScriptReviewInput {
  selected: ScriptIdentity | null
  declared?: ScriptIdentity[]
  key: string
  text: string
}

export interface ScriptReview {
  schemaVersion: 1
  decision: 'exact' | 'cosmetic' | 'review'
  reason: string
  identity: ScriptIdentity | null
  source: string | null
  stockVersion: string | null
  fingerprint: string | null
  ignored: string[]
}
