// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Free mimir's per-minute limit in words, in a module of its own so the chat's fold (ui/reduce.ts, which the phone app
// imports) can tell the line that the run stopped from the proxy's own refusal without pulling in the runtime.

/** What the person sees while the run waits on a slow_down refusal; the proxy's own line says to try again. */
export const SLOW_DOWN_NOTICE = 'Free mimir hit its limit for this minute, so mimir is waiting a moment, then going on.'
/** What the person sees in place of SLOW_DOWN_NOTICE when slow_down refusals outlast SLOW_DOWN_GIVE_UP_MS. */
export const SLOW_DOWN_LINE = 'Free mimir is still at its limit, so mimir stopped here. Say keep going in a minute to carry on.'
/** SLOW_DOWN_NOTICE once the run has gone on from the wait. */
export const SLOW_DOWN_WENT_ON = 'Free mimir hit its limit for this minute, so mimir waited a moment, then went on.'
/** SLOW_DOWN_NOTICE once the person canceled the run during the wait. */
export const SLOW_DOWN_CANCELED = 'Free mimir hit its limit for this minute, so mimir stopped waiting when you canceled.'
