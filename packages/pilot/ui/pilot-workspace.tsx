// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  PERMISSION_LABELS,
  type ApprovalRequest,
  type PermissionMode,
  type PermissionPolicy,
  type Pilot,
  type PilotContext,
  type PilotEvent,
  type PluginLoad,
  type SessionSummary,
} from '@slicerx/contracts'
import { Inspector, type PolicyClass, type SkillInfo } from './inspector'
import { pendingApprovals } from './reduce'
import { SessionsRail } from './sessions-rail'
import { Terminal, type Suggestion } from './terminal'
import { usePilotRun, type ReplaySpeed } from './use-pilot-run'
import { ASSISTANT_NAME } from '../src/name'

export interface PilotWorkspaceProps {
  pilot: Pilot
  sessionId: string
  context?: PilotContext
  sessions?: SessionSummary[]
  onNewSession?(): void
  onSelectSession?(id: string): void
  /** A saved session log to play back, paced by the speed control. */
  replay?: PilotEvent[]
  onPolicyChange?(policy: PermissionPolicy): void
  /** Called when the person picks "Switch to PETG"; the settings diff streams into this transcript. Needs `context.machine`. */
  onSwitchMachine?(): void
  /** Opens the plan on the plate from an approval card. Without it the card says where editing lives. */
  onEditPlan?(request: ApprovalRequest): void
  skills: SkillInfo[]
  plugins?: PluginLoad[]
  /** Starts a run with this text once per distinct value (Cmd+K free text). */
  initialPrompt?: string
  /** Called after `initialPrompt` has started a run, so the caller can clear it. */
  onPromptConsumed?(): void
}

const PROMPTS = ['Plan 12 strong PETG brackets by Friday', 'Diagnose the Bay 4 failure', 'Fit this model on an A1 mini', 'Tune the new PETG spool']

const MODE_WORD: Record<PermissionMode, string> = { allow: 'Allow', ask: 'Ask first', off: 'Off' }

const SPEED_KEY = 'sx-pilot-speed'

function readSpeed(): ReplaySpeed {
  try {
    const v = globalThis.localStorage?.getItem(SPEED_KEY)
    return v === '2' || v === 'instant' ? v : '1'
  } catch {
    return '1'
  }
}

/** A short slug of the first request for the terminal title, like "plan-12-strong-petg". */
export function runTitle(first: string | null): string {
  if (!first) return 'new-run'
  const slug = first
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .slice(0, 4)
    .join('-')
  return slug || 'new-run'
}

