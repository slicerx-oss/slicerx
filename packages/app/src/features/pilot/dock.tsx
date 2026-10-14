// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The assistant as a docked panel on the right of every workspace: the conversation and prompt,
// skill chips to start from, approval cards inline, and skills, plugins and permissions folded
// under the transcript. Not a workspace.
import { PERMISSION_LABELS, type ApprovalRequest, type PermissionMode, type PermissionPolicy } from '@slicerx/contracts'
import { SKILL_INFO } from '@slicerx/pilot'
import { ASSISTANT_NAME } from '@slicerx/pilot/name'
import { Inspector, Terminal, transcriptTurns, UsageLinkContext, usePilotRun, type PolicyClass, type Suggestion } from '@slicerx/pilot/ui'
import '@slicerx/pilot/ui/pilot.css'
import { Button, Icon, LinkButton } from '@slicerx/ui'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useHasFeature } from '../../features'
import { hostSlices, useInMimir } from '../../state/model-mode'
import { matchShortcut } from '../../lib/keys'
import { useFleet } from '../../lib/queries'
import { openSettings, pilotState, set, useApp } from '../../state/store'
import { clearDockChat, saveDockChat, savedDockChat } from './dock-chat'
import { closeDock, toggleDock, useDockOpen } from './dock-state'
import { watchOf, type Watch } from './watch'
import { usePilot } from './use-pilot'
import { ChatGptCard } from '../../pilot-connect/chatgpt-card'
import { MimirSetup } from '../../pilot-connect/mimir-setup'
import { Loading } from '../../shell/loading'
import { CloudNotice, useCloudNoticeDue } from '../../pilot-connect/cloud-notice'
import { openUsage } from '../../pilot-connect/usage-open'
import './dock.css'

const MODE_WORD: Record<PermissionMode, string> = { allow: 'Allow', ask: 'Ask first', off: 'Off' }

export function useWatching(): Watch {
  const fleet = useFleet()
  return useMemo(() => watchOf(fleet.data ?? []), [fleet.data])
}

/** The dot next to the name: cyan and breathing while a print is watched, orange and still when one needs a look. */
export function WatchDot({ watch }: { watch: Watch }) {
  if (watch.names.length === 0) return null
  const label = watch.attention ? `${ASSISTANT_NAME} needs you to look at ${watch.names.join(', ')}` : `${ASSISTANT_NAME} is watching ${watch.names.join(', ')}`
  return <span className="mimir-watch" data-attention={watch.attention ? true : undefined} role="img" aria-label={label} />
}

/** Starter chips where the host only models (the browser build): parts and questions, nothing that slices or prints. */
export const CAD_CHIPS: readonly { id: string; label: string; prompt: string }[] = [
  { id: 'design', label: 'Design a part', prompt: '40 mm L bracket, two M3 holes, 3 mm thick' },
  { id: 'color', label: 'Make a multi-color model', prompt: 'Build me a SlicerX logo in SlicerX black and X pink' },
  { id: 'measure', label: 'Measure the parts', prompt: 'How big is each part in this design?' },
  { id: 'material', label: 'Recommend a material', prompt: 'What should I print a car phone mount in? It sits on the dashboard in summer.' },
]

/** The skills a host that only models lists under Skills and permissions. */
const CAD_SKILLS: ReadonlySet<string> = new Set(['text_to_part', 'make_model', 'knowledge_answer', 'material_recommend'])

/** Starter chips: the first six skills with an example prompt (the rest are listed under Skills and permissions), or the modeling ones. */
export function chips(run: (text: string) => void, slices = hostSlices()): Suggestion[] {
  if (!slices) return CAD_CHIPS.map((c) => ({ id: c.id, label: c.label, onSelect: () => run(c.prompt) }))
  return SKILL_INFO.filter((s) => s.example).slice(0, 6).map((s) => ({ id: s.name, label: s.title ?? s.name, onSelect: () => run(s.example) }))
}

/** What the empty chat says: about prints where the host slices, about parts where it only models. */
export function emptyNote(watching: Watch, slices = hostSlices()): string {
  if (!slices) return `Describe a part and ${ASSISTANT_NAME} models it, or ask a material or printing question. Or pick one below.`
  return watching.attention ? `Something looked off on ${watching.names.join(', ')}. Ask what ${ASSISTANT_NAME} saw.` : watching.names.length ? `Watching ${watching.names.join(', ')}. Ask how the print is going, or pick a skill.` : 'Ask about a print, a failure or a setting, or pick a skill below.'
}

