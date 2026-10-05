// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// One printer's controls: move the head, the printer's own files and print history, what it reports as
// wrong, and skipping objects of the running print. Opens from the printer card; loaded on first open.
import { Button, Dialog, Pill } from '@slicerx/ui'
import { useEffect, useState } from 'react'
import type { PrinterInfo, PrinterStatus } from '@slicerx/contracts'
import { useHost } from '../../host'
import { toast, useApp } from '../../state/store'
import {
  bedKnownClear, deviceError, deviceHub, filamentText, JOG_STEPS_MM, jogBlockedReason, pauseNoteOf, recordDuration, SEVERITY_LABEL, splitIssues, startBlockedReason, startStored,
  type DeviceHub, type PrintObject, type PrintRecord, type PrinterIssue, type StoredFile,
} from './device'
import { appName } from '../../edition'

type Tab = 'move' | 'files' | 'history' | 'problems' | 'skip'

const when = (s: number | undefined) => (s ? new Date(s * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '')
const size = (n: number | undefined) => (n === undefined ? '' : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`)

/** Loads one list from the hub, once per open tab. */
function useList<T>(load: (() => Promise<T[]>) | null, key: string): { rows: T[]; error: string | null; busy: boolean; reload: () => void } {
  const [rows, setRows] = useState<T[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [n, setN] = useState(0)
  useEffect(() => {
    if (!load) return
    let live = true
    setBusy(true)
    load().then(
      (r) => live && (setRows(r), setError(null), setBusy(false)),
      (e: unknown) => live && (setRows([]), setError(deviceError(e)), setBusy(false)),
    )
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, n])
  return { rows, error, busy, reload: () => setN((x) => x + 1) }
}

export function DeviceDialog({ printer, status, onClose }: { printer: PrinterInfo; status: PrinterStatus; onClose: () => void }) {
  const host = useHost()
  const hub = deviceHub(host)
  const running = status.state === 'printing' || status.state === 'paused'
  const [tab, setTab] = useState<Tab>(running ? 'skip' : 'move')
  const tabs: [Tab, string][] = [['move', 'Move'], ['files', 'Files'], ['history', 'History'], ['problems', 'Problems'], ...(running ? ([['skip', 'Skip objects']] as [Tab, string][]) : [])]
  return (
    <Dialog open onClose={onClose} title={`${printer.name}: controls and files`} footer={<Button variant="primary" onClick={onClose}>Close</Button>}>
      {pauseNoteOf(status) ? <p className="sx-small warn" role="note">{pauseNoteOf(status)}</p> : null}
      {!hub ? (
        <p className="sx-small sx-muted">Connect the {appName()} link to use these. They are only available from the app on your own network.</p>
      ) : (
        <>
          <nav className="groups" aria-label="Device sections">
            {tabs.map(([id, label]) => (
              <button key={id} type="button" className="cat" aria-pressed={tab === id} onClick={() => setTab(id)}>
                {label}
              </button>
            ))}
          </nav>
          {tab === 'move' ? <Move hub={hub} printer={printer} status={status} /> : null}
          {tab === 'files' ? <Files hub={hub} printer={printer} status={status} /> : null}
          {tab === 'history' ? <History hub={hub} printer={printer} /> : null}
          {tab === 'problems' ? <Problems hub={hub} printer={printer} status={status} /> : null}
          {tab === 'skip' ? <Skip hub={hub} printer={printer} status={status} /> : null}
        </>
      )}
    </Dialog>
  )
}

function Move({ hub, printer, status }: { hub: DeviceHub; printer: PrinterInfo; status: PrinterStatus }) {
  const [step, setStep] = useState<number>(1)
  const [busy, setBusy] = useState(false)
  const blocked = jogBlockedReason(status.state)
  const go = async (axis: 'x' | 'y' | 'z', sign: 1 | -1) => {
    setBusy(true)
    try {
      await hub.device.jog(printer.id, axis, sign * step)
    } catch (e) {
      toast(deviceError(e), 'error')
    } finally {
      setBusy(false)
    }
  }
  const btn = (axis: 'x' | 'y' | 'z', sign: 1 | -1, label: string) => (
    <Button size="sm" disabled={busy || blocked !== null} onClick={() => void go(axis, sign)} aria-label={`Move ${axis.toUpperCase()} ${sign > 0 ? 'plus' : 'minus'} ${step} mm`}>
      {label}
    </Button>
  )
  return (
    <section aria-label="Move the head">
      <p className="sx-small">Moves the head by hand, 0.1 to 10 mm a step. Home the printer first if it refuses.</p>
      <div className="calib-act" role="group" aria-label="Step size">
        {JOG_STEPS_MM.map((s) => (
          <Button key={s} size="sm" variant={step === s ? 'primary' : 'ghost'} aria-pressed={step === s} onClick={() => setStep(s)}>
            {s} mm
          </Button>
        ))}
      </div>
      <div className="calib-act">
        {btn('x', -1, 'X -')}
        {btn('x', 1, 'X +')}
        {btn('y', -1, 'Y -')}
        {btn('y', 1, 'Y +')}
        {btn('z', -1, 'Z -')}
        {btn('z', 1, 'Z +')}
      </div>
      {blocked ? <p className="sx-small warn">{blocked}</p> : null}
    </section>
  )
}

function Files({ hub, printer, status }: { hub: DeviceHub; printer: PrinterInfo; status: PrinterStatus }) {
  const files = useList<StoredFile>(() => hub.device.files(printer.id), printer.id)
  const [pending, setPending] = useState<{ file: StoredFile; bedClear: boolean; unverifiedOk: boolean; ask: 'bed' | 'unverified' | null } | null>(null)
  const blocked = startBlockedReason(status.state)
  const attempt = async (file: StoredFile, bedClear: boolean, unverifiedOk: boolean) => {
    // The Print sheet's bed rule: a plate the hub knows is clear needs no statement.
    const clear = bedClear || (await bedKnownClear(hub, printer.id))
    const a = await startStored(hub, printer.id, file.path, { bedClear: clear, unverifiedOk })
    if (a.kind === 'started') {
      setPending(null)
      toast(`Started ${file.name} on ${printer.name}`, 'ok')
    } else if (a.kind === 'ask-bed') setPending({ file, bedClear: false, unverifiedOk, ask: 'bed' })
    else if (a.kind === 'ask-unverified') setPending({ file, bedClear: clear, unverifiedOk: false, ask: 'unverified' })
    else {
      setPending(null)
      toast(a.message, 'error')
    }
  }
  return (
    <section aria-label="Files on the printer">
      {files.error ? <p className="sx-small warn">{files.error}</p> : null}
      {!files.error && !files.busy && files.rows.length === 0 ? <p className="sx-small sx-muted">No files on the printer.</p> : null}
      <ul className="recent-projects">
        {files.rows.map((f) => (
          <li key={f.path}>
            <button type="button" disabled={blocked !== null} onClick={() => void attempt(f, false, false)}>
              <b>{f.name}</b>
              <small>{[size(f.size), when(f.modified)].filter(Boolean).join(', ')}</small>
            </button>
          </li>
        ))}
      </ul>
      {blocked ? <p className="sx-small sx-muted">{blocked}</p> : null}
      {pending ? (
        <div role="alertdialog" aria-label="Confirm print" className="calib-act">
          <p className="sx-small">
            {pending.ask === 'bed'
              ? `Is the build plate clear? Starting ${pending.file.name} heats and moves the printer.`
              : `${pending.file.name} did not go up through ${appName()}, so its contents cannot be checked. Print it anyway?`}
          </p>
          <Button variant="primary" onClick={() => void attempt(pending.file, pending.ask === 'bed' ? true : pending.bedClear, pending.ask === 'unverified' ? true : pending.unverifiedOk)}>
            {pending.ask === 'bed' ? 'Plate is clear, start print' : 'Print anyway'}
          </Button>
          <Button variant="ghost" onClick={() => setPending(null)}>Cancel</Button>
        </div>
      ) : null}
    </section>
  )
}

function History({ hub, printer }: { hub: DeviceHub; printer: PrinterInfo }) {
  const h = useList<PrintRecord>(() => hub.device.history(printer.id), printer.id)
  return (
    <section aria-label="Print history">
      {h.error ? <p className="sx-small warn">{h.error}</p> : null}
      {!h.error && !h.busy && h.rows.length === 0 ? <p className="sx-small sx-muted">This printer has no history to show.</p> : null}
      <ul className="recent-projects">
        {h.rows.map((r, i) => (
          <li key={`${r.name}-${r.startedAt ?? i}`}>
            <span>
              <b>{r.name.replace(/\.(gcode(\.3mf)?|bgcode|3mf)$/i, '')}</b>{' '}
              <Pill state={r.outcome === 'completed' ? 'ok' : r.outcome === 'canceled' ? 'off' : 'bad'}>{r.outcome === 'completed' ? 'Finished' : r.outcome === 'canceled' ? 'Canceled' : `Failed${r.detail ? `: ${r.detail}` : ''}`}</Pill>
              <small>{[when(r.startedAt), recordDuration(r.durationS), filamentText(r.filamentMm)].filter(Boolean).join(', ')}</small>
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

function Problems({ hub, printer, status }: { hub: DeviceHub; printer: PrinterInfo; status: PrinterStatus }) {
  const p = useList<PrinterIssue>(() => hub.device.issues(printer.id), `${printer.id}:${status.state}:${status.message ?? ''}`)
  const { now, earlier } = splitIssues(p.rows)
  return (
    <section aria-label="What the printer reports">
      {p.error ? <p className="sx-small warn">{p.error}</p> : null}
      {!p.error && !p.busy && now.length === 0 ? <p className="sx-small sx-muted">{status.message ?? 'The printer reports no problems.'}</p> : null}
      <IssueList rows={now} />
      {earlier.length ? (
        <>
          <p className="sx-small sx-muted">From an earlier job. The printer keeps these until they are cleared on its screen.</p>
          <IssueList rows={earlier} muted />
        </>
      ) : null}
    </section>
  )
}

function IssueList({ rows, muted }: { rows: PrinterIssue[]; muted?: boolean }) {
  if (!rows.length) return null
  return (
    <ul className={muted ? 'recent-projects sx-muted' : 'recent-projects'}>
      {rows.map((i) => (
        <li key={i.code}>
          <span>
            <Pill state={muted || i.severity === 'info' ? 'off' : i.severity === 'common' ? 'warn' : 'bad'}>{SEVERITY_LABEL[i.severity]}</Pill> <b>{i.module}</b>
            <small>{i.text}</small>
            {i.helpUrl ? <small><a href={i.helpUrl} target="_blank" rel="noreferrer">What code {i.code} means</a></small> : null}
          </span>
        </li>
      ))}
    </ul>
  )
}

/** The running print's objects drawn on the bed, each with a Skip that asks first. A row and its outline
 * select each other, the confirm names the copy and the outline it skips, and it closes if the print changes. */
function Skip({ hub, printer, status }: { hub: DeviceHub; printer: PrinterInfo; status: PrinterStatus }) {
  const bed = useApp((s) => s.bed)
  const [epoch, setEpoch] = useState<number | null>(null)
  const objs = useList<PrintObject>(
    () =>
      Promise.all([hub.device.objects(printer.id), hub.bed.state(printer.id)]).then(([o, b]) => {
        setEpoch(b.epoch ?? null)
        return o
      }),
    `${printer.id}:${status.jobName ?? ''}`,
  )
  const [picked, setPicked] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<PrintObject | null>(null)
  // A confirm opened for one print never applies to the next.
  useEffect(() => {
    setConfirm(null)
    setPicked(null)
  }, [status.jobName])
  const skip = async (o: PrintObject) => {
    try {
      if (epoch === null) throw new Error('The hub did not say which print is running. Close this and open it again.')
      await hub.device.skipObject(printer.id, o.id, epoch)
      toast(`Skipped ${o.name}`, 'ok')
      objs.reload()
    } catch (e) {
      toast(deviceError(e), 'error')
      objs.reload()
    } finally {
      setConfirm(null)
    }
  }
  const unsupported = objs.error && /own network|not list|not supported/i.test(objs.error)
  // The drawing covers the bed and every outline, so nothing is cut off on a printer with a larger bed.
  const pts = objs.rows.flatMap((o) => o.polygon ?? [])
  const w = Math.max(bed.widthMm, ...pts.map((p) => p[0]))
  const d = Math.max(bed.depthMm, ...pts.map((p) => p[1]))
  const choose = (o: PrintObject) => {
    setPicked(o.id)
    if (!o.skipped) setConfirm(o)
  }
  return (
    <section aria-label="Skip objects">
      {objs.error ? <p className="sx-small warn">{unsupported ? 'This printer cannot list the objects of the running print. Skip them on its screen.' : objs.error}</p> : null}
      {!objs.error && !objs.busy && objs.rows.length === 0 ? <p className="sx-small sx-muted">The G-code of this print does not label its objects, so there is nothing to skip. Turn on object labels (exclude objects) in the printer profile and slice again.</p> : null}
      {pts.length ? (
        <svg viewBox={`0 0 ${w} ${d}`} className="skip-bed" role="img" aria-label="Objects on the bed" style={{ width: '100%', maxWidth: 320, background: 'var(--ink-2)', border: '1px solid var(--line)', transform: 'scaleY(-1)' }}>
          {objs.rows.map((o) => {
            const on = o.id === (confirm?.id ?? picked)
            return (
              <polygon
                key={o.id}
                points={(o.polygon ?? []).map((p) => p.join(',')).join(' ')}
                fill={o.skipped ? 'none' : on ? 'var(--orange)' : 'var(--purple)'}
                fillOpacity={on ? 0.8 : 0.45}
                stroke={o.skipped ? 'var(--red)' : on ? 'var(--orange)' : 'var(--purple)'}
                strokeWidth={on ? 2 : 1}
                strokeDasharray={o.skipped ? '4 3' : undefined}
                style={{ cursor: o.skipped ? 'default' : 'pointer' }}
                onClick={() => choose(o)}
              >
                <title>{o.name}</title>
              </polygon>
            )
          })}
        </svg>
      ) : null}
      <ul className="recent-projects">
        {objs.rows.map((o) => (
          <li key={o.id} aria-current={o.id === (confirm?.id ?? picked) ? 'true' : undefined} onMouseEnter={() => setPicked(o.id)}>
            <span>
              <b>{o.name}</b> {o.center ? <small className="sx-muted">at {Math.round(o.center[0])}, {Math.round(o.center[1])} mm</small> : null} {o.skipped ? <Pill state="off">Skipped</Pill> : null}
            </span>
            {!o.skipped ? <Button size="sm" variant="ghost" onClick={() => choose(o)}>Skip</Button> : null}
          </li>
        ))}
      </ul>
      {confirm ? (
        <div role="alertdialog" aria-label="Confirm skip" className="calib-act">
          <p className="sx-small">
            Skip {confirm.name}{confirm.center ? ` (at ${Math.round(confirm.center[0])}, ${Math.round(confirm.center[1])} mm)` : ''}, the outline highlighted in orange? The printer stops printing it for the rest of this job. This cannot be undone.
          </p>
          <Button variant="primary" onClick={() => void skip(confirm)}>Skip {confirm.name}</Button>
          <Button variant="ghost" onClick={() => setConfirm(null)}>Keep printing it</Button>
        </div>
      ) : null}
    </section>
  )
}
