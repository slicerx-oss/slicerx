// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The print run's progress card: the print the run started, as the printer reports it, flat in the conversation. The
// layer, the time left and the bar come from the fleet row (the cache every printer view reads, kept live from the
// printer's status events), else from the run's job. While the card is on screen and the printer prints, a camera still
// refreshes every 30 s. Once the job ends the card says how it ended and keeps its last figures and still. A later print
// in the same chat gets a card of its own; this one keeps its job.
import type { RunJob } from '@slicerx/contracts'
import { Icon } from '@slicerx/ui'
import { useEffect, useRef, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { fleetQuery, useFleetLive, usePrinters } from '../../lib/queries'
import { useApp } from '../../state/store'
import type { RunCardProps } from './run-cards'

/** How often the camera still refreshes while the printer prints, ms. */
export const STILL_MS = 30_000

/** Time left in plain words: "About 41 min left", "About 2 h 30 min left". */
export function aboutLeft(s: number): string {
  const min = Math.max(1, Math.round(s / 60))
  if (min < 60) return `About ${min} min left`
  const h = Math.floor(min / 60)
  const m = min % 60
  return `About ${h} h${m ? ` ${m} min` : ''} left`
}

const ENDED: Record<NonNullable<RunJob['outcome']>, string> = { finished: 'Finished', failed: 'Stopped', canceled: 'Canceled' }

/** Whether the element is on screen: always, where the browser cannot say. */
function useOnScreen(el: HTMLElement | null): boolean {
  const [on, setOn] = useState(true)
  useEffect(() => {
    if (!el || typeof IntersectionObserver !== 'function') return undefined
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) setOn(e.isIntersecting)
    })
    io.observe(el)
    return () => io.disconnect()
  }, [el])
  return on
}

/**
 * The fleet rows from the cache every printer view shares, kept live from the job's printer only while `live`: an
 * ended card holds no listener on the printer.
 */
function useFleetRows(printerId: string, live: boolean) {
  const printers = usePrinters()
  const epoch = useApp((s) => s.linkEpoch)
  const q = useQuery({ ...fleetQuery(printers, epoch), enabled: printers !== undefined, placeholderData: keepPreviousData })
  useFleetLive(live ? printers : undefined, live && printerId ? [printerId] : [])
  return q.data
}

/** The printer's camera still, refreshed every STILL_MS while `on` and the page is shown. */
function useStill(printerId: string, on: boolean): string {
  const printers = usePrinters()
  const [url, setUrl] = useState('')
  const kept = useRef('')
  useEffect(() => {
    if (!on || !printers) return undefined
    let stop = false
    const tick = async (): Promise<void> => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      try {
        const blob = await printers.snapshot(printerId)
        if (stop || !blob) return
        const next = URL.createObjectURL(blob)
        if (kept.current) URL.revokeObjectURL(kept.current)
        kept.current = next
        setUrl(next)
      } catch {
        // the last still stays
      }
    }
    void tick()
    const timer = setInterval(() => void tick(), STILL_MS)
    return () => {
      stop = true
      clearInterval(timer)
    }
  }, [on, printers, printerId])
  // the last still goes with the card
  useEffect(
    () => () => {
      if (kept.current) URL.revokeObjectURL(kept.current)
    },
    [],
  )
  return url
}

/**
 * The job this card is for: the first one it was drawn with. The chat's run moves on to the next print, and a card
 * keeps the last it heard of its own.
 */
function useOwnJob(latest: RunJob | null): RunJob | null {
  const own = useRef<RunJob | null>(null)
  if (latest && (!own.current || (latest.startedAt === own.current.startedAt && latest.printerId === own.current.printerId))) own.current = latest
  return own.current
}

export function ProgressCard({ run }: RunCardProps) {
  const job = useOwnJob(run?.job ?? null)
  const ended = job?.outcome != null
  const rows = useFleetRows(job?.printerId ?? '', Boolean(job) && !ended)
  const [el, setEl] = useState<HTMLDivElement | null>(null)
  const onScreen = useOnScreen(el)
  const row = job ? rows?.find((r) => r.id === job.printerId) : undefined
  // once the job ended the row may be the printer's next print: the card keeps the end of its own
  const live = !ended && row ? row.status : null
  const camera = Boolean(row?.status.cameraAvailable)
  const printing = live?.state === 'printing'
  const still = useStill(job?.printerId ?? '', Boolean(job) && camera && printing && onScreen)
  if (!job) return null
  const name = row?.name || 'your printer'
  const layer = live?.layer ?? job.layer
  const layerCount = live?.layerCount ?? job.layerCount
  const timeLeftS = live?.timeLeftS ?? job.timeLeftS
  const pct = Math.round(live?.progress !== undefined ? Math.min(1, Math.max(0, live.progress)) * 100 : Math.min(100, Math.max(0, job.progress ?? 0)))
  const state = ended ? job.outcome! : (live?.state ?? job.state)
  const title = ended ? `${ENDED[job.outcome!]} on ${name}` : state === 'paused' ? `Paused on ${name}` : `Printing on ${name}`
  const layerText = layer !== undefined && layerCount !== undefined ? `Layer ${layer} of ${layerCount}` : 'Waiting for the first layer'
  const leftText = ended ? (job.outcome === 'finished' ? 'Done' : 'Ended') : timeLeftS !== undefined && timeLeftS > 0 ? aboutLeft(timeLeftS) : 'Time left not known yet'
  const flagged = !ended && (job.attention === true || live?.watch === 'attention')
  const icon = ended ? (job.outcome === 'finished' ? 'check' : 'warning') : 'printer'
  return (
    <div ref={setEl} className="lookup-rec progress-rec" role="group" aria-label={`Print on ${name}`} data-testid="mimir-progress" data-state={state}>
      <div className="progress-rec-main">
        {camera || still ? (
          <span className="progress-rec-still">{still ? <img data-testid="mimir-progress-still" src={still} alt={`Camera view of ${name}`} /> : null}</span>
        ) : null}
        <div className="progress-rec-body">
          <span className="lookup-rec-t">
            <Icon name={icon} />
            <span>{title}</span>
          </span>
          <span className="progress-rec-file">{job.fileName}</span>
          <span className="progress-rec-figs">
            <span>{layerText}</span>
            <span>{leftText}</span>
          </span>
          <span className="progress-rec-bar" role="progressbar" aria-label="Print progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} data-tone={ended && job.outcome !== 'finished' ? 'off' : undefined}>
            <span style={{ width: `${pct}%` }} />
          </span>
        </div>
      </div>
      {flagged ? (
        <p className="progress-rec-flag" role="status">
          Print watch flagged something. Take a look at the camera.
        </p>
      ) : null}
    </div>
  )
}
