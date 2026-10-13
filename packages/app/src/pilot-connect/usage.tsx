// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Settings > Account > Usage: how much of today's free mimir is left and when it resets, use over the last 24 hours and
// the last 7 days, and the per-minute limit. Shown only while mimir runs on mimir cloud. Loading draws everything at its final size.
import { ASSISTANT_NAME } from '@slicerx/pilot/name'
import { useEffect, useRef, useState } from 'react'
import { useEdition } from '../edition'
import { useApp } from '../state/store'
import { cloudReady } from './cloud-edition'
import { useMimirCloudHost } from './cloud'
import { pilotModel } from './llm'
import { chartBars, leftPercent, resetsIn, type MimirUsage } from './usage-model'
import { takeUsageFocus } from './usage-open'
import { usageFromQuota } from './usage-quota'
import './usage.css'

/** True while mimir answers on mimir cloud, the only place this section means anything. */
export function useOnFreeMimir(): boolean {
  const edition = useEdition()
  const host = useMimirCloudHost()
  const pref = useApp((s) => s.pilot)
  return cloudReady(edition, host) && pilotModel(edition, pref, true)?.provider === 'mimir-cloud'
}

/** Undefined while the first report loads, null when the proxy sends none (an older proxy, or a failed call). */
function useUsage(): MimirUsage | null | undefined {
  const host = useMimirCloudHost()
  const [usage, setUsage] = useState<MimirUsage | null | undefined>(undefined)
  useEffect(() => {
    let live = true
    const load = () =>
      void host
        ?.quota()
        .then((q) => live && setUsage(usageFromQuota(q)))
        .catch(() => live && setUsage((u) => u ?? null))
    load()
    const t = setInterval(load, 60_000)
    return () => {
      live = false
      clearInterval(t)
    }
  }, [host])
  return usage
}

/** Fills with what is left. */
function Bar({ left, label, testId }: { left: number | null; label: string; testId: string }) {
  return (
    <div className="mu-bar" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={left ?? 0} data-loading={left === null || undefined} data-testid={testId}>
      <i style={{ width: `${left ?? 0}%` }} />
    </div>
  )
}

// while loading the bars still have a shape, so the row keeps its look before the numbers land
const placeholder = (count: number) => Array.from({ length: count }, (_, i) => 0.25 + 0.2 * Math.sin((i * 24) / count / 2.5) ** 2)

/** Use as bars against the busiest one: no shares, no limit, just when it was used. */
function Chart({ values, count, label, from, to, testId }: { values: number[] | null; count: number; label: string; from: string; to: string; testId: string }) {
  const bars = values ? chartBars(values, count) : placeholder(count)
  return (
    <div className="mu-hours" role="img" aria-label={label} data-loading={values === null || undefined} data-testid={testId} data-count={count}>
      {bars.map((h, i) => (
        <i key={i} style={{ height: `${Math.max(4, h * 100)}%` }} />
      ))}
      <span className="mu-hours-ax">
        <span>{from}</span>
        <span>{to}</span>
      </span>
    </div>
  )
}

/** One line of text that holds its height while loading. */
function Line({ text, className = '', testId }: { text: string | null; className?: string; testId?: string }) {
  return (
    <span className={`mu-line ${className}`} data-loading={text === null || undefined} data-testid={testId}>
      {text ?? ' '}
    </span>
  )
}

export function MimirUsageSection() {
  const on = useOnFreeMimir()
  const loaded = useUsage()
  const ref = useRef<HTMLElement>(null)
  const shown = on && loaded !== null
  // opened from "See usage" in the chat: bring the section into view once it is drawn, and keep it there while the
  // account above it is still loading and grows, until that settles or the person scrolls
  useEffect(() => {
    const el = ref.current
    if (!shown || !el || !takeUsageFocus()) return
    const pin = () => el.scrollIntoView?.({ block: 'start' })
    pin()
    const box = el.parentElement
    if (!box || typeof ResizeObserver === 'undefined') return
    const watch = new ResizeObserver(pin)
    watch.observe(box)
    const stop = () => watch.disconnect()
    const timer = setTimeout(stop, 3000)
    const by = ['wheel', 'touchstart', 'keydown'] as const
    for (const e of by) window.addEventListener(e, stop, { once: true, passive: true })
    return () => {
      stop()
      clearTimeout(timer)
      for (const e of by) window.removeEventListener(e, stop)
    }
  }, [shown])
  // no report from the proxy shows nothing rather than a section that never fills
  if (!shown) return null
  const u = loaded ?? null
  const day = u ? leftPercent(u.day.used) : null
  const out = day === 0
  // an older proxy sends no days; the row waits for it rather than drawing nothing
  const days = u === null || u.daily
  return (
    <section ref={ref} className="set-sec mu" id="mimir-usage" aria-labelledby="mu-h" aria-busy={u === null || undefined} data-testid="mu-section">
      <h3 id="mu-h">Usage</h3>
      <p className="sx-small sx-muted">Free {ASSISTANT_NAME} has a daily limit.</p>
      <div className="mu-sum">
        <div className="mu-big">
          <span className="mu-big-n">
            <Line text={day === null ? null : `${day}%`} className="mu-num" testId="mu-today-left" /> <span className="sx-muted">left today</span>
          </span>
          <Bar left={day} label="Left today" testId="mu-today-bar" />
          <Line text={u ? resetsIn(u.day.resetsAt) : null} className="sx-small sx-muted" testId="mu-today-reset" />
        </div>
        <div className="mu-sum-side">
          <div className="mu-row">
            <b className="mu-row-h">Last 24 hours</b>
            <Chart values={u?.hourly ?? null} count={24} label="Use in each of the last 24 hours" from="24 h ago" to="now" testId="mu-hours" />
          </div>
          {days && (
            <div className="mu-row">
              <b className="mu-row-h">Last 7 days</b>
              <Chart values={u?.daily ?? null} count={7} label="Use on each of the last 7 days" from="6 days ago" to="today" testId="mu-days" />
            </div>
          )}
        </div>
        {out && (
          <p className="sx-small mu-out" data-testid="mu-today-out">
            Today's free {ASSISTANT_NAME} is used up. It comes back when the day resets.
          </p>
        )}
        <Line text={u ? `Up to ${u.perMinute.limit} messages a minute.` : null} className="sx-small sx-muted mu-rate" testId="mu-rate" />
      </div>
    </section>
  )
}
