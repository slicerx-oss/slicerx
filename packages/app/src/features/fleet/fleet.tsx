// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Printers: a camera wall of every printer, live from printer events, by bay or all at once, and the plate queue.
import { noteViewClosing } from '../../camera/closing'
import { openResume } from '../../plate/resume-state'
import { tempText } from '../../lib/temp'
import { isDue, removeFromQueue, startable } from '../../queue/queue'
import { lazy, Suspense, useEffect, useId, useMemo, useState } from 'react'
import type { Fleet } from '@slicerx/contracts'
import { Button, Chip, Dialog, Field, Icon, Input, LinkButton, Menu, MenuAnchor, MenuHeading, MenuItem, Pill, Seg, tipAttrs } from '@slicerx/ui'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useHost } from '../../host'
import { Silhouette, Swatch } from '../../parts'
import { useFleet, usePrinters, type FleetRow } from '../../lib/queries'
import { formatDuration, formatGrams } from '../../lib/preview-stats'
import { exportGcode, sendToPrinter, startQueued } from '../../state/actions'
import { isExportOnly, removeHandPrinter } from '../../lib/hand-printers'
import { set, setWorkspace, toast, useApp } from '../../state/store'
import { VendorMark } from '../../lib/vendor-mark'
import { printPlateLabel } from '../../lib/use-printer'
import { lastStillOf, rememberStill } from '../../camera/use-camera'
import { CameraIdle, FirstLookCover, useFirstLook } from '../../camera/idle'
import { CodeNeeded, OfflineIdle } from './offline'
import { openSetup, useTabLabel } from '../../first-run/look'
import { gauges, printingSlot, slotName } from './hud'
import { bayGroups, progressOf, statusLine, timeLeftText, wallCounts, wallKind, wallOrder, wallPill, type WallCount } from './wall'
import { moveToBay, newBay } from './bays'
import './wall.css'

const DeviceDialog = lazy(() => import('./device-dialog').then((m) => ({ default: m.DeviceDialog })))
const PrinterHud = lazy(() => import('./hud-view').then((m) => ({ default: m.PrinterHud })))

/** How often a tile asks the printer for a new still. */
const STILL_MS = 10_000

const COUNT_TONE: Record<WallCount['id'], string> = { print: 'run', need: 'warn', ready: 'ok', off: 'off', low: 'low' }

function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), ms)
    return () => window.clearInterval(t)
  }, [ms])
  return now
}

