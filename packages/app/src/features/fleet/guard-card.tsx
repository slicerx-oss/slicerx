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
import { askToNotify, fitFrame, guardHub, heldStart, placeBox, takeFocus, tripCopy, type FrameRect, type GuardTrip } from './guard'
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

/** A rectangle of the frame as CSS percentages. */
const pct = ([l, t, w, h]: FrameRect) => ({ left: `${+(l * 100).toFixed(4)}%`, top: `${+(t * 100).toFixed(4)}%`, width: `${+(w * 100).toFixed(4)}%`, height: `${+(h * 100).toFixed(4)}%` })

/** The spot the guard found, bracketed, with the strike at its center. `at` is its place in the frame. */
function Spot({ at, label }: { at: FrameRect; label: string }) {
  return (
    <div className="guard-spot" style={pct(at)}>
      <span className="guard-tag">{label}</span>
      <StrikeMark size={Math.round(Math.min(76, Math.max(44, at[2] * 260)))} />
    </div>
  )
}

export function GuardCard({ row, trip, now }: { row: FleetRow; trip: GuardTrip; now: number }) {
  const host = useHost()
  const hub = guardHub(host)
  const copy = tripCopy(trip, row.name)
  const { url, again } = useEvidence(row.id, trip.at)
  const ref = useRef<HTMLElement>(null)
  const [busy, setBusy] = useState(false)
  const [broken, setBroken] = useState('')
  const [fit, setFit] = useState<FrameRect>(() => fitFrame(0, 0))
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
  // Resume on this card is the person's approval for this pause: the hub resumes it without a second
  // card. A hub without that call falls back to the usual approval.
  const resumeNow = async () => {
    if (hub && typeof hub.watch.resume === 'function') {
      await hub.watch.resume(row.id)
      toast(`Resumed on ${row.name}`, 'ok')
    } else await printerAction(host, row, 'resume')
  }
  const resume = run(resumeNow)
  const dismiss = run(async () => hub?.watch.dismiss(row.id, trip.kind ?? 'hand'))
  const look = run(async () => {
    if (!hub || typeof hub.watch.handCheck !== 'function') return again()
    const r = await hub.watch.handCheck(row.id)
    await again()
    if (!r.checked) toast('New picture taken. The watch is not running, so nothing looked at it.', 'warn')
    else if (r.hand) toast('There is still a hand in the new picture. The print stays paused.', 'warn')
    else toast('No hand in the new picture. Resume when you are ready.', 'ok')
  })
  const checkPlate = run(async () => {
    const r = await hub?.watch.plateCheck(row.id)
    if (r && !r.checked) toast('The plate check needs the camera and the watch running.', 'warn')
    else if (r?.clear) toast(heldStart(row.id) ? 'The plate looks clear now. Press Print again to start.' : 'The plate looks clear now.', 'ok')
  })
  const plateClear = run(async () => {
    askToNotify()
    // The hub takes a new picture now, after this click; the one that held the start is never kept.
    const start = heldStart(row.id)
    await hub?.watch.plateClear(row.id)
    toast(`Saved the empty plate for ${row.name}. Later checks compare with it.`, 'ok', start ? { label: 'Start the print', run: () => void start().catch((e) => toast(e instanceof Error ? e.message : 'The print did not start', 'error')) } : undefined)
  })
  const fine = run(async () => {
    const start = heldStart(row.id)
    await hub?.watch.plateIgnore(row.id)
    if (trip.state === 'blocked' && start) await start()
    else if (trip.state === 'paused') await resumeNow()
  })

  const monitor = trip.monitorOnly === true
  // Every way out of a paused card ends in Resume: the printer is a machine, and only a person's
  // click starts it moving again. Answers (Dismiss, a clean check) keep the card and its Resume.
  const resumeButton = (
    <Button variant="primary" icon="play" onClick={resume} disabled={busy}>
      Resume
    </Button>
  )
  const checkButton = (
    <Button icon={trip.kind === 'hand' ? 'camera' : 'refresh'} onClick={trip.kind === 'hand' ? look : checkPlate} disabled={busy}>
      Check again
    </Button>
  )
  const pill = trip.state === 'alert' && !monitor ? { label: 'Not paused', tone: 'warn' as const } : STATE_PILL[trip.state]
  const actions =
    trip.state === 'paused' && trip.answered ? (
      <>
        {resumeButton}
        {checkButton}
      </>
    ) : trip.kind === 'hand' ? (
      <>
        {trip.state === 'paused' ? (
          resumeButton
        ) : (
          <Button icon="pause" disabled tip={monitor ? { title: `Developer Mode is off on ${row.name}` } : { title: 'The printer did not take the pause' }}>
            Pause
          </Button>
        )}
        {checkButton}
        <Button variant="ghost" onClick={dismiss} disabled={busy}>
          {trip.state === 'paused' ? 'Dismiss, it was me' : 'Dismiss'}
        </Button>
      </>
    ) : trip.state === 'paused' ? (
      <>
        <Button variant="primary" icon="play" onClick={fine} disabled={busy}>
          {"It's fine, resume"}
        </Button>
        {checkButton}
      </>
    ) : trip.state === 'alert' ? (
      <>
        {checkButton}
        <Button variant="ghost" onClick={fine} disabled={busy}>
          {"It's fine"}
        </Button>
      </>
    ) : (
      <>
        <Button variant="primary" icon="check" onClick={fine} disabled={busy}>
          {heldStart(row.id) ? "It's fine, start anyway" : "It's fine"}
        </Button>
        {checkButton}
        <Button variant="ghost" onClick={plateClear} disabled={busy}>
          This plate is clear
        </Button>
      </>
    )

  // The pill and the title already say what happened; the line adds the job and layer of a print on the
  // plate, and nothing for an idle printer, whose line would call a plate the guard flagged clear.
  const running = row.status.state === 'printing' || row.status.state === 'paused' || row.status.state === 'preparing'
  const stats = running ? statusLine(row, now).replace(/^Paused( · )?/, '') : ''
  const shown = Boolean(url) && broken !== url
  // A clean look found nothing: no spot, no badge, only the new picture.
  const marked = shown && !(trip.answered && trip.answeredBy === 'clear')
  return (
    <article ref={ref} className="guard-card" data-state={trip.state} data-kind={trip.kind} aria-labelledby={headingId} tabIndex={-1}>
      <div className="guard-frame">
        {shown ? (
          <img
            className="guard-pic"
            style={pct(fit)}
            src={url}
            alt={`Camera picture of ${row.name} when the guard acted`}
            onError={() => setBroken(url)}
            onLoad={(e) => setFit(fitFrame(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight))}
          />
        ) : (
          <div className="guard-noframe">No picture from the camera</div>
        )}
        {marked && trip.box ? <Spot at={placeBox(trip.box, fit)} label={trip.kind === 'hand' ? 'Hand' : 'On the plate'} /> : null}
        {/* No spot to mark: a badge in the corner, so the strike never sits on nothing. */}
        {marked && !trip.box ? (
          <div className="guard-badge">
            <StrikeMark size={26} pulse={false} />
            <span>{trip.kind === 'hand' ? 'Hand seen' : 'Something on the plate'}</span>
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
        {stats ? <p className="guard-stats">{stats}</p> : null}
        <div className="guard-acts">{actions}</div>
        {copy.note ? <p className="guard-note">{copy.note}</p> : null}
      </div>
    </article>
  )
}
