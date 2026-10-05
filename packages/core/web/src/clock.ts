// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
/** The time and local UTC offset the engine reads for G-code date and time variables (SliceOptions.nowUnix and nowOffsetMinutes). */
export function sliceClock(now: Date = new Date()): { nowUnix: number; nowOffsetMinutes: number } {
  // getTimezoneOffset is minutes west of UTC; the engine wants minutes east. Math.abs avoids a negative zero.
  return { nowUnix: Math.floor(now.getTime() / 1000), nowOffsetMinutes: Math.abs(now.getTimezoneOffset()) === 0 ? 0 : -now.getTimezoneOffset() }
}
