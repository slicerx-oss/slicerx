// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What is left on a printer's spool, in words: the exact grams when the printer reports them (Bambu Lab's
// remain_g), else its percentage, an estimate.

export function spoolLeft(s: { remainingG?: number | undefined; remainingPct?: number | undefined }): string | null {
  if (s.remainingG !== undefined) return `${Math.round(s.remainingG)} g left`
  if (s.remainingPct !== undefined) return `${Math.round(s.remainingPct)}% left`
  return null
}
