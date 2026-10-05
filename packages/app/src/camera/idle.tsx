// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What a camera view shows without a picture. While the camera connects, huginn and muninn spar inside a
// turning ring of runes; with no picture the two ravens rest, dimmed, over one short line, the full reason
// in its tip.
import { Icon, prefersReducedMotion, RAVEN_BODY, RAVEN_WING, tipAttrs } from '@slicerx/ui'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import type { CameraViewStatus } from './use-camera'
import './idle.css'

/** One short line for a reason the camera shows no picture; the full text goes in the tip. */
export function shortReason(text: string): string {
  if (/login|password|access code|unauthori[sz]ed|refused/i.test(text)) return 'Camera login refused'
  if (/decode|codec/i.test(text)) return 'Video format not supported'
  if (/stopped/i.test(text)) return 'The camera stopped'
  if (/not reachable|offline/i.test(text)) return 'Printer offline'
  const first = text.trim().split(/(?<=\.)\s/)[0]!.replace(/\.$/, '')
  return first && first.length <= 32 ? first : 'No picture'
}


// elder futhark runes on a 4 by 8 box, straight strokes only
const RUNES: Record<string, string> = {
  H: 'M0 0v8M4 0v8M0 2.5l4 3',
  U: 'M0 8V0l4 3v5',
  G: 'M0 0l4 8M4 0L0 8',
  I: 'M2 0v8',
  N: 'M2 0v8M.5 3l3 2',
  M: 'M0 0v8M4 0v8M0 0l4 4M4 0L0 4',
}
const RING = [...'HUGINN MUNINN HUGINN MUNINN ']
const RUNE_MARKS = RING.map((c, i) => {
  const at = `rotate(${(i * 360) / RING.length} 100 60) translate(98.5 8) scale(0.75)`
  return c === ' ' ? <circle key={i} cx="2" cy="4" r="0.9" transform={at} className="rb-sep" /> : <path key={i} d={RUNES[c]} transform={at} />
})

function Raven({ at, late }: { at: string; late?: boolean }) {
  return (
    <g transform={at} className={late ? 'rb-late' : undefined}>
      <g className="rb-bob">
        <g className="rb-lunge">
          <path className="rb-body" d={RAVEN_BODY} />
          <path className="rb-wing" d={RAVEN_WING} />
          <circle className="rb-eye" cx="8.9" cy="10.5" r="0.85" />
        </g>
      </g>
    </g>
  )
}

/** Huginn and muninn lunge at each other every 2.4 s, with a flash where they meet. */
function Battle() {
  const halo = `rb-halo-${useId().replace(/[^\w-]/g, '')}`
  return (
    <svg className="rb-scene" viewBox="0 0 200 120" aria-hidden="true">
      <defs>
        <radialGradient id={halo}>
          <stop offset="0%" style={{ stopColor: 'var(--orange)', stopOpacity: 0.9 }} />
          <stop offset="100%" style={{ stopColor: 'var(--orange)', stopOpacity: 0 }} />
        </radialGradient>
      </defs>
      <circle className="rb-glow" cx="100" cy="62" r="28" fill={`url(#${halo})`} />
      <g className="rb-ring">
        <circle cx="100" cy="60" r="56" />
        <circle cx="100" cy="60" r="42" />
        {RUNE_MARKS}
      </g>
      <g transform="translate(100 62)">
        <g className="rb-spark">
          <path d="M0-7.5l1.2 6 5.8-1.5-4.7 3.7 3.2 5.3-5.5-3.5-5.5 3.5 3.2-5.3-4.7-3.7 5.8 1.5z" />
          <circle r="1.3" />
        </g>
      </g>
      <Raven at="translate(96 38) scale(-2 2)" />
      <Raven at="translate(104 38) scale(2)" late />
    </svg>
  )
}

/** Pauses the animation while the view is off screen or the tab is hidden. */
function usePauseWhenUnseen(on: boolean) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!on || !el) return
    let seen = true
    const apply = () => el.toggleAttribute('data-paused', !seen || document.visibilityState === 'hidden')
    const io = typeof IntersectionObserver === 'function' ? new IntersectionObserver(([e]) => ((seen = e!.isIntersecting), apply())) : null
    io?.observe(el)
    document.addEventListener('visibilitychange', apply)
    return () => {
      io?.disconnect()
      document.removeEventListener('visibilitychange', apply)
    }
  }, [on])
  return ref
}

/** One full clash, so a camera that answers at once still shows the ravens before its picture. */
export const BATTLE_MIN_MS = 1200
const FADE_MS = 200

export type FirstLook = 'hold' | 'fade' | 'done'

// views that have shown their battle this session, by `once` key ("hud:<printer id>")
const shown = new Set<string>()
const NONE = Symbol('none')

/**
 * Where a camera view's first look stands: 'hold' keeps the battle over the picture until one clash has
 * played, 'fade' crosses to the picture, 'done' after that. It holds when the view opens on `key` with
 * `first` set, or when `first` turns on later for the same key, whether or not a picture is already
 * there; `first` turning off after that does not cut the hold short. With `once`, only the first view
 * per session under that key holds. A reconnect or a new still never holds, nor does reduced motion.
 */