export function Fleet() {
  const fleet = useFleet()
  const rows = fleet.data ?? []
  const now = useNow(30_000)
  const refresh = useApp((s) => s.fleetRefresh)
  const refetch = fleet.refetch
  useEffect(() => {
    if (refresh) void refetch()
  }, [refresh, refetch])
  const view = useApp((s) => s.printersView)
  const bays = useApp((s) => s.bays)
  const printerBays = useApp((s) => s.printerBays)
  const groups = useGroups()
  const [viewing, setViewing] = useState<string | null>(null)
  const live = rows.find((r) => r.id === viewing && !isExportOnly(r))
  // The printer view closes when its row goes; say so to its camera's close.
  if (viewing && !live) noteViewClosing(fleet.data ? 'the printer left the printer list' : 'the printer list was reloading')
  const counts = useMemo(() => wallCounts(rows, now), [rows, now])

  if (live) {
    return (
      <Suspense fallback={<div className="page" aria-busy="true" />}>
        <PrinterHud row={live} onClose={() => setViewing(null)} />
      </Suspense>
    )
  }
  const sections = view === 'bay' ? bayGroups(rows, bays, printerBays) : [{ id: 'all', name: '', rows: wallOrder(rows), summary: '' }]
  const tile = (r: FleetRow) => <Tile key={r.id} r={r} now={now} groups={groups.data ?? []} onView={() => setViewing(r.id)} />
  return (
    <div className="page fleet">
      <header className="wall-h">
        <h1 className="sx-display">Printers</h1>
        <Seg
          label="Group printers"
          value={view}
          onChange={(v) => set({ printersView: v })}
          options={[
            { value: 'all', label: 'All printers' },
            { value: 'bay', label: 'By bay' },
          ]}
        />
        <Button icon="search" onClick={() => openSetup('printer')} tip={{ title: 'Find printers', body: 'Look for printers on your network and add one.' }}>
          Find printers
        </Button>
        <Button variant="primary" icon="plus" onClick={() => openSetup('printer', { byHand: true })}>
          Add printer
        </Button>
      </header>
      {fleet.isError ? <p className="app-err">Printers did not answer: {fleet.error.message}</p> : null}
      {rows.length ? <CountStrip counts={counts} /> : null}
      {fleet.isPending ? <div className="wall-grid wall-skeleton" aria-busy="true" /> : null}
      {!fleet.isPending && rows.length === 0 ? <EmptyWall /> : null}
      {sections.map((g) =>
        view === 'bay' ? (
          <section key={g.id ?? 'none'} className="wall-bay" aria-labelledby={`bay-${g.id ?? 'none'}`}>
            <div className="wall-bay-h">
              <h2 id={`bay-${g.id ?? 'none'}`}>{g.name}</h2>
              {'place' in g && g.place ? <span className="wall-bay-place">{g.place}</span> : null}
              <span className="wall-bay-sum">{g.summary}</span>
            </div>
            {g.id === null && bays.length === 0 ? <p className="app-empty">Put printers in bays with Move to bay in a printer's menu.</p> : null}
            <div className="wall-grid">{g.rows.map(tile)}</div>
          </section>
        ) : (
          <div key="all" className="wall-grid">
            {g.rows.map(tile)}
          </div>
        ),
      )}
      <Queue rows={rows} groups={groups.data ?? []} />
    </div>
  )
}

/** No printers yet: huginn and muninn on a branch, glancing about, ready to look for some. */
function EmptyWall() {
  return (
    <section className="wall-empty" aria-labelledby="wall-empty-h">
      <div className="wall-empty-ravens" aria-hidden="true">
        <Icon name="huginn" className="wall-empty-raven" style={{ width: 64, height: 64, transform: 'scaleX(-1)' }} />
        <Icon name="huginn" className="wall-empty-raven" style={{ width: 64, height: 64 }} />
        <svg className="wall-empty-branch" viewBox="0 0 200 16" preserveAspectRatio="none">
          <path d="M4 8c50-4 140-4 192 2M44 7l-8-6M160 7l8-6" />
        </svg>
      </div>
      <h2 id="wall-empty-h">No printers yet</h2>
      <p>Huginn and Muninn are ready to scout your network for printers.</p>
      <div className="wall-empty-acts">
        <Button variant="primary" icon="search" onClick={() => openSetup('printer')}>
          Find printers
        </Button>
        <Button icon="plus" onClick={() => openSetup('printer', { byHand: true })}>
          Add one by hand
        </Button>
      </div>
    </section>
  )
}

function CountStrip({ counts }: { counts: readonly WallCount[] }) {
  return (
    <ul className="wall-counts" aria-label="Printers by state">
      {counts.map((c) => (
        <li key={c.id} data-tone={COUNT_TONE[c.id]} aria-label={`${c.label}: ${c.value}. ${c.sub}`}>
          <span className="wall-count-label">{c.label}</span>
          <b className="wall-count-n">{c.value}</b>
          <span className="wall-count-sub">{c.sub}</span>
        </li>
      ))}
    </ul>
  )
}

/** The tile's camera: the latest still, the last one seen when the camera is gone, else a quiet note. */
function TileCamera({ r, now }: { r: FleetRow; now: number }) {
  const printers = usePrinters()
  const st = r.status
  const exportOnly = isExportOnly(r)
  const on = !exportOnly && st.cameraAvailable && st.state !== 'offline'
  const [url, setUrl] = useState('')
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let current = ''
    const show = (blob: Blob) => {
      const next = URL.createObjectURL(blob)
      setUrl(next)
      if (current) URL.revokeObjectURL(current)
      current = next
    }
    const last = lastStillOf(r.id)
    if (last) show(last)
    else setUrl('')
    setFailed(false)
    let stop = false
    const tick = async () => {
      if (document.visibilityState === 'hidden' || !printers) return
      try {
        const blob = await printers.snapshot(r.id)
        if (stop) return
        if (blob) {
          rememberStill(r.id, blob)
          show(blob)
          setFailed(false)
        } else setFailed(true)
      } catch {
        if (!stop) setFailed(true)
      }
    }
    const timer = on ? window.setInterval(() => void tick(), STILL_MS) : 0
    if (on) void tick()
    return () => {
      stop = true
      window.clearInterval(timer)
      if (current) URL.revokeObjectURL(current)
    }
  }, [on, r.id, printers])
  // the first connect shows the ravens for one clash; a tile that opens on a remembered still does not
  const look = useFirstLook(Boolean(url), r.id, on && !lastStillOf(r.id))
  if (!exportOnly && st.state === 'offline' && st.needsCode && st.codeRef) return <CodeNeeded codeRef={st.codeRef} name={r.name} />
  if (!exportOnly && st.state === 'offline') return <OfflineIdle printerId={r.id} now={now} />
  if (url)
    return (
      <>
        <img className="wall-still cam-reveal" data-held={look === 'hold' || undefined} data-old={on ? undefined : true} src={url} alt="" />
        <FirstLookCover look={look} />
      </>
    )
  if (on && !failed) return <CameraIdle connecting text="Connecting to the camera" />
  const [text, detail] = exportOnly
    ? ['No connection', 'This printer takes exported files only, so there is no camera to show.']
    : !st.cameraAvailable
        ? ['No camera', 'This printer has no camera.']
        : ['No picture', 'The camera did not send a picture.']
  return <CameraIdle text={text} detail={detail} />
}

