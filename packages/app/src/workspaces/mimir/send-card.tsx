// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The card that starts a print from the run's slice, in place of the approval card for the runtime's own printer.queue
// (docs/safety.md). It shows the printer, each filament's slot, the time, the grams used and the plate, runs the send preflight
// against the printer as it is now, and asks the bed question every time. Print turns on only with the tick, a passing
// preflight, a fresh slice, an idle or finished printer and a request that has not expired. Pressing Print writes the
// send ledger entry for this request, printer and file, so the guard skips its second card once, then approves with
// the bed clear. mimir cannot press it: the click handler is the only writer of the ledger. The run's send shows only
// when it hashes to the request's own upload action; it is a record, never a permission. Controls keep their size and
// place once answered; they only turn off. The agent bridge refuses the whole card (data-agent-refuse), as it refuses
// the approval dialog: only a person ticks the bed.
import { hashParams, type ApprovalRequest, type PrintRun, type RunSend } from '@slicerx/contracts'
import { STALE_SLICE } from '@slicerx/pilot'
import { fmtClock, fmtCountdown, type ApprovalCardProps } from '@slicerx/pilot/ui'
import { ASSISTANT_NAME } from '@slicerx/pilot/name'
import { Button, Icon, tipAttrs } from '@slicerx/ui'
import { useEffect, useState, type ReactNode } from 'react'
import { colorName } from '../../filament/rail'
import { useHost } from '../../host'
import { formatDuration } from '../../lib/preview-stats'
import { BED_CLEAR, sendPreflight, type SendCheck } from '../../plate/guard'
import { sendLedger } from '../../plate/send-ledger'
import { useApp } from '../../state/store'
import { plateFingerprint } from './print-run'

/**
 * The printer and file the request binds: the run's send, only when its printer, name and SHA-256 hash to the request's
 * own upload action. The run record alone is never trusted; undefined while the hash is worked out, null when it does
 * not match.
 */
function useBoundSend(request: ApprovalRequest, run: PrintRun | null | undefined): RunSend | null | undefined {
  const send = run?.send ?? null
  const upload = request.actions.find((a) => a.action === 'printer.upload')
  const [bound, setBound] = useState<{ key: string; send: RunSend | null } | null>(null)
  const key = send ? `${request.id}:${send.printerId}:${send.fileName}:${send.sha256}` : `${request.id}:none`
  useEffect(() => {
    if (!send || !upload || upload.target !== send.printerId) {
      setBound({ key, send: null })
      return undefined
    }
    let gone = false
    void hashParams({ printerId: send.printerId, name: send.fileName, sha256: send.sha256 }).then((h) => {
      if (!gone) setBound({ key, send: h === upload.paramsHash ? send : null })
    })
    return () => {
      gone = true
    }
  }, [key])
  return bound?.key === key ? bound.send : undefined
}

const isHex = (c: string | undefined): c is string => typeof c === 'string' && /^#?[0-9a-f]{6}([0-9a-f]{2})?$/i.test(c)

/** Each filament's slot: "Slot" for a plate on one filament, "Slot, filament 2" when there are more. */
function slotRows(send: RunSend, check: Pick<SendCheck, 'slots'> | null): [string, string][] {
  const list = Object.entries(send.slots)
    .map(([k, id]) => [Number(k), id] as const)
    .sort((a, b) => a[0] - b[0])
  return list.map(([n, id]) => {
    const slot = check?.slots.find((s) => s.id === id)
    const color = slot?.color
    const what = [slot?.material, isHex(color) ? colorName(color.startsWith('#') ? color.slice(0, 7) : `#${color.slice(0, 6)}`) : undefined].filter(Boolean)
    return [list.length === 1 ? 'Slot' : `Slot, filament ${n}`, [id, ...what].join(', ')]
  })
}

/**
 * The card's rows, label then value: the printer, each filament's slot, the time, the filament it uses and the plate
 * by its own name. The file's name stays out; it is the app's, not the person's.
 */