export function useFirstLook(ready: boolean, key: unknown, first: boolean, once?: string): FirstLook {
  const eligible = () => first && !prefersReducedMotion() && !(once && shown.has(once))
  const [look, setLook] = useState<FirstLook>(() => (eligible() ? 'hold' : 'done'))
  const [played, setPlayed] = useState(false)
  const startedFor = useRef<unknown>(NONE)
  useEffect(() => {
    if (startedFor.current === key) return
    if (!eligible()) return setLook('done')
    startedFor.current = key
    setPlayed(false)
    setLook('hold')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, first])
  const holding = look === 'hold'
  useEffect(() => {
    if (!holding) return
    const t = window.setTimeout(() => setPlayed(true), BATTLE_MIN_MS)
    return () => window.clearTimeout(t)
  }, [holding, key])
  useEffect(() => {
    if (look === 'hold' && played && ready) {
      if (once) shown.add(once)
      setLook('fade')
    }
    if (look !== 'fade') return
    const t = window.setTimeout(() => setLook('done'), FADE_MS)
    return () => window.clearTimeout(t)
  }, [look, played, ready, once])
  return look
}

/** For tests: every view holds again. */
export function forgetFirstLooks(): void {
  shown.clear()
}

/** The battle over a picture that is ready but held back, fading out as the picture fades in. */
export function FirstLookCover({ look, size = 'sm' }: { look: FirstLook; size?: 'sm' | 'lg' }) {
  return look === 'done' ? null : <CameraIdle connecting text="Connecting to the camera" size={size} leaving={look === 'fade'} />
}

/** What a view without a picture shows for a camera problem: the countdown while it is tried again, else the reason. */
export function CameraProblem({ status, error, size = 'lg' }: { status: CameraViewStatus; error: string; size?: 'sm' | 'lg' }) {
  if (status.state === 'failed') {
    const why = status.reason || error || 'The camera did not start.'
    return <CameraIdle text={shortReason(why)} detail={why} size={size} showDetail={size === 'lg'} />
  }
  if (status.state === 'retrying') return <CameraIdle text={shortReason(error)} detail={status.reason} retryInMs={status.retryInMs ?? 0} attempt={status.attempt} size={size} showDetail={size === 'lg'} />
  return error ? <CameraIdle text={shortReason(error)} detail={error} size={size} showDetail={size === 'lg'} /> : null
}

/** Whole seconds left before `ms` runs out, counted from when `ms` or `attempt` last changed. */
function useCountdown(ms: number | undefined, attempt: number | undefined): number {
  const [left, setLeft] = useState(() => Math.ceil((ms ?? 0) / 1000))
  useEffect(() => {
    if (ms === undefined) return
    const end = Date.now() + ms
    const tick = () => setLeft(Math.max(0, Math.ceil((end - Date.now()) / 1000)))
    tick()
    const t = window.setInterval(tick, 250)
    return () => window.clearInterval(t)
  }, [ms, attempt])
  return left
}

/** The line while the camera is tried again, counting down to the next try. */
export function retryLine(seconds: number): string {
  return seconds > 0 ? `Trying again in ${seconds} s` : 'Trying again now'
}

export function CameraIdle({ text, detail, connecting = false, size = 'sm', showDetail = false, leaving = false, retryInMs, attempt, breathe = false, action }: { text: string; detail?: string | undefined; connecting?: boolean; size?: 'sm' | 'lg'; showDetail?: boolean; leaving?: boolean; retryInMs?: number | undefined; attempt?: number | undefined; /** a slow rest, for a printer that is away */ breathe?: boolean; /** a button under the line */ action?: ReactNode }) {
  const ref = usePauseWhenUnseen(connecting || breathe || retryInMs !== undefined)
  const left = useCountdown(retryInMs, attempt)
  const retrying = retryInMs !== undefined && !connecting
  const line = retrying ? retryLine(left) : text
  const px = size === 'lg' ? 56 : 36
  // a small view gives the whole camera ground to the battle, or to the ravens while they try again,
  // and says what it is to readers and in the tip only
  const bare = (connecting || retrying) && size === 'sm'
  const tip = detail && detail !== line && !showDetail ? tipAttrs({ title: line, body: detail }) : retrying && bare ? tipAttrs({ title: line }) : {}
  return (
    <div ref={ref} className="cam-idle" data-size={size} data-connecting={connecting || undefined} data-retrying={retrying || undefined} data-breathe={retrying ? 'quick' : breathe ? 'slow' : undefined} data-leaving={leaving || undefined} role="status" aria-busy={connecting || undefined} aria-label={bare ? line : undefined} {...(bare ? tip : {})}>
      {connecting ? (
        <>
          <Battle />
          {size === 'lg' ? <p className="cam-idle-names">huginn · muninn</p> : null}
        </>
      ) : (
        <span className="cam-ravens">
          <Icon name="huginn" className="cam-raven" style={{ width: px, height: px, transform: 'scaleX(-1)' }} />
          <Icon name="huginn" className="cam-raven" style={{ width: px, height: px }} />
        </span>
      )}
      {bare ? null : (
        <p className="cam-idle-line" {...tip}>
          {line}
        </p>
      )}
      {showDetail && detail && detail !== line ? <p className="cam-idle-detail">{detail}</p> : null}
      {action}
    </div>
  )
}