function Tile({ r, now, groups, onView }: { r: FleetRow; now: number; groups: readonly Fleet[]; onView: () => void }) {
  const st = r.status
  const exportOnly = isExportOnly(r)
  const kind = wallKind(r)
  const pill = wallPill(r)
  const left = timeLeftText(r)
  const progress = progressOf(r)
  const lineId = useId()
  const heat = kind === 'off' || exportOnly ? [] : gauges(st)
  const nozzle = heat.find((g) => g.kind === 'nozzle')
  const bed = heat.find((g) => g.kind === 'bed')
  const heatTip = heat.map((g) => `${g.label} ${tempText(g.temp)}`).join(', ')
  const active = printingSlot(st)
  const slots = st.slots.filter((x) => x.color || x.material)
  return (
    <article className="pcard" data-kind={kind} aria-label={`${r.name}, ${pill.label}`}>
      <div className="wall-cam">
        <TileCamera r={r} now={now} />
        <span className="wall-float wall-pill">
          <Pill state={pill.tone}>{pill.label}</Pill>
        </span>
        {left ? <span className="wall-float wall-left">{left}</span> : null}
        {progress !== null ? (
          <div className="wall-bar" data-tone={kind === 'need' ? 'warn' : undefined} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)} aria-label={`${r.name} progress`}>
            <i style={{ transform: `scaleX(${progress})` }} />
          </div>
        ) : null}
      </div>
      <div className="wall-body">
        <div className="wall-name">
          <span className="wall-mark" aria-hidden="true">
            <VendorMark vendor={r.vendor} size={18} />
          </span>
          <b>{r.name}</b>
          <span className="wall-model">{r.model}</span>
          <TileMenu r={r} groups={groups} onView={onView} />
        </div>
        <p className="wall-line" id={lineId}>
          {statusLine(r, now)}
        </p>
        {heat.length || slots.length ? (
          <div className="wall-meta">
            {heat.length ? (
              <span className="wall-heat" {...tipAttrs({ title: heatTip })}>
                {nozzle ? (
                  <span>
                    <b>{Math.round(nozzle.temp.current)}°</b> nozzle
                  </span>
                ) : null}
                {bed ? (
                  <span>
                    <b>{Math.round(bed.temp.current)}°</b> bed
                  </span>
                ) : null}
              </span>
            ) : null}
            {slots.length ? (
              <span className="wall-slots" aria-label="Loaded filament">
                {slots.map((s) => (
                  <span key={s.id} className="wall-slot" data-active={s.id === active || undefined} {...tipAttrs({ title: `${slotName(s)}${s.remainingPct !== undefined ? `, ${s.remainingPct}%` : ''}${s.id === active ? ', printing now' : ''}` })}>
                    <Swatch color={s.color ?? 'var(--ink-4)'} size="sm" />
                  </span>
                ))}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
      {exportOnly ? null : <button type="button" className="wall-open" aria-label={r.name} aria-describedby={lineId} onClick={onView} />}
    </article>
  )
}

function TileMenu({ r, groups, onView }: { r: FleetRow; groups: readonly Fleet[]; onView: () => void }) {
  const host = useHost()
  const qc = useQueryClient()
  const [menu, setMenu] = useState(false)
  const [device, setDevice] = useState(false)
  const [baying, setBaying] = useState(false)
  const bays = useApp((s) => s.bays)
  const bay = useApp((s) => s.printerBays[r.id])
  const slice = useApp((s) => s.slice)
  // With several plates the Print item names the one it prints.
  const plateName = useApp((s) => printPlateLabel(s.plates, s.activePlate))
  const st = r.status
  const exportOnly = isExportOnly(r)
  const kind = wallKind(r)
  const close = (then: () => void) => () => {
    setMenu(false)
    then()
  }
  const toggle = async (g: Fleet) => {
    const printers = host.printers
    if (!printers) return
    try {
      if (g.printerIds.includes(r.id)) await printers.removeFromFleet(g.id, r.id)
      else await printers.addToFleet(g.id, r.id)
      await qc.invalidateQueries({ queryKey: ['fleets'] })
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not change the fleet', 'error')
    }
  }
  const inBay = bays.some((b) => b.id === bay)
  return (
    <MenuAnchor className="wall-more">
      <Button size="sm" variant="ghost" icon="more" aria-label={`${r.name} options`} aria-expanded={menu} onClick={() => setMenu(!menu)} />
      <Menu open={menu} onClose={() => setMenu(false)} label={`${r.name} options`} align="end">
        <MenuHeading>Printer</MenuHeading>
        {exportOnly ? (
          <>
            {slice.status === 'done' ? (
              <MenuItem icon="sd-card" onClick={close(() => void exportGcode(host))}>
                Export G-code
              </MenuItem>
            ) : null}
            <MenuItem icon="delete" onClick={close(() => removeHandPrinter(r.id))}>
              Remove printer
            </MenuItem>
          </>
        ) : (
          <>
            <MenuItem icon="camera" onClick={close(onView)}>
              Live view
            </MenuItem>
            <MenuItem icon="printer" onClick={close(() => setDevice(true))}>
              Controls and files
            </MenuItem>
            {kind === 'ready' && slice.status === 'done' ? (
              <MenuItem icon="send-to-printer" onClick={close(() => void sendToPrinter(host, r))}>
                {plateName ? `Print ${plateName}` : 'Print the plate'}
              </MenuItem>
            ) : null}
            {kind === 'need' ? (
              <MenuItem icon="layers" onClick={close(() => openResume({ printerName: r.name, ...(st.layer ? { layer: st.layer } : {}) }))}>
                Print the rest
              </MenuItem>
            ) : null}
            {kind === 'off' || st.state === 'error' ? (
              <MenuItem icon="refresh" onClick={close(() => void qc.invalidateQueries({ queryKey: ['fleet'] }))}>
                Check again
              </MenuItem>
            ) : null}
          </>
        )}
        <MenuHeading>Move to bay</MenuHeading>
        {bays.map((b) => (
          <MenuItem key={b.id} checked={bay === b.id} onClick={close(() => moveToBay(r.id, b.id))}>
            {b.name}
          </MenuItem>
        ))}
        <MenuItem icon="plus" onClick={close(() => setBaying(true))}>
          New bay…
        </MenuItem>
        <MenuItem checked={!inBay} onClick={close(() => moveToBay(r.id, null))}>
          No bay
        </MenuItem>
        {!exportOnly && groups.length ? (
          <>
            <MenuHeading>Fleets</MenuHeading>
            {groups.map((g) => (
              <MenuItem key={g.id} icon="fleet" checked={g.printerIds.includes(r.id)} onClick={() => void toggle(g)}>
                {g.name}
              </MenuItem>
            ))}
          </>
        ) : null}
      </Menu>
      {device ? (
        <Suspense fallback={null}>
          <DeviceDialog printer={r} status={st} onClose={() => setDevice(false)} />
        </Suspense>
      ) : null}
      <NewBayDialog open={baying} printer={r} onClose={() => setBaying(false)} />
    </MenuAnchor>
  )
}

/** Optional user-made groups of printers. */
function useGroups() {
  const host = useHost()
  const printers = host.printers
  return useQuery({ queryKey: ['fleets'], queryFn: () => (printers ? printers.fleets() : Promise.resolve([] as Fleet[])), staleTime: 30_000 })
}

function NewBayDialog({ open, printer, onClose }: { open: boolean; printer: FleetRow; onClose: () => void }) {
  const [name, setName] = useState('')
  const [place, setPlace] = useState('')
  const id = useId()
  const create = () => {
    if (!name.trim()) return
    newBay(printer.id, name, place)
    setName('')
    setPlace('')
    onClose()
  }
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New bay"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon="check" disabled={!name.trim()} onClick={create}>
            Create bay
          </Button>
        </>
      }
    >
      <p className="sx-small sx-muted">A bay is where printers stand, such as a rack or a desk. {printer.name} moves into it.</p>
      <Field htmlFor={`${id}-name`} label="Name">
        <Input id={`${id}-name`} value={name} maxLength={60} placeholder="Bay A" onChange={(e) => setName(e.currentTarget.value)} onKeyDown={(e) => e.key === 'Enter' && create()} />
      </Field>
      <Field htmlFor={`${id}-place`} label="Place (optional)">
        <Input id={`${id}-place`} value={place} maxLength={80} placeholder="Workshop rack" onChange={(e) => setPlace(e.currentTarget.value)} onKeyDown={(e) => e.key === 'Enter' && create()} />
      </Field>
    </Dialog>
  )
}

