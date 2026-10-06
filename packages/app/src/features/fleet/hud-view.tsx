// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// One printer's device view: the live camera fills it and frosted panels float over it. The top bar has
// the job, a strip under it what the printer reports as wrong now, the left edge tab the temperatures
// and fans, the right edge tab the filament, and the bottom bar the controls. Everything comes from the
// status stream the Printers page already follows; a part the printer does not report is left out.
import { Button, Icon, Pill, tipAttrs } from '@slicerx/ui'
import { lazy, Suspense, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import type { FilamentSlot } from '@slicerx/contracts'
import { useHost } from '../../host'
import { appName } from '../../edition'
import { lastStillOf, useCamera } from '../../camera/use-camera'
import { noteViewClosing } from '../../camera/closing'
import { CameraIdle, CameraProblem, FirstLookCover, useFirstLook } from '../../camera/idle'
import { CodeNeeded, OfflineIdle } from './offline'
import { printerImage } from '../../first-run/printer-images'
import { catalogModel } from '../../plate/preflight'
import { useMediaQuery } from '../../lib/media'
import type { FleetRow } from '../../lib/queries'
import { usePrinter } from '../../lib/use-printer'
import { isExportOnly } from '../../lib/hand-printers'
import { printerAction } from '../../state/actions'
import { set, useApp } from '../../state/store'
import { deviceHub, messageTone, splitIssues, type PrinterIssue } from './device'
import {
  dial, drawersOf, fans, gauges, hasUnits, HUD_RAIL, jobLine, jobTitle, layerLine, printingSlot, running, slotGroups, slotName, speedChoices, speedProfile, statePill,
  type Gauge, type SpeedLimits,
} from './hud'
import { adjustHub, setLight, setSpeed } from './hud-actions'
import './hud.css'

const SlotDialog = lazy(() => import('../../filament/dialogs').then((m) => ({ default: m.SlotDialog })))

type Side = 'left' | 'right'

const GAUGE_COLOR: Record<Gauge['kind'], string> = { nozzle: 'var(--red)', bed: 'var(--orange)', chamber: 'var(--cyan)' }
const R = 40
const CIRC = 2 * Math.PI * R
const ARC = CIRC * 0.75

function useClock(ms: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), ms)
    return () => window.clearInterval(t)
  }, [ms])
  return now
}

const deg = (c: number) => `${Math.round(c)} °C`

/** A 270 degree dial: the current temperature as the filled arc, the target as a tick. */
function Dial({ g, size, mini }: { g: Gauge; size: number; mini?: boolean }) {
  const { fill, target } = dial(g)
  const color = g.kind === 'nozzle' && g.temp.target <= 0 ? 'var(--dim)' : GAUGE_COLOR[g.kind]
  const tick = target === null ? null : ((135 + 270 * target) * Math.PI) / 180
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true" className="ph-dial">
      <circle cx="50" cy="50" r={R} className="ph-dial-track" strokeWidth={mini ? 10 : 7} strokeDasharray={`${ARC} ${CIRC}`} transform="rotate(135 50 50)" />
      <circle cx="50" cy="50" r={R} fill="none" stroke={color} strokeWidth={mini ? 10 : 7} strokeLinecap="round" strokeDasharray={`${Math.max(0.01, ARC * fill)} ${CIRC}`} transform="rotate(135 50 50)" />
      {tick !== null ? <line x1={50 + 35 * Math.cos(tick)} y1={50 + 35 * Math.sin(tick)} x2={50 + 47 * Math.cos(tick)} y2={50 + 47 * Math.sin(tick)} className="ph-dial-tick" /> : null}
      {mini ? null : (
        <>
          <text x="50" y="52" textAnchor="middle" className="ph-dial-now">{deg(g.temp.current)}</text>
          <text x="50" y="68" textAnchor="middle" className="ph-dial-of">{g.temp.target > 0 ? `of ${deg(g.temp.target)}` : g.kind === 'chamber' ? 'chamber' : 'off'}</text>
        </>
      )}
    </svg>
  )
}

