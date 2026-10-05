// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { useId, useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import { Button, Icon, Seg } from '@slicerx/ui'
import type { Transcript } from './reduce'
import { TranscriptView, type ApprovalHandlers } from './transcript-view'
import type { ReplaySpeed } from './use-pilot-run'
import { ASSISTANT_NAME } from '../src/name'

export interface Suggestion {
  id: string
  label: string
  onSelect: () => void
}

export interface TerminalProps {
  sessionTitle: string
  transcript: Transcript
  running: boolean
  replaying: boolean
  paused: boolean
  /** Show the playback speed control (a saved session log is on screen). */
  showSpeed: boolean
  speed: ReplaySpeed
  onSpeed: (speed: ReplaySpeed) => void
  showThinking: boolean
  onShowThinking: (show: boolean) => void
  canReplay: boolean
  onReplay: () => void
  onPause: () => void
  onRun: (message: string) => void
  onStop: () => void
  suggestions: Suggestion[]
  approvals: ApprovalHandlers
  /** Shown when the session has no turns yet. */
  emptyNote: string
  announcement: string
}

const SPEEDS = [
  { value: '1', label: '1x' },
  { value: '2', label: '2x' },
  { value: 'instant', label: 'Instant' },
] as const

/** The terminal column: title bar with playback controls, the conversation, and the prompt. */
export function Terminal(p: TerminalProps) {
  const ids = useId()
  const inputId = `${ids}-input`
  const thinkingId = `${ids}-thinking`
  const [text, setText] = useState('')
  const body = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  // Follow the stream while the reader is at the bottom; leave them be once they scroll up.
  useLayoutEffect(() => {
    const el = body.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [p.transcript])

  const submit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault()
    const msg = text.trim()
    if (!msg) return
    setText('')
    stick.current = true
    p.onRun(msg)
  }

  const active = p.running || p.replaying
  return (
    <section className="term" aria-label={`${ASSISTANT_NAME} terminal`}>
      <div className="term-bar">
        <div className="dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </div>
        <div className="term-title">
          {ASSISTANT_NAME} - <b>{p.sessionTitle}</b> - zsh
        </div>
        <div className="ctrl">
          <button className="ibtn" type="button" title="Replay this run" aria-label="Replay this run" disabled={!p.canReplay} onClick={p.onReplay}>
            <Icon name="rotate" />
          </button>
          <button
            className="ibtn"
            type="button"
            title={p.paused ? 'Resume' : 'Pause'}
            aria-label={p.paused ? 'Resume' : 'Pause'}
            aria-pressed={p.paused}
            disabled={!active}
            onClick={p.onPause}
          >
            <Icon name={p.paused ? 'play' : 'pause'} />
          </button>
          {p.showSpeed ? (
            <>
              <span className="sep" aria-hidden="true" />
              <Seg<ReplaySpeed> label="Playback speed" size="sm" mono value={p.speed} onChange={p.onSpeed} options={SPEEDS} />
            </>
          ) : null}
          <label className="pp-switch" htmlFor={thinkingId}>
            <input type="checkbox" id={thinkingId} checked={p.showThinking} onChange={(e) => p.onShowThinking(e.currentTarget.checked)} />
            <span className="trk" aria-hidden="true" />
            Show thinking
          </label>
        </div>
      </div>
      <div
        className="term-body"
        ref={body}
        tabIndex={0}
        aria-label={`${ASSISTANT_NAME} conversation`}
        aria-busy={active || undefined}
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
        }}
      >
        <div className="term-out">
          {p.transcript.turns.length === 0 ? <div className="meta-ln">{p.emptyNote}</div> : null}
          <TranscriptView transcript={p.transcript} showThinking={p.showThinking} approvals={p.approvals} />
        </div>
      </div>
      <form className="term-in" autoComplete="off" onSubmit={submit}>
        <div className="in-row">
          <span className="pg" aria-hidden="true">
            {'❯'}
          </span>
          <label htmlFor={inputId} className="vh">
            Ask {ASSISTANT_NAME}
          </label>
          <input id={inputId} type="text" placeholder={`Ask ${ASSISTANT_NAME} to plan, slice, diagnose or tune`} spellCheck={false} value={text} onChange={(e) => setText(e.currentTarget.value)} />
          {p.running ? (
            <Button size="sm" onClick={p.onStop}>
              Stop
            </Button>
          ) : (
            <Button size="sm" type="submit" variant={text.trim() ? 'primary' : 'default'}>
              Run
            </Button>
          )}
        </div>
        <div className="chips" role="group" aria-label="Suggestions">
          {p.suggestions.map((s) => (
            <button key={s.id} type="button" className="sugg" onClick={s.onSelect}>
              {s.label}
            </button>
          ))}
        </div>
      </form>
      <div className="vh" aria-live="polite">
        {p.announcement}
      </div>
    </section>
  )
}