/** Sends the sliced plate to several printers, one after the other. Each one gets its own send step and approval card. */
function SendSeveral({ open, onClose, rows }: { open: boolean; onClose: () => void; rows: FleetRow[] }) {
  const host = useHost()
  const [picked, setPicked] = useState<string[]>([])
  const idle = rows.filter((r) => !isExportOnly(r) && (r.status.state === 'idle' || r.status.state === 'finished'))
  const go = async () => {
    const chosen = idle.filter((r) => picked.includes(r.id))
    onClose()
    setPicked([])
    for (const r of chosen) await sendToPrinter(host, r)
  }
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Print on several printers"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon="send" disabled={picked.length === 0} onClick={() => void go()}>
            {picked.length > 1 ? `Continue with ${picked.length} printers` : 'Continue'}
          </Button>
        </>
      }
    >
      <p className="sx-small sx-muted">You choose the options and approve each printer in turn. A printer you skip is left alone.</p>
      <fieldset className="fleet-pick">
        <legend className="sx-small sx-muted">Idle printers</legend>
        {idle.length === 0 ? <p className="sx-small sx-muted">No printer is idle right now.</p> : null}
        {idle.map((r) => (
          <label key={r.id} htmlFor={`several-${r.id}`}>
            <input id={`several-${r.id}`} type="checkbox" checked={picked.includes(r.id)} onChange={(e) => setPicked(e.currentTarget.checked ? [...picked, r.id] : picked.filter((x) => x !== r.id))} />
            <VendorMark vendor={r.vendor} size={16} />
            {r.name} <span className="sx-muted">{r.model}</span>
          </label>
        ))}
      </fieldset>
    </Dialog>
  )
}