/** The plate drawn as a small block, filled up to the layer printing now. */
function LayerGlyph({ layer, count }: { layer?: number | undefined; count?: number | undefined }) {
  const f = layer !== undefined && count ? Math.min(1, Math.max(0, layer / count)) : 0
  const y = 44 - 22 * f
  return (
    <svg width="72" height="64" viewBox="0 0 72 64" role="img" aria-label={layer !== undefined && count ? `Layer ${layer} of ${count}` : 'Current layer'} className="ph-glyph">
      <path d={`M8 44 L36 58 L64 44 L64 ${y} L36 ${y + 14} L8 ${y} Z`} className="ph-glyph-done" />
      <path d="M36 8 64 22 36 36 8 22z" className="ph-glyph-line" />
      <path d="M8 22v22l28 14 28-14V22M36 36v22" className="ph-glyph-line" />
      {f > 0 ? <path d={`M8 ${y} L36 ${y + 14} L64 ${y}`} className="ph-glyph-now" /> : null}
    </svg>
  )
}

function Swatch({ slot, active, size }: { slot: FilamentSlot; active: boolean; size: 'sm' | 'md' }) {
  return <span className="ph-sw" data-size={size} data-empty={slot.color && slot.material ? undefined : true} data-active={active || undefined} style={slot.color && slot.material ? { background: slot.color } : undefined} />
}

/** The camera behind the panels, or a quiet picture when there is none: the last still, else the printer. */
function Backdrop({ row }: { row: FleetRow }) {
  const st = row.status
  const on = st.cameraAvailable && st.state !== 'offline'
  const { session, still, error, status } = useCamera(on ? row : null)
  const video = useRef<HTMLVideoElement>(null)
  const [last, setLast] = useState('')
  useEffect(() => {
    if (video.current) video.current.srcObject = session?.media ?? null
  }, [session])
  useEffect(() => {
    if (on) return
    const blob = lastStillOf(row.id)
    if (!blob) return setLast('')
    const url = URL.createObjectURL(blob)
    setLast(url)
    return () => URL.revokeObjectURL(url)
  }, [on, row.id])
  const look = useFirstLook(session?.mode === 'live' || Boolean(still), row.id, on, `hud:${row.id}`)
  const problem = Boolean(error) || status.state === 'retrying' || status.state === 'failed'
  const now = useClock(30_000)
  const held = look === 'hold' || undefined
  if (on && session?.mode === 'live')
    return (
      <>
        <video ref={video} className="ph-cam cam-reveal" data-held={held} autoPlay muted playsInline aria-label={`Live view of ${row.name}`} />
        {problem ? <CameraProblem status={status} error={error} /> : <FirstLookCover look={look} size="lg" />}
      </>
    )
  if (on && still)
    return (
      <>
        <img className="ph-cam cam-reveal" data-held={held} src={still} alt={`Latest picture from ${row.name}`} />
        <FirstLookCover look={look} size="lg" />
      </>
    )
  if (on) return problem ? <CameraProblem status={status} error={error} /> : <CameraIdle connecting text="Connecting to the camera" size="lg" />
  if (st.state === 'offline')
    return (
      <div className="ph-quiet" data-testid="ph-placeholder">
        {st.needsCode && st.codeRef ? <CodeNeeded codeRef={st.codeRef} name={row.name} size="lg" /> : <OfflineIdle printerId={row.id} now={now} size="lg" />}
      </div>
    )
  const model = catalogModel(row)
  const picture = model ? printerImage(model.id) : null
  return (
    <div className="ph-quiet" data-testid="ph-placeholder">
      {last ? <img className="ph-cam ph-cam-old" src={last} alt={`Last picture from ${row.name}`} /> : picture ? <img className="ph-printer" src={picture} alt="" /> : <Icon name="huginn" size={64} className="cam-raven" style={{ width: 64, height: 64 }} />}
      <p className="sx-small sx-muted">This printer has no camera.</p>
    </div>
  )
}

/** What the printer reports as wrong now, from the hub's list (codes and all), else the status message. */
function useCurrentIssues(row: FleetRow): { text: string; code?: string }[] {
  const host = useHost()
  const hub = deviceHub(host)
  const st = row.status
  const [rows, setRows] = useState<PrinterIssue[] | null>(null)
  const key = `${row.id}:${st.state}:${st.message ?? ''}`
  useEffect(() => {
    if (!hub || st.state === 'offline') return setRows(null)
    let live = true
    hub.device.issues(row.id).then(
      (r) => live && setRows(r),
      () => live && setRows(null),
    )
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, hub === null])
  if (rows) {
    const now = splitIssues(rows).now
    if (now.length) return now.map((i) => ({ text: i.text, code: i.code.replace(/_/g, ' ') }))
  }
  return st.message && st.state !== 'offline' && messageTone(st.state) === 'warn' ? [{ text: st.message }] : []
}

