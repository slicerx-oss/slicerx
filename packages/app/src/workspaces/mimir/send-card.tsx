// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The card that starts a print from the run's slice, in place of the approval card for the runtime's own printer.queue
// (docs/safety.md). It asks "<Part> ready. Send it to <printer>?", shows the time, the grams used and the plate, and a
// strip of the printer's spools as the printer reports them now (each slot with its material and color; an empty slot
// says so and can't be picked). On a plate of one filament the person picks the spool; on more, each filament keeps the
// slot it was sliced for. It runs the send preflight against the printer as it is now and asks the bed question every
// time. The slide turns on only with a spool picked, the tick, a passing preflight, a fresh slice, an idle or finished
// printer and a request that has not expired: the same reasons that kept Print off. Completing the slide writes the
// send ledger entry for the request the answer grants, printer and file, so the guard skips its second card once, then
// approves with the bed clear and the picked spool. mimir cannot do it: this handler is the only writer of the ledger.
// The run's send shows only when it hashes to the request's own upload action; it is a record, never a permission.
// After the answer the slide says Sending, then Sent once the printer took the job. Controls keep their size and place
// once answered; they only turn off. The agent bridge refuses the whole card (data-agent-refuse), as it refuses the
// approval dialog: only a person picks the spool, ticks the bed and slides.
import { hashParams, pickedRequestId, type ApprovalRequest, type PrintRun, type RunSend } from '@slicerx/contracts'
import { STALE_SLICE } from '@slicerx/pilot'
import { fmtClock, fmtCountdown, type ApprovalCardProps } from '@slicerx/pilot/ui'
import { ASSISTANT_NAME } from '@slicerx/pilot/name'
import { Button, Icon, SwatchRing, tipAttrs } from '@slicerx/ui'
import { QueryClientContext } from '@tanstack/react-query'
import { useContext, useEffect, useState, type ReactNode } from 'react'
import { colorName } from '../../filament/rail'
import { useHost } from '../../host'
import { useFleet, type FleetRow } from '../../lib/queries'
import { formatDuration } from '../../lib/preview-stats'
import { BED_CLEAR, sendPreflight, type SendCheck } from '../../plate/guard'
import { sendLedger } from '../../plate/send-ledger'
import { useApp } from '../../state/store'
import { plateFingerprint } from './print-run'
import { pickedLine, slotLabel, spoolUnits, stripHead, type SpoolChip } from './send-spools'
import { CHIP_NAME, CHOOSE_MATERIAL, EMPTY_SLOT, FILE_UNMATCHED, NOT_SENT_TO, ONLY_YOU, OTHER_MATERIAL, PICK_AND_TICK, PICK_TO_PRINT, PRINT_NOW, SEND_TITLE, SENDING, SENT, SLIDE_STAYS_OFF, SLOTS_IN_USE, TICK_TO_PRINT } from './send-words'
import { SlideToPrint, type SlideState } from './slide-to-print'

/** A number for each printers host the card has seen, so a new host makes the last reading old. */
const hosts = new WeakMap<object, number>()
let seen = 0
function printersRev(p: object | undefined): number {
  if (!p) return 0
  let n = hosts.get(p)
  if (n === undefined) hosts.set(p, (n = ++seen))
  return n
}

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
 * The card's rows, label then value: the time, the filament it uses and the plate by its own name. The printer is in
 * the question and the slots are on the spool strip. The file's name stays out; it is the app's, not the person's.
 */