/** The mimir page: sessions rail, terminal and inspector, driven by real PilotEvents. */
export function PilotWorkspace(props: PilotWorkspaceProps) {
  const { pilot, sessionId, context, replay, onPolicyChange, onSwitchMachine, onEditPlan } = props
  const runOpts = context === undefined ? {} : { context }
  const run = usePilotRun(pilot, sessionId, runOpts)
  const [showThinking, setShowThinking] = useState(false)
  const [speed, setSpeedState] = useState<ReplaySpeed>(readSpeed)
  const speedRef = useRef(speed)
  speedRef.current = speed
  const getSpeed = useCallback(() => speedRef.current, [])
  const [policy, setPolicyState] = useState<PermissionPolicy>(() => pilot.policy())
  const [announcement, setAnnouncement] = useState('')
  const [clock] = useState(() => Date.now())

  const { transcript } = run
  const { reset, replay: playLog } = run

  // A new session or a new saved log replaces what is on screen.
  useEffect(() => {
    if (replay) playLog(replay, getSpeed)
    else reset()
  }, [sessionId, replay, playLog, reset, getSpeed])

  // Screen reader announcements for the moments that need the person.
  const pending = pendingApprovals(transcript)
  const lastPending = pending.at(-1)
  const status = transcript.status
  const prevStatus = useRef(status)
  useEffect(() => {
    const was = prevStatus.current
    prevStatus.current = status
    if (was === status) return
    if (status === 'running') setAnnouncement(`${ASSISTANT_NAME} started`)
    else if (status === 'done') setAnnouncement('Run finished')
    else if (status === 'stopped') setAnnouncement('Run stopped')
    else if (status === 'error') setAnnouncement('Run failed')
  }, [status])
  useEffect(() => {
    if (lastPending) setAnnouncement(`Approval needed: ${lastPending.title}`)
  }, [lastPending])

  const setSpeed = (v: ReplaySpeed): void => {
    setSpeedState(v)
    try {
      globalThis.localStorage?.setItem(SPEED_KEY, v)
    } catch {
      // Private windows can refuse storage; the choice still holds for this page.
    }
  }

  const onPolicy = (cls: PolicyClass, mode: PermissionMode): void => {
    const next: PermissionPolicy = { ...policy, classes: { ...policy.classes, [cls]: mode } }
    setPolicyState(next)
    pilot.setPolicy(next)
    onPolicyChange?.(next)
    setAnnouncement(`${PERMISSION_LABELS[cls].title}: ${MODE_WORD[mode]}. Applies from the next step ${ASSISTANT_NAME} takes.`)
  }

  const approvals = useMemo(
    () => ({
      onApprove: (r: ApprovalRequest, o: { bedClear: boolean }) => pilot.resolveApproval(r.id, o.bedClear ? { kind: 'approve', bedClear: true } : { kind: 'approve' }),
      onCancel: (r: ApprovalRequest) => pilot.resolveApproval(r.id, { kind: 'deny', reason: 'canceled' }),
      onEditPlan,
    }),
    [pilot, onEditPlan],
  )

  const where = context?.project ? `~/${context.project}` : null
  const startRun = (message: string): void => run.run(message, where ? { where } : {})

  // Cmd+K hands free text over as a prompt; each distinct value runs once.
  const consumed = useRef<string | undefined>(undefined)
  const { initialPrompt, onPromptConsumed } = props
  useEffect(() => {
    if (!initialPrompt || consumed.current === initialPrompt || run.running) return
    consumed.current = initialPrompt
    run.run(initialPrompt, where ? { where } : {})
    onPromptConsumed?.()
  }, [initialPrompt, onPromptConsumed, run, where])

  const suggestions: Suggestion[] = PROMPTS.map((label, i) => ({ id: `p${i}`, label, onSelect: () => startRun(label) }))
  const machine = context?.machine
  if (machine) {
    suggestions.push({
      id: 'switch',
      label: 'Switch to PETG',
      onSelect: () => {
        run.switchMachine(machine, { ...machine, material: 'petg' }, 'Switch to PETG')
        onSwitchMachine?.()
      },
    })
  }

  const plugins = props.plugins ?? transcript.plugins ?? []
  const project = context?.project
  const emptyNote = `New session${project ? ` in ~/${project}` : ''}. Describe a job below, or pick a suggestion.`
  const canReplay = !run.running && !run.replaying && ((replay?.length ?? 0) > 0 || transcript.turns.length > 0)

  return (
    <div className="sx-pilot">
      <SessionsRail sessions={props.sessions ?? []} currentId={sessionId} onNew={props.onNewSession} onSelect={props.onSelectSession} now={clock} />
      <Terminal
        sessionTitle={runTitle(transcript.turns.find((t) => t.user)?.user ?? null)}
        transcript={transcript}
        running={run.running}
        replaying={run.replaying}
        paused={run.paused}
        showSpeed={replay !== undefined || run.replaying}
        speed={speed}
        onSpeed={setSpeed}
        showThinking={showThinking}
        onShowThinking={setShowThinking}
        canReplay={canReplay}
        onReplay={() => playLog(replay ?? [...run.log()], getSpeed)}
        onPause={() => run.setPaused(!run.paused)}
        onRun={startRun}
        onStop={run.cancel}
        suggestions={suggestions}
        approvals={approvals}
        emptyNote={emptyNote}
        announcement={announcement}
      />
      <Inspector transcript={transcript} paused={run.paused} skills={props.skills} plugins={plugins} policy={policy} onPolicy={onPolicy} />
    </div>
  )
}