function QueuedList({ rows }: { rows: FleetRow[] }) {
  const host = useHost()
  const queue = useApp((s) => s.queue)
  const go = useMemo(() => startable(queue), [queue])
  if (queue.length === 0) return null
  const now = Date.now()
  return (
    <ul className="queued" aria-label="Queued plates">
      {queue.map((q) => {
        const row = rows.find((r) => r.id === q.printerId)
        const free = row ? row.status.state === 'idle' || row.status.state === 'finished' : false
        const due = isDue(q, now)
        return (
          <li key={q.id} className="qrow">
            <div className="min0">
              <b>
                {q.plateName} {due ? <Chip tone="green">Ready</Chip> : null}
              </b>
              <span className="sx-mono small muted">
                {q.printerName}, {formatDuration(q.timeS)}, {formatGrams(q.grams)}
                {q.startAfter ? `, not before ${new Date(q.startAfter).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}` : ''}
              </span>
            </div>
            <Button size="sm" icon="play" disabled={!go.has(q.id) || !free} tip={{ title: 'Start', body: 'Asks for your approval and the bed-clear check first.', reason: !go.has(q.id) ? 'An earlier plate on this printer goes first.' : 'The printer is busy or offline.' }} onClick={() => void startQueued(host, q)}>
              Start
            </Button>
            <Button size="sm" variant="ghost" icon="close" aria-label={`Remove ${q.plateName} from the queue`} tip={{ title: 'Remove', body: 'Take it off the queue. The file stays on the printer.' }} onClick={() => removeFromQueue(q.id)} />
          </li>
        )
      })}
    </ul>
  )
}