export function sendRows(send: RunSend, plate: string): [string, string][] {
  return [['Time', formatDuration(send.timeS)], ['Filament used', `${send.grams.toFixed(1)} g`], ['Plate', plate]]
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

/**
 * Where the slide is: off or ready while the card waits, sending from the person's answer until the printer took the
 * job (`outcome`), then sent, or failed when the send did not go through.
 */
export function slideState(p: { done: { ok: boolean } | null; outcome: ApprovalCardProps['outcome']; answering: boolean; canPrint: boolean }): SlideState {
  if (p.done) return p.done.ok ? (p.outcome ? (p.outcome.ok ? 'sent' : 'failed') : 'sending') : 'off'
  if (p.answering) return 'sending'
  return p.canPrint ? 'ready' : 'off'
}

/** One spool on the strip: its slot, its spool in its color, the material and the color in words. */
function Chip({ chip, on, pickable, disabled, material, onPick }: { chip: SpoolChip; on: boolean; pickable: boolean; disabled: boolean; material: string | null; onPick: (id: string) => void }) {
  const words = chip.empty ? EMPTY_SLOT : [chip.material, chip.colorWord].filter(Boolean).join(' ')
  const why = chip.other && material ? OTHER_MATERIAL(material) : undefined
  return (
    <button
      type="button"
      className="send-chip"
      data-testid="mimir-send-spool"
      data-slot={chip.id}
      data-on={on || undefined}
      data-empty={chip.empty || undefined}
      data-other={chip.other || undefined}
      data-feeds={chip.feeds}
      aria-pressed={pickable ? on : undefined}
      aria-label={CHIP_NAME(slotLabel(chip.id), words)}
      disabled={disabled || !pickable || chip.empty || chip.other}
      onClick={() => onPick(chip.id)}
      {...(why ? tipAttrs({ title: why }) : {})}
    >
      <span className="send-chip-n">{chip.mark}</span>
      <span className="send-chip-check" aria-hidden="true">
        {chip.feeds !== undefined ? <span className="send-chip-feed">{chip.feeds}</span> : on ? <Icon name="check" size={12} /> : null}
      </span>
      <span className="send-chip-spool" aria-hidden="true">
        {chip.empty ? <Icon name="spool-empty" size={24} /> : <SwatchRing color={chip.color} size={32} selected={on} />}
      </span>
      <span className="send-chip-m">{chip.empty ? EMPTY_SLOT : chip.material}</span>
      <span className="send-chip-c">{chip.empty ? '' : chip.colorWord}</span>
    </button>
  )
}

/** The card with the printer's live row from the fleet (the Printers workspace's reading), when the app holds one. */
function WithFleet(props: ApprovalCardProps) {
  const id = props.run?.send?.printerId ?? props.request.printerId
  const row = useFleet().data?.find((r) => r.id === id)
  return <SendCardView {...props} row={row} />
}

export function SendCard(props: ApprovalCardProps) {
  // the fleet is read where the app keeps one (the mimir tab); a card drawn without it reads the slots from the preflight
  return useContext(QueryClientContext) ? <WithFleet {...props} /> : <SendCardView {...props} row={undefined} />
}

function SendCardView({ request, resolution, actionable, onApprove, onCancel, run, outcome, row }: ApprovalCardProps & { row: FleetRow | undefined }) {
  const host = useHost()
  const send = useBoundSend(request, run)
  const file = send ? { printerId: send.printerId, name: send.fileName, sha256: send.sha256 } : null
  const pending = resolution === null
  // an answer the app could not deliver: the card's request is gone, so the card stops taking answers
  const [inactive, setInactive] = useState(false)
  const live = pending && actionable && !inactive
  // the bed question starts unticked on every card, with nothing remembered from the last one; so does the spool
  const [bed, setBed] = useState(false)
  const [pick, setPick] = useState<string | null>(null)
  // the last preflight reading and what it was made for. It stays on the card while a new one runs, so the rows and lines
  // keep their place; the slide reads only a reading made for the card as it is now (`fresh`), never an older one
  const [reading, setReading] = useState<{ for: string; check: SendCheck } | null>(null)
  const [answering, setAnswering] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const expiresAt = Date.parse(request.expiresAt)
  const left = Number.isNaN(expiresAt) ? 0 : expiresAt - now
  const expired = left <= 0
  // the slice's plate as it is now, as the slice card reads it: the run the card was drawn with may be older than an edit
  const fingerprintNow = useApp((s) => plateFingerprint(s, run?.slice?.plate ?? 1))
  const plate = useApp((s) => plateName(s.plates, run?.slice?.plate ?? 1))
  // the part by its own name when it is alone on the plate, else the plate's
  const part = useApp((s) => (s.plate.length === 1 ? s.plate[0]!.name.trim() || null : null)) ?? plate
  // what a reading must be made for to count: the card as it is in this render, so the render that ticks the bed or
  // picks a spool already reads the last one as old
  const readingFor = `${live}:${bed}:${pick ?? ''}:${printersRev(host.printers)}:${request.id}:${file?.sha256 ?? ''}`
  const check = reading?.check ?? null
  const fresh = reading?.for === readingFor ? reading.check : null

  // the preflight against the printer as it is now: when the card shows, and again when the bed is ticked or a spool picked
  useEffect(() => {
    if (!live || !file || !host.printers) return undefined
    let gone = false
    const made = (c: SendCheck): void => {
      if (!gone) setReading({ for: readingFor, check: c })
    }
    sendPreflight(host.printers, file.printerId, file).then(made, (e: unknown) => made({ facts: [], errors: [`The printer check did not finish: ${e instanceof Error ? e.message : String(e)}`], warnings: [], busy: null, developerMode: null, printerName: file.printerId, slots: [] }))
    return () => {
      gone = true
    }
  }, [readingFor])

  useEffect(() => {
    if (!live) return undefined
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [live])

  const stale = run?.slice ? run.slice.stale === true || run.slice.fingerprint !== fingerprintNow : false
  const name = check?.printerName ?? row?.name ?? file?.printerId ?? request.printerId ?? 'the printer'

  // the strip: the printer's slots as it reports them, live from the fleet, else from the last preflight; the send's
  // slot per filament marks the ones in use
  const slots = row?.status.slots ?? check?.slots ?? []
  const feeds = send?.slots ?? {}
  const feedKeys = Object.keys(feeds)
  const current = feedKeys.length === 1 ? (feeds[Number(feedKeys[0])] ?? null) : null
  // what the plate was sliced for: the material of the slot the send matched, as the printer reports it
  const material = current ? (slots.find((s) => s.id === current)?.material ?? null) : null
  const units = feedKeys.length ? spoolUnits(slots, row?.status.live, row?.model ?? '', material, feeds) : []
  const chips = units.flatMap((u) => u.chips)
  const head = stripHead(units, row?.model || name)
  // one filament on a printer that reports its spools: the person picks the spool
  const needsPick = current !== null && chips.length > 0
  const picked = pick ? (chips.find((c) => c.id === pick && !c.empty && !c.other) ?? null) : null
  const done = resolution ? resolvedText(resolution) : null
  // once answered, the slot the send went from (the run records the picked one)
  const shownPick = picked?.id ?? (done ? current : null)
  const shownChip = shownPick ? (chips.find((c) => c.id === shownPick) ?? null) : null

  const pickOk = !needsPick || (picked !== null && fresh !== null && fresh.slots.some((s) => s.id === picked.id && s.material))
  const passed = fresh !== null && fresh.errors.length === 0 && fresh.busy === null && fresh.developerMode === null
  const canPrint = live && file !== null && bed && passed && pickOk && !stale && !expired && !answering

  // no internal reason or id reaches the person: the card is over, and asking again makes a new one
  const fail = (): void => {
    setAnswering(false)
    setInactive(true)
    setNote(INACTIVE)
  }
  const print = (): void => {
    if (!canPrint || !file) return
    // a spool other than the one the request sends from goes with the answer, and the runtime grants the request it makes
    // for that spool, so the ledger entry is that request's
    const filament = feedKeys[0]
    const slotMap = needsPick && picked && picked.id !== current && filament !== undefined ? { [String(Number(filament) - 1)]: picked.id } : undefined
    // the one writer of the ledger: this answer, for this request, printer and file
    sendLedger.mark(slotMap ? pickedRequestId(request.id) : request.id, file.printerId, file.sha256, request.expiresAt)
    setAnswering(true)
    onApprove(request, slotMap ? { bedClear: true, slotMap } : { bedClear: true }).catch(fail)
  }
  const notNow = (): void => {
    if (!live || answering) return
    setAnswering(true)
    onCancel(request).catch(fail)
  }

  const rows: [string, string][] = send ? [...(chips.length ? [] : slotRows(send, check)), ...sendRows(send, plate)] : []

  const problems: ReactNode[] = []
  if (live && stale) problems.push(<li key="stale">{STALE_SLICE}</li>)
  if (live && send === null) problems.push(<li key="file">{FILE_UNMATCHED}</li>)
  if (live && check) for (const [i, e] of check.errors.entries()) problems.push(<li key={`e${i}`}>{e}</li>)

  const slide = slideState({ done, outcome, answering: answering && !inactive, canPrint })
  const expires = `Expires in ${fmtCountdown(left)}`
  const status = done
    ? slide === 'failed' && outcome
      ? outcome.summary
      : done.text
    : !actionable
      ? 'No answer'
      : (note ??
        (expired
          ? 'Expired, nothing was sent'
          : fresh === null && send !== null
            ? `Checking ${name}`
            : !passed || stale
              ? `${SLIDE_STAYS_OFF} ${expires}`
              : needsPick && !picked
                ? `${bed ? PICK_TO_PRINT : PICK_AND_TICK} ${expires}`
                : !bed
                  ? `${TICK_TO_PRINT} ${expires}`
                  : expires))
  const title = SEND_TITLE(part, name)
  const slideLabel = slide === 'sent' ? SENT(name) : slide === 'failed' ? NOT_SENT_TO(name) : SENDING(name)

  return (
    <div className="lookup-rec sheet-rec send-rec" role="group" aria-label={`${ASSISTANT_NAME} asks: ${title}`} data-testid="mimir-send" data-agent-refuse data-request-id={request.id} data-state={done ? (done.ok ? 'approved' : 'closed') : canPrint ? 'ready' : 'off'} data-send={slide === 'sending' || slide === 'sent' || slide === 'failed' ? slide : undefined}>
      <div className="sheet-rec-head">
        <span className="send-rec-title" data-testid="mimir-send-title" {...tipAttrs(ONLY_YOU())}>
          {title}
        </span>
      </div>
      {rows.length ? (
        <ul className="sheet-rec-rows">
          {rows.map(([k, v], i) => (
            <li key={`${i}-${k}`} className="sheet-rec-row send-rec-row" data-row={k}>
              <span className="sheet-rec-label">{k}</span>
              <span className="sheet-rec-v send-rec-v">{v}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {!send && request.lines.length ? (
        <ul className="plan-rec-notes send-rec-lines">
          {request.lines.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      ) : null}
      {chips.length ? (
        <div className="send-strip" data-testid="mimir-send-spools">
          <div className="send-strip-head">
            <span className="send-strip-where">
              <span className="send-strip-unit">{head.units}</span>
              <span className="send-strip-sep" aria-hidden="true">
                /
              </span>
              <span className="send-strip-printer">{head.printer}</span>
            </span>
            <span className="send-strip-pick" data-testid="mimir-send-pick" data-on={shownChip ? true : undefined} aria-live="polite">
              {needsPick ? (shownChip ? pickedLine(shownChip) : CHOOSE_MATERIAL) : SLOTS_IN_USE(Object.values(feeds).map(slotLabel))}
            </span>
          </div>
          <div className="send-strip-chips">
            {chips.map((c) => (
              <Chip key={c.id} chip={c} on={needsPick ? c.id === shownPick : c.feeds !== undefined} pickable={needsPick} disabled={!live || answering} material={material} onPick={setPick} />
            ))}
          </div>
        </div>
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
          <input type="checkbox" data-testid="mimir-send-bed" checked={bed || (done?.ok ?? false)} disabled={!live || answering} onChange={(e) => setBed(e.target.checked)} />
          <span>{BED_CLEAR}</span>
        </label>
      ) : null}
      {actionable || done?.ok ? <SlideToPrint state={slide} printer={name} label={slideLabel} endLabel={PRINT_NOW(name)} onComplete={print} /> : null}
      <span className="sheet-rec-foot send-rec-foot">
        <span className="lookup-rec-s" data-testid="mimir-send-status" aria-live="polite">
          {status}
        </span>
        {actionable ? (
          <Button size="sm" variant="ghost" disabled={!live || answering} data-testid="mimir-send-cancel" onClick={notNow}>
            Not now
          </Button>
        ) : null}
      </span>
    </div>
  )
}
