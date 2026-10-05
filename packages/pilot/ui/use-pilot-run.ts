// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Keep this file free of DOM and CSS imports: the phone app imports it.
// Runs mimir and folds its events into a transcript. Deltas are buffered and painted at most
// once per animation frame, so a fast token stream costs one React render per frame.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Pilot, PilotContext, PilotEvent, PilotMachine } from '@slicerx/contracts'
import { emptyTranscript, reduceTranscript, setReplaying, startTurn, type Transcript } from './reduce'
import { motionReduced } from '@slicerx/ui'

export type ReplaySpeed = '1' | '2' | 'instant'

export interface PilotRun {
  transcript: Transcript
  /** A live run or machine switch is streaming. */
  running: boolean
  /** A saved log is being played back. */
  replaying: boolean
  /** Painting is held; events keep arriving and show on resume. */
  paused: boolean
  /** Every event shown so far, for the Replay button. */
  log: () => readonly PilotEvent[]
  run: (message: string, opts?: { where?: string }) => void
  switchMachine: (from: PilotMachine, to: PilotMachine, label?: string) => void
  cancel: () => void
  setPaused: (paused: boolean) => void
  replay: (events: readonly PilotEvent[], speed: () => ReplaySpeed) => void
  reset: () => void
}

interface Queued {
  event: PilotEvent
  at: number
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

const hasRaf = (): boolean => typeof globalThis.requestAnimationFrame === 'function'

/** Pacing for a saved log at 1x, ms before the event shows. Events carry no timestamps. */
function replayDelay(e: PilotEvent): number {
  switch (e.type) {
    case 'thinking':
      return 14
    case 'text':
      return 22
    case 'tool_call':
      return 320
    case 'tool_result':
      return Math.min(1600, Math.max(400, e.ms ?? 700))
    case 'tool_progress':
      return 90
    case 'approval_resolved':
      return 1400
    case 'usage':
    case 'thinking_done':
    case 'text_done':
      return 0
    default:
      return 260
  }
}

function reducedMotion(): boolean {
  return motionReduced()
}

export function usePilotRun(pilot: Pilot, sessionId: string, opts: { context?: PilotContext } = {}): PilotRun {
  const [transcript, setTranscript] = useState<Transcript>(emptyTranscript)
  const [running, setRunning] = useState(false)
  const [replaying, setReplayingState] = useState(false)
  const [paused, setPausedState] = useState(false)

  const model = useRef<Transcript>(transcript)
  const queue = useRef<Queued[]>([])
  const events = useRef<PilotEvent[]>([])
  const frame = useRef<{ raf: number | null; timer: ReturnType<typeof setTimeout> | null }>({ raf: null, timer: null })
  const pausedRef = useRef(false)
  const gen = useRef(0)
  const controller = useRef<AbortController | null>(null)
  const replayTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const contextRef = useRef(opts.context)
  contextRef.current = opts.context
  const mounted = useRef(true)

  const flush = useCallback(() => {
    const f = frame.current
    if (f.raf !== null && hasRaf()) globalThis.cancelAnimationFrame(f.raf)
    if (f.timer !== null) clearTimeout(f.timer)
    f.raf = null
    f.timer = null
    if (pausedRef.current || queue.current.length === 0) return
    let s = model.current
    for (const q of queue.current) s = reduceTranscript(s, q.event, q.at)
    queue.current = []
    model.current = s
    if (mounted.current) setTranscript(s)
  }, [])

  const schedule = useCallback(() => {
    const f = frame.current
    if (f.raf !== null || f.timer !== null) return
    if (hasRaf()) f.raf = globalThis.requestAnimationFrame(flush)
    // Background tabs stop animation frames; a slow timer keeps approvals and the end of a run flowing.
    f.timer = setTimeout(flush, 120)
  }, [flush])

  const push = useCallback(
    (event: PilotEvent) => {
      events.current.push(event)
      const q = queue.current
      const last = q.at(-1)
      // Coalesce a burst of deltas into one fold.
      if (last && event.type === 'text' && last.event.type === 'text') last.event = { type: 'text', delta: last.event.delta + event.delta }
      else if (last && event.type === 'thinking' && last.event.type === 'thinking') last.event = { type: 'thinking', delta: last.event.delta + event.delta }
      else q.push({ event, at: Date.now() })
      schedule()
    },
    [schedule],
  )

  /** Applies a structural change right away, after anything still queued. */
  const commit = useCallback(
    (fn: (s: Transcript) => Transcript) => {
      const wasPaused = pausedRef.current
      pausedRef.current = false
      flush()
      pausedRef.current = wasPaused
      model.current = fn(model.current)
      if (mounted.current) setTranscript(model.current)
    },
    [flush],
  )

  const stopReplay = useCallback(() => {
    if (replayTimer.current !== null) clearTimeout(replayTimer.current)
    replayTimer.current = null
  }, [])

  const stopLive = useCallback(() => {
    gen.current++
    controller.current?.abort()
    controller.current = null
  }, [])

  /** Stops the live run and closes its turn as canceled without waiting for the runtime. */
  const cancelRun = useCallback(() => {
    const s = model.current
    const t0 = s.clockStart
    stopLive()
    push({ type: 'done', stopReason: 'canceled', ms: t0 === null ? s.meter.elapsedMs : Date.now() - t0 })
    flush()
    if (mounted.current) setRunning(false)
  }, [flush, push, stopLive])

  const consume = useCallback(
    async (iter: AsyncIterable<PilotEvent>, my: number) => {
      let sawDone = false
      const t0 = Date.now()
      try {
        for await (const ev of iter) {
          if (my !== gen.current) break
          if (ev.type === 'done') sawDone = true
          push(ev)
        }
      } catch (e) {
        if (my === gen.current) push({ type: 'error', message: errorText(e), retryable: false })
      } finally {
        if (my === gen.current) {
          if (!sawDone) push({ type: 'done', stopReason: 'error', ms: Date.now() - t0 })
          controller.current = null
          if (mounted.current) setRunning(false)
        }
      }
    },
    [push],
  )

  const begin = useCallback(
    (user: string | null, where: string | null): { signal: AbortSignal; my: number } => {
      stopReplay()
      if (controller.current) cancelRun()
      const my = ++gen.current
      const ac = new AbortController()
      controller.current = ac
      commit((s) => startTurn(setReplaying(s, false), { user, where }, Date.now()))
      setReplayingState(false)
      setRunning(true)
      return { signal: ac.signal, my }
    },
    [cancelRun, commit, stopReplay],
  )

  const run = useCallback(
    (message: string, o: { where?: string } = {}) => {
      const { signal, my } = begin(message, o.where ?? null)
      const ctx = contextRef.current
      const iter = pilot.run(sessionId, message, ctx === undefined ? { signal } : { signal, context: ctx })
      void consume(iter, my)
    },
    [begin, consume, pilot, sessionId],
  )

  const switchMachine = useCallback(
    (from: PilotMachine, to: PilotMachine, label?: string) => {
      const { signal, my } = begin(label ?? null, null)
      void consume(pilot.switchMachine(sessionId, from, to, { narrate: true, signal }), my)
    },
    [begin, consume, pilot, sessionId],
  )

  const cancel = useCallback(() => {
    if (controller.current) cancelRun()
    else if (replayTimer.current !== null) {
      stopReplay()
      setReplayingState(false)
    }
  }, [cancelRun, stopReplay])

  const setPaused = useCallback(
    (p: boolean) => {
      pausedRef.current = p
      setPausedState(p)
      if (!p) schedule()
    },
    [schedule],
  )

  const replay = useCallback(
    (log: readonly PilotEvent[], speed: () => ReplaySpeed) => {
      stopReplay()
      if (controller.current) stopLive()
      setRunning(false)
      queue.current = []
      events.current = []
      model.current = setReplaying(emptyTranscript(), true)
      setTranscript(model.current)
      setReplayingState(true)
      const items = [...log]
      let i = 0
      const step = (): void => {
        replayTimer.current = null
        const instant = speed() === 'instant' || reducedMotion()
        // Painting held: wait without consuming the log.
        if (pausedRef.current && !instant) {
          replayTimer.current = setTimeout(step, 100)
          return
        }
        while (i < items.length) {
          const ev = items[i]
          if (ev === undefined) break
          i++
          push(ev)
          const next = items[i]
          if (!instant && next !== undefined) {
            const d = replayDelay(next) / (speed() === '2' ? 2 : 1)
            if (d > 0) {
              replayTimer.current = setTimeout(step, d)
              return
            }
          }
        }
        flush()
        commit((s) => setReplaying(s, false))
        if (mounted.current) setReplayingState(false)
      }
      step()
    },
    [commit, flush, push, stopLive, stopReplay],
  )

  const reset = useCallback(() => {
    stopReplay()
    if (controller.current) stopLive()
    queue.current = []
    events.current = []
    model.current = emptyTranscript()
    setTranscript(model.current)
    setRunning(false)
    setReplayingState(false)
  }, [stopLive, stopReplay])

  const log = useCallback(() => events.current, [])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      gen.current++
      controller.current?.abort()
      if (replayTimer.current !== null) clearTimeout(replayTimer.current)
      const f = frame.current
      if (f.raf !== null && hasRaf()) globalThis.cancelAnimationFrame(f.raf)
      if (f.timer !== null) clearTimeout(f.timer)
    }
  }, [])

  return { transcript, running, replaying, paused, log, run, switchMachine, cancel, setPaused, replay, reset }
}
