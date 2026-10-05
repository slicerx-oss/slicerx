// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Print sheet: the one step between a sliced plate and a running printer. It shows what will
// print and where, checks the file against the printer while it is open, and its confirm button is
// the approval. The button says "Bed is clear, start print" when nothing else confirms the bed is
// empty; Upload only and Queue for later sit in the button's menu. The file and its filaments were
// decided before the sheet opened, so they show as a summary; a slot is picked here only when no
// loaded slot fits a filament.
import { followsSlotMap, type PrinterInfo, type PrinterStatus } from '@slicerx/contracts'
import { Button, Chip, Dialog, Field, Icon, Input, Menu, MenuAnchor, MenuItem, Pill, Switch, tipAttrs, type IconName } from '@slicerx/ui'
import { useEffect, useMemo, useState } from 'react'
import { formatDuration } from '../lib/preview-stats'
import { VendorMark } from '../lib/vendor-mark'
import { startAfterFromLocal } from '../queue/queue'
import { set, useApp } from '../state/store'
import { startLabel, type BedState } from './bed-state'
import { CheckLines, checkLines } from './check-lines'
import type { SheetNote } from '../plate/lint'
import { bareName, duplicateTargets, EXTERNAL_SLOT, optionTip, safeJobName, withEnding, type MapFilament, type MapSlot, type PrintEnding, type SendChoice, type SendOptionSpec, type SendOptions } from './options'
import './print-sheet.css'

export type PrintMode = 'start' | 'upload' | 'queue'

/** What the sheet checks while it is open: the exported file against the printer as it is now. */
export interface PrintCheck {
  errors: string[]
  /** Short lines, each shown only when it matters, with the detail in a tooltip. */
  warnings: SheetNote[]
  sha256: string
}

/** Everything the sheet needs. `check` is null while the file is still being exported and checked. */
export interface PrintSheetAsk {
  printer: PrinterInfo
  status: PrinterStatus | null
  plateName: string
  specs: SendOptionSpec[]
  initial: SendOptions
  /** Suggested file name; any print file ending is dropped and `ending` shown instead. */
  name: string
  /** What goes to the printer: .gcode.3mf for Bambu Lab printers, .gcode for the rest. */
  ending: PrintEnding
  filaments: MapFilament[]
  slots: MapSlot[]
  /** The printer's own order of filament to slot, the starting point of the mapping. */
  auto: Record<number, string>
  stats: { timeS: number; grams: number; layers: number }
  /** The plate's picture from the G-code, as a data URL, once the file is exported. */
  thumb?: string
  check: PrintCheck | null
  bed: BedState
  /**
   * Set when the printer refused the .gcode.3mf this sheet sent: its reason, the hash of the plain G-code the
   * "Send as plain G-code" button would send, and the person's last choices, which the sheet opens with.
   */
  refusal?: { reason: string; plainSha256: string; last: SendChoice }
  resolve: (choice: SendChoice | null) => void
}


/** What a slot is called on the sheet. */
function slotText(id: string | undefined): string {
  if (id === undefined) return 'Not loaded'
  if (id === EXTERNAL_SLOT) return 'External spool'
  return /^[A-Z]\d+$/.test(id) ? `AMS ${id}` : `Slot ${id}`
}

const STATE: Record<string, { label: string; pill: 'ok' | 'run' | 'warn' | 'bad' | 'off' }> = {
  idle: { label: 'Idle', pill: 'ok' },
  finished: { label: 'Finished', pill: 'ok' },
  printing: { label: 'Printing', pill: 'run' },
  paused: { label: 'Paused', pill: 'warn' },
  error: { label: 'Error', pill: 'bad' },
  offline: { label: 'Offline', pill: 'off' },
}