export function PrinterHud({ row, onClose }: { row: FleetRow; onClose: () => void }) {
  const host = useHost()
  const st = row.status
  const now = useClock(30_000)
  const phone = useMediaQuery('(max-width: 640px)')
  const rails = useApp((s) => s.rails)
  const open = drawersOf(rails)
  const ids = { left: useId(), right: useId() }
  const tabs = { left: useRef<HTMLButtonElement>(null), right: useRef<HTMLButtonElement>(null) }
  const closers = { left: useRef<HTMLButtonElement>(null), right: useRef<HTMLButtonElement>(null) }
  const focusNext = useRef<{ side: Side; to: 'tab' | 'drawer' } | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const head = useRef<HTMLDivElement>(null)
  const issues = useCurrentIssues(row)
  const temps = gauges(st)
  const fanRows = fans(st.live)
  const units = hasUnits(st.slots)
  const groups = units ? slotGroups(st.slots, st.live, st.model ?? row.model) : []
  const activeSlot = printingSlot(st)
  const pill = statePill(st)
  const job = st.jobName && st.state !== 'offline' ? jobTitle(st.jobName) : null
  const progress = Math.round((st.progress ?? 0) * 100)
  const layer = layerLine(st)
  const isRunning = running(st.state)
  const hub = adjustHub(host)
  const [limits, setLimits] = useState<SpeedLimits | null>(null)
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const target = usePrinter().printer
  const printerSlots = useApp((s) => s.printerSlots)
  const sides = { left: temps.length > 0 || fanRows.length > 0, right: units }
  // On a phone one sheet shows at a time, the filament one when both were left open.
  const shown = (side: Side) => sides[side] && open[side] && !(phone && side === 'left' && open.right && sides.right)

  useEffect(() => {
    if (!hub || !isRunning) return setLimits(null)
    let live = true
    hub.adjust.limits(row.id).then(
      (l) => live && setLimits(l.speed),
      () => live && setLimits(null),
    )
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row.id, isRunning, hub === null])

  // The drawers start under the top bar and the alert strip, however tall those are.
  useEffect(() => {
    const h = head.current
    if (!h || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => root.current?.style.setProperty('--ph-head', `${Math.round(h.getBoundingClientRect().bottom - (root.current?.getBoundingClientRect().top ?? 0))}px`))
    ro.observe(h)
    return () => ro.disconnect()
  }, [])

  // Focus follows the drawer: into it when it opens, back to its tab when it closes.
  useEffect(() => {
    const f = focusNext.current
    if (!f) return
    focusNext.current = null
    ;(f.to === 'tab' ? tabs[f.side] : closers[f.side]).current?.focus()
  })

  const setDrawer = (side: Side, value: boolean) => {
    focusNext.current = { side, to: value ? 'drawer' : 'tab' }
    const other: Side = side === 'left' ? 'right' : 'left'
    // On a phone the drawers are bottom sheets, one at a time.
    const next = { ...rails[HUD_RAIL], [side]: value, ...(phone && value ? { [other]: false } : {}) }
    set({ rails: { ...rails, [HUD_RAIL]: next } })
  }

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape') return
    const inside = (['right', 'left'] as const).find((s) => shown(s) && document.getElementById(ids[s])?.contains(document.activeElement))
    const side = inside ?? (['right', 'left'] as const).find((s) => shown(s))
    if (!side) return
    e.stopPropagation()
    e.preventDefault()
    setDrawer(side, false)
  }

  const act = async (action: 'pause' | 'resume' | 'cancel') => {
    setBusy(true)
    try {
      await printerAction(host, row, action)
    } finally {
      setBusy(false)
    }
  }

  const speeds = speedChoices(limits)
  const reported = speedProfile(st.live?.speedPercent)
  const showSpeed = !isExportOnly(row) && isRunning && (st.live?.speedPercent !== undefined || hub !== null)
  const lightOn = st.live?.light
  // Developer Mode off on a Bambu Lab printer: status comes through, commands do not, so the controls rest.
  const watchOnly = st.live?.monitorOnly === true
  const watchTip = (title: string) => ({ title, reason: `Developer Mode is off on ${row.name}, so ${appName()} shows its status only. Use the printer's screen or Bambu Connect.` })
  const mine = target?.id === row.id
  const editIndex = Math.max(1, printerSlots.findIndex((s) => s.id === (st.live?.activeSlot ?? st.slots[0]?.id)) + 1)

  return (
    <div ref={root} className="ph" data-layout={phone ? 'phone' : 'wide'} data-state={st.state} onKeyDown={onKey} aria-label={`${row.name} live view`} role="region">
      <div className="ph-stage">
        <Backdrop row={row} />
      </div>

      <div className="ph-head" ref={head}>
      <header className="ph-glass ph-top">
        <Button size="sm" variant="ghost" icon="arrow-left" aria-label="Back to all printers" onClick={() => (noteViewClosing('the back button'), onClose())} />
        <div className="ph-who">
          <h1 className="ph-name">{row.name}</h1>
          <span className="ph-model">
            {row.vendor} {st.model ?? row.model}
            {st.ownName && st.ownName !== row.name ? `, named ${st.ownName} on the printer` : ''}
          </span>
        </div>
        <Pill state={pill.tone}>{pill.label}</Pill>
        {job ? (
          <div className="ph-job">
            <div className="ph-job-row">
              <span className="ph-file" {...tipAttrs(st.jobName)}>{job}</span>
              <span className="ph-num ph-muted">{jobLine(st, now)}</span>
            </div>
            {isRunning || st.state === 'preparing' ? (
              <div className="ph-bar" data-paused={st.state === 'paused' || undefined} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} aria-label={`${row.name} progress`}>
                <i style={{ transform: `scaleX(${progress / 100})` }} />
              </div>
            ) : null}
          </div>
        ) : (
          <div className="ph-job ph-muted">{st.state === 'offline' ? 'Not reachable' : 'Ready for a job'}</div>
        )}
        {job && (isRunning || st.state === 'preparing') ? <span className="ph-pct ph-num">{progress}%</span> : null}
      </header>

      {issues.length ? (
        <div className="ph-glass ph-alert" role="status">
          <Icon name="warning" size={18} />
          <ul>
            {issues.map((i) => (
              <li key={`${i.code ?? ''}${i.text}`}>
                <span>{i.text}</span>
                {i.code ? <small className="ph-num">Code {i.code}</small> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      </div>

      {sides.left ? (
        <>
          <button ref={tabs.left} type="button" className="ph-glass ph-tab" data-side="left" hidden={shown('left')} aria-expanded={shown('left')} aria-controls={ids.left} aria-label="Show temperatures and fans" onClick={() => setDrawer('left', true)}>
            {temps.map((g) => (
              <span key={g.id} className="ph-mini">
                <Dial g={g} size={36} mini />
                <span className="ph-num">{deg(g.temp.current)}</span>
              </span>
            ))}
          </button>
          <aside id={ids.left} className="ph-glass ph-drawer" data-side="left" hidden={!shown('left')} aria-label="Temperatures and fans">
            <button ref={closers.left} type="button" className="ph-close" aria-label="Close temperatures and fans" onClick={() => setDrawer('left', false)}>
              <Icon name={phone ? 'chevron-down' : 'chevron-left'} size={16} />
            </button>
            {temps.length ? (
              <>
                <h2 className="ph-cap">Temperatures</h2>
                <div className="ph-gauges">
                  {temps.map((g) => (
                    <div key={g.id} className="ph-gauge" role="meter" aria-label={g.label} aria-valuemin={0} aria-valuemax={g.max} aria-valuenow={Math.round(g.temp.current)} aria-valuetext={g.temp.target > 0 ? `${deg(g.temp.current)}, target ${deg(g.temp.target)}` : `${deg(g.temp.current)}, heater off`}>
                      <Dial g={g} size={104} />
                      <span>{g.label}</span>
                    </div>
                  ))}
                </div>
              </>
            ) : null}
            {fanRows.length ? (
              <>
                <h2 className="ph-cap">Fans</h2>
                {fanRows.map((f) => (
                  <div key={f.id} className="ph-fan">
                    <span>{f.label}</span>
                    <span className="ph-fanbar" role="meter" aria-label={`${f.label} fan`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={f.percent}>
                      <i style={{ transform: `scaleX(${f.percent / 100})` }} />
                    </span>
                    <span className="ph-num">{f.percent}%</span>
                  </div>
                ))}
              </>
            ) : null}
          </aside>
        </>
      ) : null}

      {sides.right ? (
        <>
          <button ref={tabs.right} type="button" className="ph-glass ph-tab" data-side="right" hidden={shown('right')} aria-expanded={shown('right')} aria-controls={ids.right} aria-label="Show filament" onClick={() => setDrawer('right', true)}>
            {groups.map((g, gi) => (
              <span key={g.id} className="ph-tab-group">
                {gi > 0 ? <span className="ph-divider" aria-hidden="true" /> : null}
                {g.slots.map((s) => (
                  <Swatch key={s.id} slot={s} active={s.id === activeSlot} size="sm" />
                ))}
              </span>
            ))}
          </button>
          <aside id={ids.right} className="ph-glass ph-drawer" data-side="right" hidden={!shown('right')} aria-label="Filament">
            <button ref={closers.right} type="button" className="ph-close" aria-label="Close filament" onClick={() => setDrawer('right', false)}>
              <Icon name={phone ? 'chevron-down' : 'chevron-right'} size={16} />
            </button>
            <h2 className="ph-cap">Filament</h2>
            {groups.map((g) => (
              <section key={g.id} className="ph-unit" aria-label={g.label}>
                <h3>{g.feeds ? `${g.label}, feeds the ${g.feeds}` : g.label}</h3>
                <ul>
                  {g.slots.map((s) => (
                    <li key={s.id} className="ph-slot" data-active={s.id === activeSlot || undefined} data-empty={s.material ? undefined : true}>
                      <Swatch slot={s} active={false} size="md" />
                      <span className="ph-slot-name">
                        <span>{slotName(s)}</span>
                        {s.id === activeSlot ? <small>Printing now</small> : null}
                      </span>
                      {s.material && s.remainingPct !== undefined ? <span className="ph-num">{Math.round(s.remainingPct)}% left</span> : null}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
            <Button
              className="ph-edit"
              icon="ams-slot"
              disabled={!mine || watchOnly}
              tip={{ title: 'Edit slots', body: 'Set what each slot holds, and write it back to the printer.', ...(watchOnly ? { reason: watchTip('Edit slots').reason } : mine ? {} : { reason: `Choose ${row.name} as the printer in Prepare first.` }) }}
              onClick={() => {
                set({ slotDialog: editIndex })
                setEditing(true)
              }}
            >
              Edit slots
            </Button>
          </aside>
        </>
      ) : null}

      {isExportOnly(row) ? null : (
        <footer className="ph-glass ph-bottom">
          <LayerGlyph layer={st.layer} count={st.layerCount} />
          <div className="ph-layer">
            <span className="ph-num">{layer ? layer.layer : st.state === 'offline' ? 'Offline' : 'No print running'}</span>
            {layer?.height ? <span className="ph-muted ph-num">{layer.height}</span> : null}
          </div>
          <div className="ph-controls">
            {showSpeed ? (
              <label className="ph-speed">
                <span>Speed</span>
                <select
                  className="sx-select"
                  value={reported ? String(reported.percent) : ''}
                  disabled={!hub || busy || watchOnly}
                  {...tipAttrs(watchOnly ? watchTip('Speed') : hub ? undefined : { title: 'Speed', reason: 'Speed changes need the SlicerX link on your network.' })}
                  onChange={(e) => {
                    const v = Number(e.currentTarget.value)
                    setBusy(true)
                    void setSpeed(host, row, v).finally(() => setBusy(false))
                  }}
                >
                  {reported ? null : <option value="">{st.live?.speedPercent !== undefined ? `${st.live.speedPercent}%` : 'Choose'}</option>}
                  {speeds.map((p) => (
                    <option key={p.id} value={p.percent}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {lightOn !== undefined ? (
              <Button
                icon="led"
                pressed={lightOn}
                disabled={!hub?.adjust.light || st.state === 'offline' || watchOnly}
                tip={watchOnly ? watchTip('Light') : hub?.adjust.light ? 'Chamber light' : { title: 'Light', reason: 'The light switches from the SlicerX app on your network.' }}
                onClick={() => void setLight(host, row, !lightOn)}
              >
                Light
              </Button>
            ) : null}
            {st.state === 'printing' ? (
              <Button variant="primary" icon="pause" disabled={busy || watchOnly} {...(watchOnly ? { tip: watchTip('Pause') } : {})} onClick={() => void act('pause')}>
                Pause
              </Button>
            ) : st.state === 'paused' ? (
              <Button variant="primary" icon="play" disabled={busy || watchOnly} {...(watchOnly ? { tip: watchTip('Resume') } : {})} onClick={() => void act('resume')}>
                Resume
              </Button>
            ) : null}
            {isRunning ? (
              <Button variant="danger" icon="stop" disabled={busy || watchOnly} {...(watchOnly ? { tip: watchTip('Stop') } : {})} onClick={() => void act('cancel')}>
                Stop
              </Button>
            ) : null}
          </div>
        </footer>
      )}
      {editing ? (
        <Suspense fallback={null}>
          <SlotDialog />
        </Suspense>
      ) : null}
    </div>
  )
}
