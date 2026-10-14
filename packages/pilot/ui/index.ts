// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// @slicerx/pilot/ui: the mimir chat surface.
// Styles are not imported here. The app imports "@slicerx/pilot/ui/pilot.css" once, after
// "@slicerx/ui/styles.css", so library code stays free of CSS side effects.

export { PilotWorkspace } from './pilot-workspace'
export type { PilotWorkspaceProps } from './pilot-workspace'
export { SessionsRail } from './sessions-rail'
export type { SessionsRailProps } from './sessions-rail'
export { Terminal } from './terminal'
export type { TerminalProps, Suggestion } from './terminal'
export { Inspector } from './inspector'
export type { InspectorProps, SkillInfo, PolicyClass } from './inspector'
export { TranscriptView } from './transcript-view'
export type { ApprovalHandlers } from './transcript-view'
export { Bubble, PilotTurn } from './turn'
export { Think } from './think'
export type { ThinkProps } from './think'
export { Say } from './say'
export { ToolGroup, ToolRow, DisplayView, plainFold } from './tool-group'
export type { StepWords } from './tool-group'
export { Diff } from './diff'
export { PermLine, ErrorLine, PlanList, PluginsLoading } from './notes'
export { UsageLinkContext, USAGE_CODES } from './usage-link'
export { ApprovalCard } from './approval-card'
export { ChoiceCard } from './choice-card'
export { PartCard, PartGlyph, FollowUpChips, PartLookContext, DEFAULT_PART_LOOK } from './part-card'
export type { PartLook, PartHandlers } from './part-card'
export { createdPart, followUps, lastPart, madePart, partTitle, partLine, partSize } from './part'
export type { CreatedPart, FollowUp, PartKind } from './part'
export { LookupRecord } from './lookup-record'
export { SheetRecord } from './sheet-record'
export type { ChoiceCardProps } from './choice-card'
export { Composer, useAttachments } from './composer'
export type { ComposerProps, Attachments } from './composer'
export { AttachmentChip, ATTACH_LIMITS, ATTACH_ACCEPT, attachProblem, readAttachments } from './attachments'
export type { ApprovalCardProps } from './approval-card'
export { Summary } from './summary'
export type { SummaryProps } from './summary'
export { Citations, safeUrl } from './citations'
export { Spinner } from './spinner'
export { usePilotRun } from './use-pilot-run'
export type { PilotRun, ReplaySpeed } from './use-pilot-run'
export { useReducedMotion } from './use-reduced-motion'
export {
  reduceTranscript,
  foldEvents,
  emptyTranscript,
  startTurn,
  setReplaying,
  elapsedMs,
  runningTools,
  pendingApprovals,
  restoredTranscript,
  transcriptTurns,
} from './reduce'
export type { Transcript, Turn, Block, BlockKind, ToolRowModel, ApprovalResolution, Meter, RunStatus } from './reduce'
export { fmtDuration, fmtTokens, fmtSeconds, fmtClock, fmtCountdown, fmtWhen, segs, argTokens } from './format'
