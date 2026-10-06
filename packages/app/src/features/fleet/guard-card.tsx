// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The guard's card on the Printers tab: the frame it acted on with the strike where it saw something, what happened in
// plain words, and the next step (Resume, Check again, Dismiss; for a plate, It's fine and This plate is clear).
import { useEffect, useRef, useState } from 'react'
import { Button, Pill } from '@slicerx/ui'
import { useHost } from '../../host'
import type { FleetRow } from '../../lib/queries'
import { printerAction } from '../../state/actions'
import { toast } from '../../state/store'
import { askToNotify, guardHub, heldStart, takeFocus, tripCopy, type GuardTrip } from './guard'
import { StrikeMark } from './strike'
import { statusLine } from './wall'
import './guard.css'

/** The frame behind a trip as an object URL, reloaded when the trip changes or `fresh` asks for a new still. */
function useEvidence(printerId: string, at: string): { url: string; again: () => Promise<void> } {
  const host = useHost()
  const [url, setUrl] = useState('')
  const load = async (fresh: boolean) => {
    const hub = guardHub(host)
    const pic = hub ? await hub.watch.evidence(printerId, fresh).catch(() => null) : null
    setUrl((old) => {
      if (old) URL.revokeObjectURL(old)
      return pic ? URL.createObjectURL(new Blob([pic.data as BlobPart], { type: pic.contentType })) : ''
    })
  }
  useEffect(() => {
    void load(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [printerId, at])
  useEffect(() => () => setUrl((old) => (old && URL.revokeObjectURL(old), '')), [])
  return { url, again: () => load(true) }
}

const STATE_PILL: Record<GuardTrip['state'], { label: string; tone: 'bad' | 'warn' | 'ok' }> = {
  paused: { label: 'Paused', tone: 'bad' },
  blocked: { label: 'Start on hold', tone: 'warn' },
  alert: { label: 'Monitor only', tone: 'warn' },
  clear: { label: 'Clear', tone: 'ok' },
}

export function GuardCard({ row, trip, now }: { row: FleetRow; trip: GuardTrip; now: number }) {
  const host = useHost()
  const hub = guardHub(host)
  const copy = tripCopy(trip, row.name)
  const { url, again } = useEvidence(row.id, trip.at)
  const ref = useRef<HTMLElement>(null)
  const [busy, setBusy] = useState(false)
  const headingId = `guard-${row.id}`
  useEffect(() => {
    if (!takeFocus(row.id)) return
    ref.current?.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
    ref.current?.focus({ preventScroll: true })
  }, [row.id, trip.at])

  const run = (fn: () => Promise<unknown>) => async () => {
    if (busy) return
    setBusy(true)
    try {
      await fn()
    } catch (e) {
      toast(e instanceof Error ? e.message : 'The printer bridge did not answer', 'error')
    } finally {
      setBusy(false)
    }
  }
  const resume = run(() => printerAction(host, row, 'resume'))
  const dismiss = run(async () => hub?.watch.dismiss(row.id, trip.kind ?? 'hand'))
  const look = run(again)
  const checkPlate = run(async () => {
    const r = await hub?.watch.plateCheck(row.id)
    if (r && !r.checked) toast('The plate check needs the camera and the watch running.', 'warn')
    else if (r?.clear) toast(heldStart(row.id) ? 'The plate looks clear now. Press Print again to start.' : 'The plate looks clear now.', 'ok')
  })
  const plateClear = run(async () => {
    askToNotify()
    await hub?.watch.plateClear(row.id)
    toast(`Saved the empty plate for ${row.name}. Later checks compare with it.`, 'ok')
  })
  const fine = run(async () => {
    const start = heldStart(row.id)
    await hub?.watch.plateIgnore(row.id)
    if (trip.state === 'blocked' && start) await start()
    else if (trip.state === 'paused') await printerAction(host, row, 'resume')
  })

  const monitor = trip.monitorOnly === true
  const pill = trip.state === 'alert' && !monitor ? { label: 'Not paused', tone: 'warn' as const } : STATE_PILL[trip.state]
  const actions =
    trip.kind === 'hand' ? (
      <>
        {trip.state === 'paused' ? (
          <Button variant="primary" icon="play" onClick={resume} disabled={busy}>
            Resume
          </Button>
        ) : (
          <Button icon="pause" disabled tip={monitor ? { title: `Developer Mode is off on ${row.name}` } : { title: 'The printer did not take the pause' }}>
            Pause
          </Button>
        )}
        <Button icon="camera" onClick={look} disabled={busy}>
          Check again
        </Button>
        <Button variant="ghost" onClick={dismiss} disabled={busy}>
          {trip.state === 'paused' ? 'Dismiss, it was me' : 'Dismiss'}
        </Button>
      </>
    ) : (
      <>
        {trip.state === 'alert' ? null : (
          <Button variant="primary" icon={trip.state === 'paused' ? 'play' : 'check'} onClick={fine} disabled={busy}>
            {trip.state === 'paused' ? "It's fine, resume" : heldStart(row.id) ? "It's fine, start anyway" : "It's fine"}
          </Button>
        )}
        <Button icon="refresh" onClick={checkPlate} disabled={busy}>
          Check again
        </Button>
        {trip.state === 'alert' ? (
          <Button variant="ghost" onClick={fine} disabled={busy}>
            {"It's fine"}
          </Button>
        ) : (
          <Button variant="ghost" onClick={plateClear} disabled={busy}>
            This plate is clear
          </Button>
        )}
      </>
    )

  const [l, t, r, b] = trip.box ?? [0.35, 0.3, 0.65, 0.7]
  return (
    <article ref={ref} className="guard-card" data-state={trip.state} data-kind={trip.kind} aria-labelledby={headingId} tabIndex={-1}>
      <div className="guard-frame">
        {url ? <img src={url} alt={`Camera picture of ${row.name} when the guard acted`} /> : <div className="guard-noframe">No picture from the camera</div>}
        {url ? (
          <div className="guard-spot" style={{ left: `${l * 100}%`, top: `${t * 100}%`, width: `${(r - l) * 100}%`, height: `${(b - t) * 100}%` }} data-marked={trip.box ? true : undefined}>
            <span className="guard-tag">{trip.kind === 'hand' ? 'Hand' : 'On the plate'}</span>
            <StrikeMark size={Math.round(Math.min(76, Math.max(44, (r - l) * 260)))} />
          </div>
        ) : null}
      </div>
      <div className="guard-body">
        <div className="guard-top">
          <b className="guard-name">{row.name}</b>
          <span className="guard-model">{row.model}</span>
          <Pill state={pill.tone}>{pill.label}</Pill>
        </div>
        <h3 id={headingId}>{copy.title}</h3>
        {copy.cannotStop ? (
          <p className="guard-banner" role="note">
            {copy.cannotStop}
          </p>
        ) : null}
        <p className="guard-text">{copy.body}</p>
        <p className="guard-stats">{statusLine(row, now)}</p>
        <div className="guard-acts">{actions}</div>
        {copy.note ? <p className="guard-note">{copy.note}</p> : null}
      </div>
    </article>
  )
}