function Queue({ rows, groups }: { rows: FleetRow[]; groups: readonly Fleet[] }) {
  const host = useHost()
  const tab = useTabLabel('prepare')
  const slice = useApp((s) => s.slice)
  const plate = useApp((s) => s.plate)
  const idle = rows.filter((r) => !isExportOnly(r) && (r.status.state === 'idle' || r.status.state === 'finished'))
  const [target, setTarget] = useState<string>('')
  // A fleet target sends to its first idle printer.
  const group = groups.find((g) => `fleet:${g.id}` === target)
  const chosen = group ? idle.find((r) => group.printerIds.includes(r.id)) : (idle.find((r) => r.id === target) ?? idle[0])
  const done = slice.status === 'done' ? slice.result : null
  const queued = useApp((s) => s.queue)
  const [several, setSeveral] = useState(false)
  return (
    <section className="queue" aria-labelledby="queue-h">
      <h2 id="queue-h">Queue</h2>
      <p className="sx-muted sx-small">Nothing starts until you press Print, and every print asks for your approval.</p>
      {done && plate[0] ? (
        <div className="qrow">
          <span className="obj-thumb">{plate[0].thumb ? <img src={plate[0].thumb} alt="" /> : <Silhouette parts={plate[0].parts} />}</span>
          <div className="min0">
            <b>
              Plate 1: {plate[0].name} <Chip tone="purple">This plate</Chip>
            </b>
            <span className="sx-mono small muted">
              {formatDuration(done.stats.timeS)}, {formatGrams(done.stats.filamentG.reduce((a, b) => a + b, 0))}
            </span>
          </div>
          <label className="sx-small sx-muted" htmlFor="queue-target">
            Print on
          </label>
          <select id="queue-target" className="mini" value={group ? target : (chosen?.id ?? '')} onChange={(e) => setTarget(e.currentTarget.value)} disabled={idle.length === 0}>
            {idle.length === 0 ? <option value="">No idle printer</option> : null}
            {idle.map((r) => (
              <option key={r.id} value={r.id}>
                {r.model && r.model !== r.name ? `${r.name} (${r.model})` : r.name}
              </option>
            ))}
            {groups.map((g) => (
              <option key={g.id} value={`fleet:${g.id}`}>
                {g.name}, next idle printer
              </option>
            ))}
          </select>
          <Button size="sm" icon="send-to-printer" aria-label={chosen ? `Print on ${chosen.name}` : undefined} disabled={!chosen} onClick={() => chosen && void sendToPrinter(host, chosen)}>
            Print
          </Button>
          {idle.length > 1 ? (
            <Button size="sm" variant="ghost" icon="printer" onClick={() => setSeveral(true)}>
              Several
            </Button>
          ) : null}
        </div>
      ) : null}
      <QueuedList rows={rows} />
      <SendSeveral open={several} onClose={() => setSeveral(false)} rows={rows} />
      {!(done && plate[0]) && queued.length === 0 ? (
        <p className="app-empty">
          Nothing queued yet. <LinkButton className="inline-link" onClick={() => setWorkspace('prepare')}>Slice a plate in {tab}</LinkButton> to queue it here.
        </p>
      ) : null}
    </section>
  )
}
