// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { useEffect, useId, useRef, useState } from 'react'
import { Icon } from '@slicerx/ui'
import { ASSISTANT_NAME } from '../src/name'
import { RavenWait, isRecall } from './raven-wait'
import { Think } from './think'
import { DisplayView, type StepWords } from './tool-group'
import { useReducedMotion } from './use-reduced-motion'
import { fmtStep, loopGroups, loopLabel, loopLine, loopSteps, type Loop } from './work-loop-model'

/** How long the live block takes to fade before its line shows, ms. */
const LEAVE_MS = 220

function Strip({ loop }: { loop: Loop }) {
  const steps = loopSteps(loop)
  return (
    <div className="wl-strip" aria-hidden="true">
      {steps.map((s) => (
        <i key={s.row.callId} className={s.row.state === 'running' ? 'on' : s.row.state === 'bad' ? 'bad' : 'done'} />
      ))}
    </div>
  )
}

/**
 * The live mark: a pulsing dot, and on a wait past 1.2 s the raven over it as everywhere else in the chat (huginn while
 * it works, muninn while it recalls). The owner keeps the ravens (2026-11-12).
 */
function Mark({ loop }: { loop: Loop }) {
  const dot = <span className="wl-dot" aria-hidden="true" />
  const running = loopSteps(loop).find((s) => s.row.state === 'running')
  return <RavenWait who={running && isRecall(running.row.tool) ? 'muninn' : 'huginn'}>{dot}</RavenWait>
}

function Live({ loop, words, leaving }: { loop: Loop; words: StepWords; leaving: boolean }) {
  const label = loopLabel(loop, words)
  return (
    <div className={leaving ? 'wl-live leaving' : 'wl-live'} role="status" data-testid="mimir-loop-live">
      <div className="wl-line">
        <Mark loop={loop} />
        <span className="wl-who">
          <b>{ASSISTANT_NAME}</b> is thinking
        </span>
        <span key={label} className="wl-act" data-testid="mimir-loop-label">
          {label}
        </span>
      </div>
      <Strip loop={loop} />
    </div>
  )
}

function Details({ loop, words, showThinking, id }: { loop: Loop; words: StepWords; showThinking: boolean; id: string }) {
  return (
    <div className="wl-details" id={id}>
      {loopGroups(loop).map((g, k) => (
        <div className="wl-group" key={k}>
          {g.part ? (
            <div className="wl-gh">
              <span>{g.part}</span>
              <span className="wl-t">{fmtStep(g.ms)}</span>
            </div>
          ) : null}
          <ul className="wl-sub">
            {g.items.map((i) => {
              if (i.kind === 'step') {
                const r = i.step.row
                const w = words(r)
                const bad = r.state === 'bad'
                return (
                  <li key={r.callId} className={bad ? 'failed' : undefined}>
                    <span className="wl-sw">
                      {bad ? <Icon name="alert" className="bad" /> : null}
                      {r.state === 'running' ? w?.doing : w?.done}
                      {bad && r.summary ? <span className="wl-why">{r.summary}</span> : null}
                    </span>
                    <span className="wl-t">{r.ms !== undefined ? fmtStep(r.ms) : ''}</span>
                  </li>
                )
              }
              if (i.kind === 'think') return showThinking ? <li key={i.block.id} className="wl-think"><Think text={i.block.text} ms={i.block.ms} showThinking={false} /></li> : null
              return <li key={i.block.id} className="wl-note">{i.block.kind === 'model' ? i.block.label : i.block.message}</li>
            })}
          </ul>
        </div>
      ))}
    </div>
  )
}

/**
 * A reply's working steps in one block: live, a mark, "mimir is thinking" and the step under way, with a strip that gains
 * a tick as each step starts and fills it as it finishes; done, one line ("Built in 14 steps, 2 min 35 s") that opens to
 * the steps by part.
 */
export function WorkLoop({ loop, live, stopped, words, showThinking }: { loop: Loop; live: boolean; stopped: boolean; words: StepWords; showThinking: boolean }) {
  const reduced = useReducedMotion()
  const id = useId()
  const [open, setOpen] = useState(false)
  // the live block fades before its line shows; a loop that was never live (a saved chat) shows its line at once
  const [leaving, setLeaving] = useState(false)
  const wasLive = useRef(live)
  useEffect(() => {
    if (wasLive.current && !live && !reduced) {
      setLeaving(true)
      const t = setTimeout(() => setLeaving(false), LEAVE_MS)
      wasLive.current = live
      return () => clearTimeout(t)
    }
    wasLive.current = live
    return undefined
  }, [live, reduced])
  const images = loopSteps(loop).flatMap((s) => s.row.display.filter((d) => d.kind === 'image'))
  const steps = loopSteps(loop).length
  // a loop of thoughts alone, with no step, folds to its thoughts as before
  if (!live && !leaving && steps === 0) {
    return (
      <>
        {loop.items.map((i) => (i.kind === 'think' ? <Think key={i.block.id} text={i.block.text} ms={i.block.ms} showThinking={showThinking} /> : null))}
      </>
    )
  }
  return (
    <div className="wl" data-testid="mimir-loop" data-state={live || leaving ? 'live' : 'done'} {...(loopSteps(loop).some((s) => s.row.state === 'bad') ? { 'data-failed': '' } : {})}>
      {live || leaving ? (
        <Live loop={loop} words={words} leaving={leaving} />
      ) : (
        <>
          <button type="button" className={wasLive.current === false && !reduced ? 'wl-sum enter' : 'wl-sum'} aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)} data-testid="mimir-loop-line">
            <Icon name="chevron-down" className="chev" />
            <span className="wl-num">{loopLine(loop, stopped)}</span>
          </button>
          {open ? <Details loop={loop} words={words} showThinking={showThinking} id={id} /> : null}
        </>
      )}
      {images.map((d, i) => (
        <DisplayView key={i} display={d} />
      ))}
    </div>
  )
}