function DockBody() {
  const pilot = usePilot()
  const prompt = useApp((s) => s.pilotPrompt)
  // a reload picks the last conversation back up
  const [sessionId, setSessionId] = useState(() => savedDockChat()?.sessionId ?? `s_${Date.now().toString(36)}`)
  const [showThinking, setShowThinking] = useState(false)
  const [more, setMore] = useState(false)
  const [announcement, setAnnouncement] = useState('')
  const [policy, setPolicyState] = useState<PermissionPolicy | null>(null)
  const watching = useWatching()
  if (!pilot) return <Loading />
  return <DockRun pilot={pilot} sessionId={sessionId} onNewSession={() => {
    clearDockChat()
    setSessionId(`s_${Date.now().toString(36)}`)
  }} prompt={prompt} showThinking={showThinking} setShowThinking={setShowThinking} more={more} setMore={setMore} announcement={announcement} setAnnouncement={setAnnouncement} policy={policy ?? pilot.policy()} setPolicy={setPolicyState} watching={watching} />
}

function DockRun(p: {
  pilot: NonNullable<ReturnType<typeof usePilot>>
  sessionId: string
  onNewSession: () => void
  prompt: string | null
  showThinking: boolean
  setShowThinking: (v: boolean) => void
  more: boolean
  setMore: (v: boolean) => void
  announcement: string
  setAnnouncement: (v: string) => void
  policy: PermissionPolicy
  setPolicy: (v: PermissionPolicy) => void
  watching: Watch
}) {
  const { pilot, sessionId, prompt, setAnnouncement } = p
  const run = usePilotRun(pilot, sessionId)
  const { reset, restore } = run
  useEffect(() => reset(), [sessionId, reset])
  // the conversation from before a reload, shown as it was and given back to the runtime as context
  const restored = useRef(false)
  const shown = useRef(run.transcript)
  shown.current = run.transcript
  useEffect(() => {
    if (restored.current) return
    restored.current = true
    const saved = savedDockChat()
    if (!saved || saved.sessionId !== sessionId) return
    restore(saved.transcript)
    shown.current = saved.transcript
    pilot.resume?.(sessionId, transcriptTurns(saved.transcript))
  }, [sessionId, restore, pilot])
  // a runtime made again (signing in makes a new one) picks up the conversation on screen; one with history ignores it
  const madeFor = useRef(pilot)
  useEffect(() => {
    if (madeFor.current === pilot) return
    madeFor.current = pilot
    const turns = transcriptTurns(shown.current)
    if (turns.length) pilot.resume?.(sessionId, turns)
  }, [pilot, sessionId])
  const status = run.transcript.status
  // kept each time a run ends, the transcript as it stands then
  const was = useRef(status)
  useEffect(() => {
    const ended = was.current === 'running' && status !== 'running'
    was.current = status
    if (ended) saveDockChat(sessionId, run.transcript)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status])
  const prev = useRef(status)
  useEffect(() => {
    if (prev.current === status) return
    prev.current = status
    if (status === 'running') setAnnouncement(`${ASSISTANT_NAME} started`)
    else if (status === 'done') setAnnouncement('Run finished')
    else if (status === 'stopped') setAnnouncement('Run stopped')
    else if (status === 'error') setAnnouncement('Run failed')
  }, [status, setAnnouncement])

  // Cmd+K hands free text over as a prompt; each distinct value runs once.
  const consumed = useRef<string | null>(null)
  useEffect(() => {
    if (!prompt || consumed.current === prompt || run.running) return
    consumed.current = prompt
    run.run(prompt)
    set({ pilotPrompt: null })
  }, [prompt, run])

  const approvals = useMemo(
    () => ({
      onApprove: (r: ApprovalRequest, o: { bedClear: boolean }) => pilot.resolveApproval(r.id, o.bedClear ? { kind: 'approve', bedClear: true } : { kind: 'approve' }),
      onCancel: (r: ApprovalRequest) => pilot.resolveApproval(r.id, { kind: 'deny', reason: 'canceled' }),
    }),
    [pilot],
  )
  const onPolicy = (cls: PolicyClass, mode: PermissionMode): void => {
    const next: PermissionPolicy = { ...p.policy, classes: { ...p.policy.classes, [cls]: mode } }
    p.setPolicy(next)
    pilot.setPolicy(next)
    setAnnouncement(`${PERMISSION_LABELS[cls].title}: ${MODE_WORD[mode]}. Applies from the next step ${ASSISTANT_NAME} takes.`)
  }
  const first = run.transcript.turns.find((t) => t.user)?.user ?? null
  const empty = emptyNote(p.watching)
  const slices = hostSlices()
  return (
    <>
      {p.more ? null : <ChatGptCard compact />}
      {p.more ? (
        <div id="mimir-more" className="mimir-more">
          <Inspector transcript={run.transcript} paused={run.paused} skills={slices ? SKILL_INFO : SKILL_INFO.filter((s) => CAD_SKILLS.has(s.name))} plugins={run.transcript.plugins ?? []} policy={p.policy} onPolicy={onPolicy} />
        </div>
      ) : (
      <UsageLinkContext.Provider value={openUsage}>
      <Terminal
        sessionTitle={first ? first.slice(0, 40) : 'new'}
        transcript={run.transcript}
        running={run.running}
        replaying={run.replaying}
        paused={run.paused}
        showSpeed={false}
        speed="1"
        onSpeed={() => undefined}
        showThinking={p.showThinking}
        onShowThinking={p.setShowThinking}
        canReplay={false}
        onReplay={() => undefined}
        onPause={() => run.setPaused(!run.paused)}
        onRun={(m) => run.run(m)}
        onStop={run.cancel}
        suggestions={chips((m) => run.run(m))}
        approvals={approvals}
        emptyNote={empty}
        announcement={p.announcement}
        {...(slices ? {} : { placeholder: `Describe a part or ask ${ASSISTANT_NAME}` })}
      />
      </UsageLinkContext.Provider>
      )}
      <div className="mimir-foot">
        <LinkButton icon="plus" onClick={p.onNewSession}>
          New conversation
        </LinkButton>
        <LinkButton icon={p.more ? 'arrow-left' : 'skill'} expanded={p.more} aria-controls="mimir-more" onClick={() => p.setMore(!p.more)}>
          {p.more ? 'Back to the conversation' : 'Skills and permissions'}
        </LinkButton>
        <LinkButton icon="plugin" onClick={() => openSettings('pilot')}>
          Connect an AI agent
        </LinkButton>
      </div>
    </>
  )
}