export function sendRows(send: RunSend, check: Pick<SendCheck, 'slots'> | null, printer: string, plate: string): [string, string][] {
  return [['Printer', printer], ...slotRows(send, check), ['Time', formatDuration(send.timeS)], ['Filament used', `${send.grams.toFixed(1)} g`], ['Plate', plate]]
}

/** A plate's own name, or "Plate 2" for one with none. */
export function plateName(plates: readonly { name?: string | undefined }[], n: number): string {
  return plates[n - 1]?.name?.trim() || `Plate ${n}`
}

/** What a card says when its answer could not be delivered. */
export const INACTIVE = `This card is no longer active. Ask ${ASSISTANT_NAME} to send it again.`

function resolvedText(r: NonNullable<ApprovalCardProps['resolution']>): { text: string; ok: boolean } {
  if (r.decision.kind === 'approve') return { text: `Print approved by you at ${fmtClock(r.at)}`, ok: true }
  if (r.by === 'expiry' || r.decision.reason === 'expired') return { text: 'Expired, nothing was sent', ok: false }
  return { text: 'Not sent', ok: false }
}

export function SendCard({ request, resolution, actionable, onApprove, onCancel, run }: ApprovalCardProps) {
  const host = useHost()
  const send = useBoundSend(request, run)
  const file = send ? { printerId: send.printerId, name: send.fileName, sha256: send.sha256 } : null
  const pending = resolution === null
  // an answer the app could not deliver: the card's request is gone, so the card stops taking answers
  const [inactive, setInactive] = useState(false)
  const live = pending && actionable && !inactive
  // the bed question starts unticked on every card, with nothing remembered from the last one
  const [bed, setBed] = useState(false)
  const [check, setCheck] = useState<SendCheck | null>(null)
  const [answering, setAnswering] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const expiresAt = Date.parse(request.expiresAt)
  const left = Number.isNaN(expiresAt) ? 0 : expiresAt - now
  const expired = left <= 0
  // the slice's plate as it is now, as the slice card reads it: the run the card was drawn with may be older than an edit
  const fingerprintNow = useApp((s) => plateFingerprint(s, run?.slice?.plate ?? 1))
  const plate = useApp((s) => plateName(s.plates, run?.slice?.plate ?? 1))

  // the preflight against the printer as it is now: when the card shows, and again when the bed is ticked
  useEffect(() => {
    if (!live || !file || !host.printers) return undefined
    // Print never stays on against an older reading while this one runs
    setCheck(null)
    let gone = false
    sendPreflight(host.printers, file.printerId, file).then(
      (c) => {
        if (!gone) setCheck(c)
      },
      (e: unknown) => {
        if (!gone) setCheck({ facts: [], errors: [`The printer check did not finish: ${e instanceof Error ? e.message : String(e)}`], warnings: [], busy: null, developerMode: null, printerName: file.printerId, slots: [] })
      },
    )
    return () => {
      gone = true
    }
  }, [live, bed, host.printers, request.id, file?.sha256])

  useEffect(() => {
    if (!live) return undefined
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [live])

  const stale = run?.slice ? run.slice.stale === true || run.slice.fingerprint !== fingerprintNow : false
  const name = check?.printerName ?? file?.printerId ?? request.printerId ?? 'the printer'
  const passed = check !== null && check.errors.length === 0 && check.busy === null && check.developerMode === null
  const canPrint = live && file !== null && bed && passed && !stale && !expired && !answering

  // no internal reason or id reaches the person: the card is over, and asking again makes a new one
  const fail = (): void => {
    setAnswering(false)
    setInactive(true)
    setNote(INACTIVE)
  }
  const print = (): void => {
    if (!canPrint || !file) return
    // the one writer of the ledger: this click, for this request, printer and file
    sendLedger.mark(request.id, file.printerId, file.sha256, request.expiresAt)
    setAnswering(true)
    onApprove(request, { bedClear: true }).catch(fail)
  }
  const notNow = (): void => {
    if (!live || answering) return
    setAnswering(true)
    onCancel(request).catch(fail)
  }

  const rows: [string, string][] = send ? sendRows(send, check, name, plate) : [['Printer', name]]

  const problems: ReactNode[] = []
  if (live && stale) problems.push(<li key="stale">{STALE_SLICE}</li>)
  if (live && send === null) problems.push(<li key="file">The file for this request could not be matched, so Print stays off.</li>)
  if (live && check) for (const [i, e] of check.errors.entries()) problems.push(<li key={`e${i}`}>{e}</li>)

  const done = resolution ? resolvedText(resolution) : null
  const status = done
    ? done.text
    : !actionable
      ? 'No answer'
      : (note ??
        (expired
          ? 'Expired, nothing was sent'
          : check === null && send !== null
            ? `Checking ${name}`
            : !passed || stale
              ? `Print stays off. Expires in ${fmtCountdown(left)}`
              : !bed
                ? `Tick the bed check to print. Expires in ${fmtCountdown(left)}`
                : `Expires in ${fmtCountdown(left)}`))

  return (
    <div className="lookup-rec sheet-rec send-rec" role="group" aria-label={`${ASSISTANT_NAME} asks: Print on ${name}?`} data-testid="mimir-send" data-agent-refuse data-request-id={request.id} data-state={done ? (done.ok ? 'approved' : 'closed') : canPrint ? 'ready' : 'off'}>
      <div className="sheet-rec-head">
        <span className="lookup-rec-t" {...tipAttrs({ title: `${ASSISTANT_NAME} asks to print`, body: `Only you can start this print. ${ASSISTANT_NAME} can't tick the bed check or press Print.` })}>
          <Icon name="send-to-printer" />
          <span>Print on {name}?</span>
        </span>
      </div>
      <ul className="sheet-rec-rows">
        {rows.map(([k, v], i) => (
          <li key={`${i}-${k}`} className="sheet-rec-row send-rec-row" data-row={k}>
            <span className="sheet-rec-label">{k}</span>
            <span className="sheet-rec-v send-rec-v">{v}</span>
          </li>
        ))}
      </ul>
      {!send && request.lines.length ? (
        <ul className="plan-rec-notes send-rec-lines">
          {request.lines.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      ) : null}
      {problems.length ? (
        <ul className="send-rec-errors" data-testid="mimir-send-errors">
          {problems}
        </ul>
      ) : null}
      {live && check?.developerMode ? (
        <div className="send-rec-dev" data-testid="mimir-send-dev">
          {check.developerMode.map((r, i) => (
            <section key={r.id} className="send-rec-remedy">
              <span className="plan-rec-h">{i === 0 ? r.title : `Or: ${r.title}`}</span>
              <ul className="plan-rec-notes">
                {r.steps.map((s, k) => (
                  <li key={k}>{s}</li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      ) : null}
      {live && check?.warnings.length ? (
        <ul className="send-rec-warnings">
          {check.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      ) : null}
      {actionable ? (
        <label className="send-rec-bed">
          <input type="checkbox" data-testid="mimir-send-bed" checked={bed} disabled={!live || answering} onChange={(e) => setBed(e.target.checked)} />
          <span>{BED_CLEAR}</span>
        </label>
      ) : null}
      <span className="sheet-rec-foot send-rec-foot">
        <span className="lookup-rec-s" data-testid="mimir-send-status" aria-live="polite">
          {done?.ok ? <Icon name="check" size={14} /> : null}
          {status}
        </span>
        {actionable ? (
          <>
            <Button size="sm" variant="ghost" disabled={!live || answering} data-testid="mimir-send-cancel" onClick={notNow}>
              Not now
            </Button>
            <Button size="sm" variant="primary" icon="play" disabled={!canPrint} data-testid="danger-mimir-send-print" onClick={print}>
              Print
            </Button>
          </>
        ) : null}
      </span>
    </div>
  )
}