export function PrintSheet() {
  const ask = useApp((s) => s.printSheet)
  const [mode, setMode] = useState<PrintMode>('start')
  const [menu, setMenu] = useState(false)
  // The first render already shows the options it opens with (the effect below takes later asks), so the toggles
  // never show all off for a frame, and nothing depends on when the effect runs.
  const [value, setValue] = useState<SendOptions>(() => ask?.refusal?.last.options ?? ask?.initial ?? {})
  const [when, setWhen] = useState('')
  const [edits, setEdits] = useState<Record<number, string>>(() => ask?.refusal?.last.slotMap ?? {})
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (ask) {
      const last = ask.refusal?.last
      setMode('start')
      setMenu(false)
      setValue(last?.options ?? ask.initial)
      setWhen('')
      setEdits(last?.slotMap ?? {})
      setBusy(false)
    }
  }, [ask])
  // The file name was decided with the plate; it is made fit for the printer here rather than asked for again.
  const name = ask ? safeJobName(bareName(ask.refusal?.last.name ?? ask.name)) : 'plate'
  const fileName = withEnding(name, ask?.ending ?? '.gcode')
  // A printer that does not follow a slot map for this file takes filament as the G-code says: the sheet shows that
  // order and offers no choice it would ignore.
  const follows = ask ? followsSlotMap(ask.printer.plugin, fileName) : false
  const map: Record<number, string> = { ...(ask?.auto ?? {}), ...(follows ? edits : {}) }
  const mapping = Boolean(ask && ask.filaments.length > 0 && ask.slots.length > 0 && mode !== 'upload')
  // Slots are picked here only when the automatic match leaves a filament without one or two on the same slot. The
  // choice stays open once shown, so a pick does not make the control vanish under the pointer.
  const pick = useMemo(() => Boolean(ask && follows && ask.filaments.length > 0 && ask.slots.length > 0 && (ask.filaments.some((f) => ask.auto[f.index] === undefined) || duplicateTargets(ask.auto).length > 0)), [ask, follows])
  const dups = mapping ? duplicateTargets(map) : []
  const unmapped = mapping && ask ? ask.filaments.filter((f) => map[f.index] === undefined) : []
  const errors = ask?.check?.errors ?? []
  const warnings = ask?.check?.warnings ?? []
  const checking = Boolean(ask && ask.check === null)
  const start = mode === 'start'
  // A filament with no slot would go out as unmapped, and the printer would pick one: the person picks it here instead.
  const blocked = busy || checking || errors.length > 0 || dups.length > 0 || (follows && unmapped.length > 0)
  const finish = (result: SendChoice | null) => {
    set({ printSheet: null })
    ask?.resolve(result)
  }
  const confirm = () => {
    if (!ask || blocked) return
    setBusy(true)
    const startAfter = startAfterFromLocal(when)
    finish({
      options: value,
      start,
      name: fileName,
      ...(mode === 'queue' ? { queue: { ...(startAfter ? { startAfter } : {}) } } : {}),
      ...(mapping && follows ? { slotMap: map } : {}),
    })
  }
  // After a refusal: the same plate as plain G-code, only on this click. The printer then takes filament 1 from the
  // first slot and so on, whatever the slot choice above says, so no slot map goes with it.
  const sendPlain = () => {
    if (!ask?.refusal || busy || checking || errors.length > 0) return
    setBusy(true)
    finish({ options: value, start: true, name: withEnding(name, '.gcode'), plainGcode: true })
  }
  const slotName = (id: string) => (id === EXTERNAL_SLOT ? 'External spool' : id)
  // A warning never blocks: the button says the print goes ahead anyway. An error disables it until fixed.
  const anyway = start && errors.length === 0 && warnings.length > 0
  const go: { label: string; icon: IconName } = start ? { label: anyway ? (ask?.bed === 'clear' ? 'Start anyway' : 'Bed is clear, start anyway') : startLabel(ask?.bed ?? 'unknown'), icon: ask?.bed === 'clear' ? 'play' : 'bed-plate' } : mode === 'upload' ? { label: 'Upload only', icon: 'upload' } : { label: 'Add to queue', icon: 'queue' }
  const footer = (
    <>
      <Button variant="ghost" onClick={() => finish(null)}>
        Cancel
      </Button>
      {ask?.refusal && start ? (
        <Button variant="default" icon="export" disabled={busy || checking || errors.length > 0} onClick={sendPlain}>
          Send as plain G-code
        </Button>
      ) : null}
      <div className="ps-go" data-mode={mode}>
          <Button variant="primary" size="lg" icon={go.icon} disabled={blocked} {...(errors.length ? { tip: { title: go.label, reason: errors.length === 1 ? 'Fix the problem above to print.' : 'Fix the problems above to print.' } } : {})} className="ps-go-main" onClick={confirm}>
            {go.label}
          </Button>
          <MenuAnchor>
            <Button variant="primary" size="lg" icon="chevron-down" aria-label="More ways to send" aria-haspopup="menu" aria-expanded={menu} className="ps-go-more" onClick={() => setMenu((m) => !m)} />
            <Menu open={menu} onClose={() => setMenu(false)} label="More ways to send" align="end">
              <MenuItem icon="play" checked={mode === 'start'} onClick={() => { setMode('start'); setMenu(false) }}>
                Start now
              </MenuItem>
              <MenuItem icon="upload" checked={mode === 'upload'} onClick={() => { setMode('upload'); setMenu(false) }}>
                Upload only
              </MenuItem>
              <MenuItem icon="queue" checked={mode === 'queue'} onClick={() => { setMode('queue'); setMenu(false) }}>
                Queue for later
              </MenuItem>
            </Menu>
          </MenuAnchor>
        </div>
    </>
  )
  if (!ask) return null
  return (
    <Dialog open onClose={() => finish(null)} className="print-sheet" title={<SheetTitle ask={ask} />} footer={footer}>
        <Summary ask={ask} fileName={fileName} map={mapping ? map : null} />
        {checking ? (
          <p className="ps-checking" aria-live="polite">
            <i className="ps-spin" aria-hidden="true" /> Checking the file against {ask.printer.name}
          </p>
        ) : null}
        <CheckLines
          label={`Checks against ${ask.printer.name}`}
          lines={[
            ...(ask.refusal
              ? [{ tone: 'bad' as const, text: `${ask.printer.name} did not start the print`, tip: `It said: ${ask.refusal.reason} Send as plain G-code sends the same plate as ${withEnding(name, '.gcode')} (SHA-256 ${ask.refusal.plainSha256.slice(0, 12)}). The printer then feeds filament 1 from slot 1, filament 2 from slot 2 and so on, whatever the slots below say, and its screen shows no picture or object list for skipping.` }]
              : []),
            ...checkLines(errors, warnings),
          ]}
        />
        <div className="ps-body">
          {pick && mapping ? (
            <div className="ps-map" role="group" aria-label="Pick a slot">
              <p className="ps-map-head">
                <Icon name="spool" size={15} /> Pick a slot for each filament
              </p>
              {ask.filaments.map((f) => (
                <div key={f.index} className="ps-map-row">
                  <i className="ps-swatch" style={{ background: f.color }} aria-hidden="true" />
                  <label htmlFor={`ps-map-${f.index}`}>
                    {f.type} <span className="sx-muted">filament {f.index}</span>
                  </label>
                  <select id={`ps-map-${f.index}`} className="mini" value={map[f.index] ?? ''} onChange={(e) => setEdits({ ...edits, [f.index]: e.target.value })}>
                    {map[f.index] === undefined ? <option value="">Not loaded</option> : null}
                    {ask.slots
                      .filter((s) => s.id !== EXTERNAL_SLOT)
                      .map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.id} {s.material ?? ''}
                        </option>
                      ))}
                    <option value={EXTERNAL_SLOT}>External spool</option>
                  </select>
                </div>
              ))}
              {unmapped.length > 0 ? (
                <p className="ps-row-warn" role="alert">
                  No loaded slot has {unmapped.map((f) => f.type).join(', ')}. Pick one, or load it first.
                </p>
              ) : null}
              {dups.length > 0 ? (
                <p className="ps-row-warn" role="alert">
                  {dups.map(slotName).join(', ')} is picked for two filaments. Pick a different slot for each.
                </p>
              ) : null}
            </div>
          ) : null}
          {ask.specs.length > 0 && start ? (
            <section className="ps-opts" aria-label="Before the print">
              <p className="ps-opts-head">Before the print</p>
              {ask.specs.map((s) => (
                <div key={s.id} className="ps-opt">
                  <label htmlFor={`ps-opt-${s.id}`}>{s.label}</label>
                  <button type="button" className="ps-tip-btn" aria-label={`About ${s.label.toLowerCase()}`} data-tip-click="" {...tipAttrs({ title: s.label, body: optionTip(s) })}>
                    <Icon name="info" size={14} />
                  </button>
                  <Switch id={`ps-opt-${s.id}`} checked={Boolean(value[s.id])} onChange={(v) => setValue({ ...value, [s.id]: v })} />
                </div>
              ))}
            </section>
          ) : null}
          {mode === 'queue' ? (
            <div className="ps-when">
              <Field htmlFor="ps-when" label="Not before (optional)" hint="It waits in the queue on the Printers page and asks again before it starts.">
                <Input id="ps-when" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
              </Field>
            </div>
          ) : null}
        </div>
        {errors.length ? null : (
        <p className="ps-note">
          {start
            ? ask.bed === 'clear'
              ? `Uploads the file, then ${ask.printer.name} heats and starts.`
              : `Pressing it confirms the bed is empty and the right plate is on it. Then ${ask.printer.name} heats and starts.`
            : mode === 'upload'
              ? `Sends the file to ${ask.printer.name} and leaves it there. Nothing starts.`
              : `Uploads the file and adds it to the queue. It does not start on its own.`}
          {ask.specs.length > 0 ? ' Your choices are remembered for this printer.' : ''}
        </p>
        )}
    </Dialog>
  )
}

