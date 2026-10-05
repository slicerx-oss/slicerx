// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The chat reuses Pilot's pure transcript reducer and formatters, so the phone and the desktop
// fold the same events into the same turns.
export { reduceTranscript, foldEvents, emptyTranscript, startTurn, pendingApprovals, elapsedMs } from '@slicerx/pilot/reduce'
export type { Transcript, Turn, Block, ToolRowModel, ApprovalResolution, RunStatus } from '@slicerx/pilot/reduce'
export { fmtDuration, fmtSeconds, fmtClock, fmtCountdown, fmtWhen, segs, argTokens } from '@slicerx/pilot/format'
