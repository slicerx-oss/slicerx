// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The assistant as a docked panel on the right of every workspace: the conversation and prompt,
// skill chips to start from, approval cards inline, and skills, plugins and permissions folded
// under the transcript. Not a workspace.
import { PERMISSION_LABELS, type ApprovalRequest, type PermissionMode, type PermissionPolicy } from '@slicerx/contracts'
import { SKILL_INFO } from '@slicerx/pilot'
import { ASSISTANT_NAME } from '@slicerx/pilot/name'
import { Inspector, Terminal, usePilotRun, type PolicyClass, type Suggestion } from '@slicerx/pilot/ui'
import '@slicerx/pilot/ui/pilot.css'
import { Button, Icon, LinkButton } from '@slicerx/ui'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useHasFeature } from '../../features'
import { matchShortcut } from '../../lib/keys'
import { useFleet } from '../../lib/queries'
import { openSettings, pilotState, set, useApp } from '../../state/store'
import { closeDock, toggleDock, useDockOpen } from './dock-state'
import { watchOf, type Watch } from './watch'
import { usePilot } from './use-pilot'
import { ChatGptCard } from '../../pilot-connect/chatgpt-card'
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

/** Starter chips: the first six skills with an example prompt. The rest are listed under Skills and permissions. */
function chips(run: (text: string) => void): Suggestion[] {
  return SKILL_INFO.filter((s) => s.example).slice(0, 6).map((s) => ({ id: s.name, label: s.title ?? s.name, onSelect: () => run(s.example) }))
}

function DockBody() {
  const pilot = usePilot()
  const prompt = useApp((s) => s.pilotPrompt)
  const [sessionId, setSessionId] = useState(() => `s_${Date.now().toString(36)}`)
  const [showThinking, setShowThinking] = useState(false)
  const [more, setMore] = useState(false)
  const [announcement, setAnnouncement] = useState('')
  const [policy, setPolicyState] = useState<PermissionPolicy | null>(null)
  const watching = useWatching()
  if (!pilot) return <div className="ws-loading" aria-busy="true" />
  return <DockRun pilot={pilot} sessionId={sessionId} onNewSession={() => setSessionId(`s_${Date.now().toString(36)}`)} prompt={prompt} showThinking={showThinking} setShowThinking={setShowThinking} more={more} setMore={setMore} announcement={announcement} setAnnouncement={setAnnouncement} policy={policy ?? pilot.policy()} setPolicy={setPolicyState} watching={watching} />
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
  const { reset } = run
  useEffect(() => reset(), [sessionId, reset])
  const status = run.transcript.status
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
  const empty = p.watching.attention ? `Something looked off on ${p.watching.names.join(', ')}. Ask what ${ASSISTANT_NAME} saw.` : p.watching.names.length ? `Watching ${p.watching.names.join(', ')}. Ask how the print is going, or pick a skill.` : 'Ask about a print, a failure or a setting, or pick a skill below.'
  return (
    <>
      {p.more ? null : <ChatGptCard compact />}
      {p.more ? (
        <div id="mimir-more" className="mimir-more">
          <Inspector transcript={run.transcript} paused={run.paused} skills={SKILL_INFO} plugins={run.transcript.plugins ?? []} policy={p.policy} onPolicy={onPolicy} />
        </div>
      ) : (
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
      />
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
 * Before a model is connected the panel is the connect step from Settings > mimir: ChatGPT sign-in
 * first, an API key as the fallback. Nothing here builds a Pilot or calls a model; a question
 * handed over from Cmd+K waits in the store and runs once the connection is made.
 */
function ConnectStep() {
  const waiting = useApp((s) => s.pilotPrompt)
  return (
    <div className="mimir-connect">
      <p className="sx-small sx-muted">
        {waiting ? `Connect a model and ${ASSISTANT_NAME} answers "${waiting}".` : `Connect a model and ${ASSISTANT_NAME} answers questions about your prints and suggests changes you approve.`} Nothing is sent until you connect.
      </p>
      <ChatGptCard idPrefix="mimir-cg" />
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
    document.querySelector('.app')?.setAttribute('data-mimir', on && open ? 'open' : 'closed')
  }, [on, open])
  if (!on || !open) return null
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
      {connected ? <DockBody /> : <ConnectStep />}
    </aside>
  )
}
