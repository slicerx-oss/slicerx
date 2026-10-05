// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Why a camera view is about to go away, noted by whatever closes it (the back button, a crash, the
// printer leaving the list) just before it unmounts, so the stream's close can tell the bridge's
// connection log. A note is good for a moment only.
let note: { text: string; at: number } | null = null

/** Notes why the camera view on screen is about to close. */
export function noteViewClosing(text: string): void {
  note = { text, at: Date.now() }
}

/** The note made in the last two seconds, once. */
export function takeViewClosing(): string | null {
  const n = note
  note = null
  return n && Date.now() - n.at < 2000 ? n.text : null
}
