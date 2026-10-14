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

export interface ScriptReplacementInput {
  selected: ScriptIdentity | null
  declared?: ScriptIdentity[]
  key: string
  original: string
  replacement: string
}

/** An inspectable proposal. Applying it must recheck current text and identity. */
export interface ScriptReplacement {
  schemaVersion: 1
  decision: 'prepared' | 'review'
  reason: string
  key: string
  original: string
  replacement: string
  originalFingerprint: string
  replacementFingerprint: string
  originalReview: ScriptReview
  stockReview: ScriptReview
  diff: { operation: 'equal' | 'remove' | 'add'; originalLine: number | null; replacementLine: number | null; text: string }[]
}