/** The dialog title: the printer's identity (its name, then its model) above the plate's name. */
function SheetTitle({ ask }: { ask: PrintSheetAsk }) {
  const st = STATE[ask.status?.state ?? ''] ?? { label: ask.status?.state ?? 'Unknown', pill: 'off' as const }
  const nozzle = ask.status?.nozzleDiameterMm
  return (
    <>
      <span className="ps-printer">
        <VendorMark vendor={ask.printer.vendor} size={18} />
        <span className="ps-printer-name">{ask.printer.name}</span>
        {ask.printer.model && ask.printer.model !== ask.printer.name ? <span className="ps-printer-model sx-muted">{ask.printer.model}</span> : null}
        <Pill state={st.pill}>{st.label}</Pill>
        {nozzle ? (
          <Chip mono icon="nozzle">
            {nozzle.toFixed(1)} mm
          </Chip>
        ) : null}
      </span>
      <span className="ps-title">Print {ask.plateName}</span>
    </>
  )
}

/** What will print, decided before the sheet opened: the picture, the file, time and weight, each filament and its slot. */
function Summary({ ask, fileName, map }: { ask: PrintSheetAsk; fileName: string; map: Record<number, string> | null }) {
  return (
    <section className="ps-summary" aria-label="What will print">
      <div className="ps-sum-top">
        {ask.thumb ? <img className="ps-thumb" src={ask.thumb} alt={`Picture of ${ask.plateName}`} /> : <span className="ps-thumb" aria-hidden="true"><Icon name="plate" size={26} /></span>}
        <div className="ps-sum-text">
          <p className="ps-file" data-checked={ask.check ? '' : undefined} {...tipAttrs(ask.check ? { title: fileName, body: `SHA-256 ${ask.check.sha256}` } : undefined)}>
            {fileName}
          </p>
          <p className="ps-meta">
            <span><Icon name="time" size={14} /> {formatDuration(ask.stats.timeS)}</span>
            <span><Icon name="weight" size={14} /> {ask.stats.grams > 0 ? `${ask.stats.grams.toFixed(1)} g` : 'not estimated'}</span>
            <span><Icon name="layers" size={14} /> {ask.stats.layers} layers</span>
          </p>
        </div>
      </div>
      {ask.filaments.length ? (
        <ul className="ps-fils" aria-label="Filaments">
          {ask.filaments.map((f) => (
            <li key={f.index} className="ps-fil">
              <i className="ps-swatch" style={{ background: f.color }} aria-hidden="true" />
              <span className="ps-fil-type">{f.type}</span>
              <span className="sx-muted">filament {f.index}</span>
              {map ? <span className="ps-fil-slot">{slotText(map[f.index])}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}
