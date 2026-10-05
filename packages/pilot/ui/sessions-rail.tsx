// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { SessionSummary } from '@slicerx/contracts'
import { Button, Pill, type PillState } from '@slicerx/ui'
import { fmtDuration, fmtWhen } from './format'
import { ASSISTANT_NAME } from '../src/name'

const STATUS: Record<SessionSummary['status'], { state: PillState; word: string }> = {
  done: { state: 'ok', word: 'Done' },
  running: { state: 'run', word: 'Running' },
  stopped: { state: 'warn', word: 'Stopped' },
  error: { state: 'bad', word: 'Error' },
}

export interface SessionsRailProps {
  sessions: SessionSummary[]
  currentId: string
  onNew?: (() => void) | undefined
  onSelect?: ((id: string) => void) | undefined
  /** Local clock for "Today" and "Yesterday". */
  now: number
}

/** The left rail: past and running mimir sessions. */
export function SessionsRail({ sessions, currentId, onNew, onSelect, now }: SessionsRailProps) {
  return (
    <nav className="rail" aria-label={`${ASSISTANT_NAME} sessions`}>
      <div className="rail-h">
        <h2>Sessions</h2>
        <Button size="sm" icon="plus" disabled={!onNew} onClick={onNew}>
          New run
        </Button>
      </div>
      {sessions.length === 0 ? <p className="rail-empty">No sessions yet</p> : null}
      <ul className="runs">
        {sessions.map((s) => {
          const st = STATUS[s.status]
          return (
            <li key={s.id}>
              <button type="button" className="run-item" aria-current={s.id === currentId} onClick={() => onSelect?.(s.id)}>
                <span className="run-t">{s.title}</span>
                <span className="run-m">
                  <Pill state={st.state}>{st.word}</Pill>
                  <span>{s.status === 'running' ? 'now' : s.ms !== undefined ? fmtDuration(s.ms) : ''}</span>
                  <span className="when">{fmtWhen(s.startedAt, now)}</span>
                </span>
              </button>
            </li>
          )
        })}
      </ul>
      <p className="rail-note">{ASSISTANT_NAME} plans and slices on its own. Anything that reaches a printer or changes a saved profile waits for you, as set in Permissions.</p>
    </nav>
  )
}