/**
 * Before a model is connected the panel is the shared mimir setup, the same as in Settings > mimir and first-run. Nothing here builds a Pilot or calls a model; a question
 * handed over from Cmd+K waits in the store and runs once the connection is made.
 */
function ConnectStep() {
  const waiting = useApp((s) => s.pilotPrompt)
  return (
    <div className="mimir-connect">
      <p className="sx-small sx-muted">
        {waiting ? `Connect a model and ${ASSISTANT_NAME} answers "${waiting}".` : hostSlices() ? `Connect a model and ${ASSISTANT_NAME} answers questions about your prints and suggests changes you approve.` : `Connect a model and ${ASSISTANT_NAME} models parts from a description and answers printing questions.`} Nothing is sent until you connect.
      </p>
      <MimirSetup place="panel" idPrefix="mimir-ms" />
      <p className="sx-small sx-muted">
        Do not want {ASSISTANT_NAME}?{' '}
        <LinkButton
          onClick={() => {
            set({ pilot: { mode: 'off' }, pilotPrompt: null })
            closeDock()
          }}
        >
          Turn it off
        </LinkButton>
        . You can turn it back on in Settings.
      </p>
    </div>
  )
}

/** Mounted once by the shell; renders nothing without the pilot feature. Mod+/ toggles it. */
export function PilotDock() {
  const on = useHasFeature('pilot')
  const open = useDockOpen()
  const connected = useApp((s) => pilotState(s) === 'on')
  const watching = useWatching()
  // The mimir tab has the chat in the page; the dock stands aside there and comes back on the other tabs.
  const inMimir = useInMimir()
  const notice = useCloudNoticeDue()
  useEffect(() => {
    if (!on) return
    const onKey = (e: KeyboardEvent) => {
      if (matchShortcut(e, 'Mod+/')) {
        e.preventDefault()
        toggleDock()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [on])
  useEffect(() => {
    document.querySelector('.app')?.setAttribute('data-mimir', on && open && !inMimir ? 'open' : 'closed')
  }, [on, open, inMimir])
  if (!on || !open || inMimir) return null
  return (
    <aside className="mimir-dock sx-pilot sx-pilot-dock" aria-label={ASSISTANT_NAME}>
      <header className="mimir-head">
        <span className="mimir-mark" aria-hidden="true">
          <Icon name="mimir" size={18} />
        </span>
        <h2 className="mimir-name">{ASSISTANT_NAME}</h2>
        <WatchDot watch={watching} />
        <span className="mimir-sp" />
        <Button variant="ghost" size="sm" icon="close" aria-label={`Close ${ASSISTANT_NAME}`} tip="pilot.close" onClick={closeDock} />
      </header>
      {connected ? notice ? <CloudNotice /> : <DockBody /> : <ConnectStep />}
    </aside>
  )
}
