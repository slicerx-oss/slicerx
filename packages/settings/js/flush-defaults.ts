// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The flush settings shape and its default, on their own so the store can start without the
// measured flush tables (filament/flush.ts loads those on first use).
export interface FlushSettings {
  /** Scales every value, like Bambu Studio's flushing volume multiplier. */
  multiplier: number
  /** Values typed by hand, keyed `from>to` with 1-based slot numbers. They win over auto flush. */
  manual: Record<string, number>
}

export const FLUSH_DEFAULTS: FlushSettings = { multiplier: 1, manual: {} }

export const pairKey = (from: number, to: number): string => `${from}>${to}`
