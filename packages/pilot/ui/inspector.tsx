// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { useEffect, useId, useState } from 'react'
import { PERMISSION_LABELS, type PermissionClass, type PermissionMode, type PermissionPolicy, type PluginLoad } from '@slicerx/contracts'
import { Pill, Seg, type PillState, type SegOption } from '@slicerx/ui'
import { fmtDuration, fmtTokens } from './format'
import { elapsedMs, runningTools, type RunStatus, type Transcript } from './reduce'
import { ASSISTANT_NAME } from '../src/name'

export interface SkillInfo {
  name: string
  version: string
  description: string
  /** Short display name. */
  title?: string
  /** A prompt the user can send as is, for suggestion chips. */
  example?: string
}

export type PolicyClass = Exclude<PermissionClass, 'read'>

export interface InspectorProps {
  transcript: Transcript
  paused: boolean
  skills: SkillInfo[]
  plugins: PluginLoad[]
  policy: PermissionPolicy
  onPolicy: (cls: PolicyClass, mode: PermissionMode) => void
}

const RUN_STATE: Record<RunStatus, { state: PillState; word: string }> = {
  idle: { state: 'off', word: 'Idle' },
  running: { state: 'run', word: 'Running' },
  done: { state: 'ok', word: 'Done' },
  stopped: { state: 'warn', word: 'Stopped' },
  error: { state: 'bad', word: 'Error' },
}

const PLUGIN_STATE: Record<PluginLoad['state'], { state: PillState; word: string }> = {
  ready: { state: 'ok', word: 'Connected' },
  loading: { state: 'run', word: 'Loading' },
  off: { state: 'off', word: 'Off' },
  error: { state: 'bad', word: 'Error' },
}

const CLASSES: PolicyClass[] = ['slice', 'queue', 'start', 'profile', 'printer_config', 'share']

const MODE_OPTIONS: SegOption<PermissionMode>[] = [
  { value: 'allow', label: <span className="v-allow">Allow</span> },
  { value: 'ask', label: <span className="v-ask">Ask</span> },
  { value: 'off', label: <span className="v-off">Off</span> },
]
// Starting a print is allowed per printer only, never for the whole class.
const START_OPTIONS = MODE_OPTIONS.filter((o) => o.value !== 'allow')

/** The right column: this run's meter, installed skills, plugins and the Permissions policy. */
export function Inspector({ transcript, paused, skills, plugins, policy, onPolicy }: InspectorProps) {
  const ids = useId()
  const [now, setNow] = useState(() => Date.now())
  const live = transcript.status === 'running'
  useEffect(() => {
    if (!live) return undefined
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [live])

  const busy = runningTools(transcript)
  const run = paused && live ? { state: 'off' as const, word: 'Paused' } : RUN_STATE[transcript.status]
  const ready = plugins.filter((p) => p.state === 'ready').length
  const m = transcript.meter
  return (
    <aside className="insp" aria-label={`${ASSISTANT_NAME} inspector`}>
      {transcript.turns.length === 0 ? null : (
      <section className="sec" aria-labelledby={`${ids}-meter`}>
        <div className="pp-sec-h">
          <h2 id={`${ids}-meter`}>This run</h2>
          <Pill state={run.state}>{run.word}</Pill>
        </div>
        <dl className="meter">
          <div>
            <dt>Steps</dt>
            <dd>{m.steps}</dd>
          </div>
          <div>
            <dt>Tool calls</dt>
            <dd>{m.toolCalls}</dd>
          </div>
          <div>
            <dt>Elapsed</dt>
            <dd>{fmtDuration(elapsedMs(transcript, now))}</dd>
          </div>
          <div>
            <dt>Model tokens</dt>
            <dd>{fmtTokens(m.tokens)}</dd>
          </div>
        </dl>
      </section>
      )}
      <section className="sec" aria-labelledby={`${ids}-skills`}>
        <div className="pp-sec-h">
          <h2 id={`${ids}-skills`}>Skills</h2>
          <span className="cnt">{skills.length} installed</span>
        </div>
        <ul className="list">
          {skills.map((s) => (
            <li key={s.name} className={busy.some((b) => b.source === 'skill' && b.tool === s.name) ? 'pp-srow busy' : 'pp-srow'}>
              <div className="top">
                <span className="n">{s.name}</span>
                <span className="ver">v{s.version}</span>
              </div>
              <p>{s.description}</p>
            </li>
          ))}
        </ul>
      </section>
      <section className="sec" aria-labelledby={`${ids}-plugins`}>
        <div className="pp-sec-h">
          <h2 id={`${ids}-plugins`}>Plugins</h2>
          <span className="cnt">
            {ready} of {plugins.length} connected
          </span>
        </div>
        {plugins.length === 0 ? <p className="list-empty">Plugins load when {ASSISTANT_NAME} first runs</p> : null}
        <ul className="list">
          {plugins.map((p) => {
            const st = PLUGIN_STATE[p.state]
            const isBusy = busy.some((b) => b.source === 'plugin' && b.tool.split('.')[0] === p.id)
            return (
              <li key={p.id} className={isBusy ? 'prow busy' : 'prow'}>
                <div className="txt">
                  <span className="n">{p.name}</span>
                  {p.detail ? <span className="d">{p.detail}</span> : null}
                </div>
                <Pill state={st.state}>{st.word}</Pill>
              </li>
            )
          })}
        </ul>
      </section>
      <section className="sec" aria-labelledby={`${ids}-perm`}>
        <div className="pp-sec-h">
          <h2 id={`${ids}-perm`}>Permissions</h2>
        </div>
        <div className="perm">
          {CLASSES.map((c) => {
            const label = PERMISSION_LABELS[c]
            return (
              <div key={c} className="perm-row">
                <div className="txt">
                  <div className="n">{label.title}</div>
                  <div className="d">{label.detail}</div>
                </div>
                <Seg<PermissionMode> label={label.title} size="sm" value={policy.classes[c] ?? 'ask'} onChange={(v) => onPolicy(c, v)} options={c === 'start' ? START_OPTIONS : MODE_OPTIONS} />
              </div>
            )
          })}
        </div>
      </section>
    </aside>
  )
}
