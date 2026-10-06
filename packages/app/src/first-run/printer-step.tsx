// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Screen 1: the network scan finds the printer and reads model, nozzle and filament unit; picking
// one fills the form, asks only for what the printer cannot announce (a Bambu Lab access code), and
// the connection tests itself. A passing test reads the nozzles, AMS units and firmware into one
// confirm card. "Add it by hand" opens the brand, model, nozzle, connection and test sections with
// a mini stepper. Secret fields are uncontrolled inputs whose values live in a ref for the length
// of the screen: they never enter React state, the store or logs.
import { listPrinterProfiles } from '@slicerx/settings'
import { get, set, toast } from '../state/store'
import { connectionMethod, type ConnectionId, type ConnectionMethod, type FieldKey, type PrinterModel } from '@slicerx/printer-catalog'
import { Button, Chip, Field, Icon, Input, LinkButton, Pill, Seg, Select, type IconName } from '@slicerx/ui'
import { useCallback, useEffect, useMemo, useRef, useState, type FocusEvent, type ReactNode } from 'react'
import { useEdition, appName } from '../edition'
import { useHost } from '../host'
import { openLink } from '../lib/links'
import { EXPORT_PLUGIN } from '../lib/hand-printers'
import { degC } from '../lib/temp'
import { VendorMark } from '../lib/vendor-mark'
import { AccessCodeScreen } from './access-code-screen'
import { BambuLanCard } from './bambu-lan-card'
import { CodeCard } from './code-card'
import { ConfirmCard } from './confirm-card'
import { bambuFamily } from './bambu-lan'
import { printerImage } from './printer-images'
import { Footer, HelpPane, type FooterAction } from './frame'
import { topicFor, type HelpField } from './help-topics'
import { failureCopy, stepWord } from './test-failure'
import { OrbitPanel, useLongWait } from './raven-orbit'
import type { SetupPrinter } from './model'
import {
  addressOf,
  BRAND_TILES,
  brandTile,
  buildVolumeText,
  checkConnection,
  connectionChoices,
  currentModel,
  customErrors,
  EMPTY_FORM,
  extruderNozzles,
  FILAMENT_LABELS,
  filamentText,
  FIRMWARE_LABELS,
  isIPv4,
  modelLabel,
  modelsForTile,
  NOZZLE_SIZES,
  NOZZLE_TYPE_LABELS,
  NOZZLE_TYPES,
  nozzleError,
  nozzleMm,
  nozzleText,
  normalizeSecret,
  parseAddress,
  pickBrand,
  pickConnection,
  pickModel,
  profileIdOf,
  searchSetup,
  setFirmware,
  skipForm,
  testBlockers,
  tileForModel,
  typeIcon,
  unlocked,
  withHardware,
  type Blocker,
  type FilamentKind,
  type Firmware,
  type NozzleType,
  type PrinterForm,
  type SecretKey,
} from './printer-form'
import { displayCause, TEST_STEPS, type AppSetupHost, type FoundPrinter, type TestOutcome, type TestStep } from './setup-host'

// ---------------------------------------------------------------------------
// Controller: form state, secrets, test and scan. Lives in the flow so the setup skill can apply cards.

export type TestState =
  | { status: 'idle' }
  | { status: 'testing'; steps: TestStep[] }
  | { status: 'done'; outcome: TestOutcome }
  | { status: 'skipped' }

export type ScanState = { status: 'idle' } | { status: 'scanning' } | { status: 'done'; found: FoundPrinter[] } | { status: 'error'; message: string }

export interface PrinterController {
  form: PrinterForm
  setForm: (f: PrinterForm | ((f: PrinterForm) => PrinterForm)) => void
  setSecret: (key: SecretKey, value: string) => void
  test: TestState
  runTest: () => Promise<void>
  /** Stops a running test and forgets it. */
  cancelTest: () => void
  scan: ScanState
  runScan: () => Promise<void>
  /** Adds a printer found by "Enter IP instead" to the scan list. */
  addFound: (p: FoundPrinter) => void
  field: HelpField | null
  setField: (f: HelpField | null) => void
  save: () => Promise<SetupPrinter>
  /** Test or save exactly this form (the values an approval card showed), not whatever the screen holds now. */
  testFrom: (f: PrinterForm, strict: boolean) => Promise<TestOutcome | null>
  saveFrom: (f: PrinterForm, verified: boolean) => Promise<SetupPrinter>
  current: () => PrinterForm
  reset: () => void
  /** Accepted "The printer reports X. Use it?" notice, by the reported name. */
  keepReported: string | null
  setKeepReported: (v: string | null) => void
  host: AppSetupHost
  method: ConnectionMethod | null
}

export function usePrinterController(host: AppSetupHost): PrinterController {
  const [form, setFormState] = useState<PrinterForm>(EMPTY_FORM)
  const [test, setTest] = useState<TestState>({ status: 'idle' })
  const [scan, setScan] = useState<ScanState>({ status: 'idle' })
  const [field, setField] = useState<HelpField | null>(null)
  const [keepReported, setKeepReported] = useState<string | null>(null)
  const secrets = useRef(new Map<SecretKey, string>())
  const abort = useRef<AbortController | null>(null)
  const method = form.connection ? connectionMethod(form.connection) : null

  const formRef = useRef(form)
  const setForm = useCallback((f: PrinterForm | ((f: PrinterForm) => PrinterForm)) => {
    const prev = formRef.current
    let next = typeof f === 'function' ? f(prev) : f
    if (next === prev) return
    // A new connection or model invalidates the typed secrets and any earlier test. Otherwise the counts follow
    // what is typed: a change that rebuilt the form (picking the printer again, a reported model) must not
    // forget a code that is still in its field.
    if (next.connection !== prev.connection || next.modelId !== prev.modelId) secrets.current.clear()
    else {
      const typed = Object.fromEntries([...secrets.current].map(([k, v]) => [k, v.length])) as PrinterForm['secretLengths']
      if (JSON.stringify(typed) !== JSON.stringify(next.secretLengths)) next = { ...next, secretLengths: typed }
    }
    formRef.current = next
    if (next.connection !== prev.connection || next.fields !== prev.fields || JSON.stringify(next.secretLengths) !== JSON.stringify(prev.secretLengths) || next.modelId !== prev.modelId) {
      abort.current?.abort()
      setTest({ status: 'idle' })
    }
    setFormState(next)
  }, [])

  useEffect(() => () => abort.current?.abort(), [])

  const setSecret = useCallback(
    (key: SecretKey, raw: string) => {
      const value = normalizeSecret(key, raw)
      if (value) secrets.current.set(key, value)
      else secrets.current.delete(key)
      setForm((f) => ({ ...f, secretLengths: { ...f.secretLengths, [key]: value.length } }))
    },
    [setForm],
  )

  // Only a secret the form still counts goes out: Skip leaves out one that was not finished.
  const secretFor = (m: ConnectionMethod | null, form: PrinterForm): string | undefined => {
    if (!m) return undefined
    for (const k of ['accessCode', 'apiKey', 'password', 'pairing'] as const) {
      if (m.fields.some((f) => f.key === k) && (form.secretLengths[k] ?? 0) > 0 && secrets.current.get(k)) return secrets.current.get(k)
    }
    return undefined
  }

  const connectionInput = (f: PrinterForm, credential: string | undefined) => ({
    family: f.connection as ConnectionId,
    address: addressOf(f),
    ...(f.fields.serial.trim() ? { serial: f.fields.serial.trim() } : {}),
    ...(f.fields.username.trim() ? { username: f.fields.username.trim() } : {}),
    ...(credential ? { credential } : {}),
  })

  /** Tests the connection in `f`. `strict` waits for every field to validate (the button); the pilot path lets the test report. */
  const testFrom = useCallback(
    async (f: PrinterForm, strict: boolean): Promise<TestOutcome | null> => {
      const m = f.connection ? connectionMethod(f.connection) : null
      if (!m || m.id === 'export' || (strict && !checkConnection(f, m).ready)) return null
      abort.current?.abort()
      const ac = new AbortController()
      abort.current = ac
      setKeepReported(null)
      setTest({ status: 'testing', steps: TEST_STEPS.map(({ id }) => ({ id, ok: null })) })
      let outcome: TestOutcome
      try {
        outcome = await host.testConnection(connectionInput(f, secretFor(m, f)), (steps) => {
          if (!ac.signal.aborted) setTest({ status: 'testing', steps })
        }, { signal: ac.signal })
      } catch (e) {
        // A throw is not the printer's answer: the test stopped on this computer (the keychain, the bridge), so no step ran.
        outcome = { ok: false, steps: TEST_STEPS.map(({ id }) => ({ id, ok: null })), cause: 'local', message: e instanceof Error ? e.message : String(e) }
      }
      if (!ac.signal.aborted) setTest({ status: 'done', outcome })
      return outcome
    },
    [host],
  )

  const runTest = useCallback(async () => {
    await testFrom(formRef.current, true)
  }, [testFrom])

  const cancelTest = useCallback(() => {
    abort.current?.abort()
    setTest({ status: 'idle' })
  }, [])

  const runScan = useCallback(async () => {
    setScan({ status: 'scanning' })
    try {
      setScan({ status: 'done', found: await host.discover() })
    } catch (e) {
      setScan({ status: 'error', message: e instanceof Error ? e.message : String(e) })
    }
  }, [host])

  const addFound = useCallback((p: FoundPrinter) => {
    setScan((s) => ({ status: 'done', found: [...(s.status === 'done' ? s.found.filter((x) => x.id !== p.id) : []), p] }))
  }, [])

  const saveFrom = useCallback(
    async (f: PrinterForm, verified: boolean): Promise<SetupPrinter> => {
      const m = f.connection ? connectionMethod(f.connection) : null
      const { brand, model } = modelLabel(f)
      const nozzle = nozzleMm(f.nozzles[0] ?? EMPTY_FORM.nozzles[0]!) ?? 0.4
      const connected = m !== null && m.id !== 'export'
      const { printerId, credentialKept } = await host.addPrinter({ profileId: profileIdOf(f), nozzleMm: nozzle, name: f.name?.trim() || (model === 'Set up by hand' ? `${brand} printer` : model), ...(connected ? { connection: connectionInput(f, secretFor(m, f)) } : {}) })
      // The slice follows this size: it picks the presets that match the nozzle. A printer with more than one
      // nozzle keeps each, so every extruder slices with its own.
      const extruders = extruderNozzles(f)
      set((s) => ({ printerNozzles: { ...s.printerNozzles, [printerId]: nozzle }, ...(extruders ? { printerExtruders: { ...s.printerExtruders, [printerId]: extruders } } : {}) }))
      secrets.current.clear()
      if (credentialKept === 'session') toast(`${appName()} could not store the access code in your system keychain, so it is kept only until ${appName()} closes. You will be asked for it again next time.`, 'warn')
      return { printerId, brand, model, nozzle: nozzleText(f), connection: m?.name ?? 'Save G-code', state: !connected ? 'none' : verified ? 'verified' : 'unverified', filamentSystem: filamentText(f) }
    },
    [host],
  )

  const save = useCallback(() => saveFrom(formRef.current, test.status === 'done' && test.outcome.ok), [saveFrom, test])

  const reset = useCallback(() => {
    abort.current?.abort()
    secrets.current.clear()
    formRef.current = EMPTY_FORM
    setFormState(EMPTY_FORM)
    setTest({ status: 'idle' })
    setScan({ status: 'idle' })
    setKeepReported(null)
  }, [])

  return { form, setForm, setSecret, test, runTest, cancelTest, testFrom, scan, runScan, addFound, field, setField, save, saveFrom, current: () => formRef.current, reset, keepReported, setKeepReported, host, method }
}

// ---------------------------------------------------------------------------
// Manual sections

const SUBSTEPS = [
  { id: 'brand', label: 'Brand' },
  { id: 'model', label: 'Model' },
  { id: 'nozzle', label: 'Nozzle' },
  { id: 'connection', label: 'Connection' },
  { id: 'test', label: 'Test' },
] as const
type SubstepId = (typeof SUBSTEPS)[number]['id']

const CONNECTION_ICON: Partial<Record<ConnectionId, IconName>> = { export: 'sd-card', 'bambu-lan': 'wifi', moonraker: 'server', octoprint: 'server', prusalink: 'link', duet: 'ethernet', creality: 'wifi', elegoo: 'wifi', snapmaker: 'wifi', ultimaker: 'wifi', anycubic: 'wifi' }
const NOZZLE_ICON: Record<number, IconName> = { 0.2: 'nozzle-0-2', 0.4: 'nozzle-0-4', 0.6: 'nozzle-0-6', 0.8: 'nozzle-0-8' }

/** Brings a section into view without scrolling past the one being edited: only as far as needed, with 24 px to spare. */
function scrollTo(id: SubstepId, jump = false) {
  const el = document.getElementById(`fr-sec-${id}`)
  if (!el) return
  el.scrollIntoView({ block: jump ? 'start' : 'nearest', behavior: 'smooth' })
}

function Section({ id, title, locked, lockedText, children, answer }: { id: SubstepId; title: string; locked: boolean; lockedText: string; children: ReactNode; answer?: string | null }) {
  return (
    <section className="fr-sec" id={`fr-sec-${id}`} aria-labelledby={`fr-sec-${id}-h`} data-locked={locked ? true : undefined}>
      <div className="fr-sec-h">
        <h2 id={`fr-sec-${id}-h`}>{title}</h2>
        {answer ? <span className="fr-sec-ans sx-mono">{answer}</span> : null}
      </div>
      {locked ? <p className="fr-locked">{lockedText}</p> : children}
    </section>
  )
}

function BrandSection({ ctl, onNoPrinter }: { ctl: PrinterController; onNoPrinter: () => void }) {
  const [q, setQ] = useState('')
  const hits = useMemo(() => searchSetup(q), [q])
  const { form, setForm } = ctl
  return (
    <>
      <Input id="fr-brand-search" icon="search" placeholder="Search brand or model" aria-label="Search brand or model" value={q} onChange={(e) => setQ(e.target.value)} data-help="brand" />
      {hits.models.length ? (
        <ul className="fr-hits" aria-label="Matching models">
          {hits.models.map((m) => (
            <li key={m.id}>
              <button
                type="button"
                className="fr-hit"
                onClick={() => {
                  setForm((f) => pickModel(pickBrand(f, tileForModel(m)?.id ?? 'other'), m.id))
                  setQ('')
                  requestAnimationFrame(() => scrollTo('nozzle'))
                }}
              >
                <Icon name={typeIcon(m)} />
                {tileForModel(m)?.name} {m.name}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="fr-brands" role="radiogroup" aria-label="Brand">
        {hits.brands.map((b) => {
          const on = form.brand === b.id
          return (
            <button
              key={b.id}
              type="button"
              role="radio"
              aria-checked={on}
              className="fr-brand"
              data-on={on ? true : undefined}
              data-help="brand"
              onClick={() => {
                setForm((f) => pickBrand(f, b.id))
                requestAnimationFrame(() => scrollTo('model'))
              }}
            >
              <span className="fr-brand-mark">{b.handMade ? <Icon name="printer-custom" size={22} /> : <VendorMark vendor={b.name} size={22} />}</span>
              <span>{b.name}</span>
            </button>
          )
        })}
        {hits.brands.length === 0 && hits.models.length === 0 ? <p className="sx-muted sx-small">Nothing matches. Choose Other and set the bed and nozzle yourself.</p> : null}
      </div>
      <LinkButton icon="skip" onClick={onNoPrinter} className="fr-noprinter">
        I do not have a printer yet
      </LinkButton>
    </>
  )
}

function CustomFields({ ctl }: { ctl: PrinterController }) {
  const { form, setForm } = ctl
  const c = form.custom
  const errors = customErrors(c)
  const set = (patch: Partial<PrinterForm['custom']>) => setForm((f) => ({ ...f, custom: { ...f.custom, ...patch } }))
  const num = (key: 'width' | 'depth' | 'diameter' | 'height', label: string) => (
    <Field htmlFor={`fr-${key}`} label={label} error={c[key] && errors[key] ? errors[key] : undefined}>
      <Input id={`fr-${key}`} mono unit="mm" inputMode="decimal" value={c[key]} onChange={(e) => set({ [key]: e.target.value })} data-help="model" />
    </Field>
  )
  return (
    <div className="fr-custom">
      <p className="sx-small sx-muted">Set the bed and firmware yourself. You can refine the profile later in Printers.</p>
      <div className="fr-row2">
        <div>
          <span className="fr-lbl">Bed shape</span>
          <Seg label="Bed shape" size="sm" value={c.shape} onChange={(v) => set({ shape: v })} options={[{ value: 'rectangular', label: 'Rectangular' }, { value: 'circular', label: 'Circular' }]} />
        </div>
        <div>
          <span className="fr-lbl">Origin</span>
          <Seg label="Origin" size="sm" value={c.origin} onChange={(v) => set({ origin: v })} options={[{ value: 'front-left', label: 'Front left' }, { value: 'center', label: 'Center' }]} />
        </div>
      </div>
      <div className="fr-row3">
        {c.shape === 'rectangular' ? (
          <>
            {num('width', 'Width')}
            {num('depth', 'Depth')}
          </>
        ) : (
          num('diameter', 'Diameter')
        )}
        {num('height', 'Max height')}
      </div>
      <Field htmlFor="fr-firmware" label="Firmware">
        <Select id="fr-firmware" value={c.firmware} onChange={(e) => setForm((f) => setFirmware(f, e.target.value as Firmware))} data-help="firmware">
          {(Object.keys(FIRMWARE_LABELS) as Firmware[]).map((k) => (
            <option key={k} value={k}>
              {FIRMWARE_LABELS[k]}
            </option>
          ))}
        </Select>
      </Field>
    </div>
  )
}

/** A model's picture, or a drawn placeholder of its kind of machine when there is none or it fails to load. */
export function PrinterPicture({ model, brand }: { model: PrinterModel; brand: string }) {
  const src = printerImage(model.id)
  const [broken, setBroken] = useState(false)
  if (!src || broken) {
    return (
      <span className="fr-mcard-pic" data-empty="" aria-hidden="true">
        <Icon name={typeIcon(model)} size={48} />
      </span>
    )
  }
  return (
    <span className="fr-mcard-pic">
      <img src={src} alt={`${brand} ${model.name}`} width={120} height={120} loading="lazy" decoding="async" onError={() => setBroken(true)} />
    </span>
  )
}

function ModelSection({ ctl }: { ctl: PrinterController }) {
  const { form, setForm } = ctl
  const tile = brandTile(form.brand)
  const models = tile ? modelsForTile(tile) : []
  if (!tile) return null
  if (models.length === 0) return <CustomFields ctl={ctl} />
  return (
    <>
      <ul className="fr-modelgrid" role="radiogroup" aria-label={`${tile.name} models`}>
        {models.map((m: PrinterModel) => {
          const on = form.modelId === m.id
          return (
            <li key={m.id}>
              <button
                type="button"
                role="radio"
                aria-checked={on}
                className="fr-mcard"
                aria-label={m.name}
                data-on={on ? true : undefined}
                data-help="model"
                onClick={() => {
                  setForm((f) => pickModel(f, m.id))
                  requestAnimationFrame(() => scrollTo('model', true))
                }}
              >
                <PrinterPicture model={m} brand={tile.name} />
                <span className="fr-mcard-name">{m.name}</span>
              </button>
            </li>
          )
        })}
        <li>
          <button type="button" role="radio" aria-checked={form.modelId === 'custom'} className="fr-mcard" data-on={form.modelId === 'custom' ? true : undefined} data-help="model" onClick={() => setForm((f) => pickModel(f, 'custom'))}>
            <span className="fr-mcard-pic" data-empty="" aria-hidden="true">
              <Icon name="printer-custom" size={48} />
            </span>
            <span className="fr-mcard-name">Not listed, set it up by hand</span>
          </button>
        </li>
      </ul>
      {form.modelId === 'custom' ? <CustomFields ctl={ctl} /> : null}
      {currentModel(form)?.note ? <p className="fr-note">{currentModel(form)?.note}</p> : null}
    </>
  )
}

function NozzleSection({ ctl }: { ctl: PrinterController }) {
  const { form, setForm } = ctl
  const model = currentModel(form)
  // The sizes the printer's profile lists; the usual four when the model has no profile.
  const listed = model ? listPrinterProfiles().find((x) => x.id === model.id)?.nozzles : undefined
  const sizes: number[] = listed && listed.length ? [...listed].sort((a, b) => a - b) : [...NOZZLE_SIZES]
  const setNozzle = (i: number, patch: Partial<PrinterForm['nozzles'][number]>) => setForm((f) => ({ ...f, nozzleUnsure: false, nozzles: f.nozzles.map((n, j) => (j === i ? { ...n, ...patch } : n)) }))
  const abrasive = form.nozzles.some((n) => n.type !== 'hardened-steel' && n.type !== 'tungsten-carbide' && n.type !== 'ruby')
  const fil = form.filament
  return (
    <>
      {form.nozzles.map((n, i) => {
        const err = nozzleError(n)
        const value = n.size === null ? 'other' : String(n.size)
        return (
          <div className="fr-nozzle" key={i}>
            {form.nozzles.length > 1 ? <span className="fr-lbl">Extruder {i + 1}</span> : null}
            <div className="fr-nozzle-row" data-help="nozzle">
              <Seg
                label={form.nozzles.length > 1 ? `Nozzle diameter, extruder ${i + 1}` : 'Nozzle diameter'}
                value={value}
                mono
                options={[
                  ...sizes.map((s) => ({ value: String(s), label: `${s} mm`, icon: NOZZLE_ICON[s] ?? 'nozzle', ...(model && !model.nozzles.includes(s) ? { title: 'Not sold for this model' } : {}) })),
                  { value: 'other', label: 'Other' },
                ]}
                onChange={(v) => setNozzle(i, v === 'other' ? { size: null } : { size: Number(v) })}
              />
              {n.size === null ? (
                <Field htmlFor={`fr-noz-${i}`} label="Diameter" error={n.other ? (err ?? undefined) : undefined}>
                  <Input id={`fr-noz-${i}`} mono unit="mm" inputMode="decimal" placeholder="0.1 to 2.0" value={n.other} onChange={(e) => setNozzle(i, { other: e.target.value })} data-help="nozzle" />
                </Field>
              ) : null}
            </div>
            <Field htmlFor={`fr-noztype-${i}`} label="Nozzle type">
              <Select id={`fr-noztype-${i}`} value={n.type} onChange={(e) => setNozzle(i, { type: e.target.value as NozzleType })} data-help="nozzle-type">
                {NOZZLE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {NOZZLE_TYPE_LABELS[t]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        )
      })}
      {abrasive ? <p className="fr-note">Hardened steel is required for carbon fiber and glow filaments.</p> : null}
      <label className="fr-check" data-help="nozzle">
        <input
          type="checkbox"
          checked={form.nozzleUnsure}
          onChange={(e) => setForm((f) => (e.target.checked ? { ...f, nozzleUnsure: true, nozzles: f.nozzles.map(() => ({ size: 0.4, other: '', type: 'brass' as const })) } : { ...f, nozzleUnsure: false }))}
        />
        Not sure. Use 0.4 mm brass and ask me to confirm it later in Printers.
      </label>
      <div className="fr-row2">
        <div data-help="toolhead">
          <span className="fr-lbl">Toolhead</span>
          <Seg label="Toolhead" size="sm" value={form.toolhead} onChange={(v) => setForm((f) => ({ ...f, toolhead: v }))} options={[{ value: 'direct', label: 'Direct drive', icon: 'direct-drive' }, { value: 'bowden', label: 'Bowden', icon: 'bowden' }]} />
        </div>
        <div className="fr-fil" data-help="filament">
          <Field htmlFor="fr-fil" label="Filament system">
            <Select id="fr-fil" value={fil.kind} onChange={(e) => setForm((f) => ({ ...f, filament: { ...f.filament, kind: e.target.value as FilamentKind, slots: e.target.value === 'mmu' ? 5 : e.target.value === 'other' ? 4 : f.filament.slots } }))}>
              {(Object.keys(FILAMENT_LABELS) as FilamentKind[]).map((k) => (
                <option key={k} value={k}>
                  {FILAMENT_LABELS[k]}
                </option>
              ))}
            </Select>
          </Field>
          {fil.kind === 'ams' ? (
            <Field htmlFor="fr-ams" label="AMS units">
              <Select id="fr-ams" value={String(fil.units)} onChange={(e) => setForm((f) => ({ ...f, filament: { ...f.filament, units: Number(e.target.value), slots: Number(e.target.value) * 4 } }))}>
                {[1, 2, 3, 4].map((u) => (
                  <option key={u} value={u}>
                    {u} ({u * 4} slots)
                  </option>
                ))}
              </Select>
            </Field>
          ) : fil.kind === 'mmu' || fil.kind === 'other' ? (
            <Field htmlFor="fr-slots" label="Slots">
              <Select id="fr-slots" value={String(fil.slots)} onChange={(e) => setForm((f) => ({ ...f, filament: { ...f.filament, slots: Number(e.target.value) } }))}>
                {[2, 3, 4, 5, 6, 8, 12, 16].map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
        </div>
      </div>
    </>
  )
}

function SecretInput({ id, fieldKey, label, required, placeholder, ctl, keychain }: { id: string; fieldKey: SecretKey; label: string; required: boolean; placeholder?: string | undefined; ctl: PrinterController; keychain: boolean }) {
  const [shown, setShown] = useState(false)
  const error = ctl.method ? checkConnection(ctl.form, ctl.method).errors[fieldKey] : undefined
  const typed = (ctl.form.secretLengths[fieldKey] ?? 0) > 0
  // An access code is read off the printer's screen, not a password: shown as typed, with no show and hide.
  const code = fieldKey === 'accessCode'
  const { setSecret } = ctl
  // The field is the truth. A value that arrived without an input event (autofill, a paste some webviews do not
  // report) is read when the field mounts and when it loses focus, so the count never says empty beside a code.
  const sync = useCallback((value: string) => setSecret(fieldKey, value), [setSecret, fieldKey])
  useEffect(() => {
    const el = document.getElementById(id) as HTMLInputElement | null
    if (el?.value) sync(el.value)
  }, [id, sync])
  return (
    <Field
      htmlFor={id}
      label={`${label}${required ? '' : ' (optional)'}`}
      error={typed && error ? error : undefined}
      hint={keychain ? 'Stored in your system keychain.' : `This browser has no system keychain, so it is used for the test only and not saved. The desktop app or ${appName()} Link keeps it in the keychain.`}
      {...(code
        ? {}
        : {
            aside: (
              <button type="button" className="fr-textbtn" aria-controls={id} aria-pressed={shown} onClick={() => setShown(!shown)}>
                {shown ? 'Hide' : 'Show'}
              </button>
            ),
          })}
    >
      <Input
        id={id}
        mono={!code}
        className={code ? 'fr-code-input' : undefined}
        type={code || shown ? 'text' : 'password'}
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        {...(code ? { maxLength: 16, placeholder: 'xxxx xxxx' } : { placeholder })}
        onChange={(e) => sync(e.target.value)}
        onInput={(e) => sync(e.currentTarget.value)}
        onBlur={(e) => sync(e.currentTarget.value)}
        data-help={fieldKey}
        data-secret="true"
      />
    </Field>
  )
}

/** Focuses the input of a connection field. */
function focusField(key: FieldKey) {
  document.getElementById(`fr-f-${key}`)?.focus()
}

/** The footer's short reason for a disabled Test connection. */
export function blockerHint(blockers: Blocker[]): string | undefined {
  const first = blockers[0]
  if (!first) return undefined
  return blockers.length === 1 ? first.text : `${first.text} ${blockers.length - 1} more ${blockers.length === 2 ? 'field needs' : 'fields need'} attention above.`
}

/** Why Test connection is off, field by field. Each line moves focus to its field. */
export function WhyNotReady({ blockers }: { blockers: Blocker[] }) {
  if (blockers.length === 0) return null
  return (
    <div id="fr-test-why" role="status" aria-live="polite">
      <p className="fr-why-h">Test connection is off until these are fixed:</p>
      <ul className="fr-why">
        {blockers.map((b) => (
          <li key={b.field}>
            <Icon name="alert" size={14} />
            <button type="button" onClick={() => focusField(b.field)}>
              {b.text}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Blockers for fields the person has typed in. An untouched empty field is not an error yet. */
export function typedBlockers(blockers: Blocker[], form: PrinterForm): Blocker[] {
  return blockers.filter((b) => {
    if (b.field === 'host' || b.field === 'serial' || b.field === 'username' || b.field === 'port') return form.fields[b.field].trim() !== ''
    return (form.secretLengths[b.field as SecretKey] ?? 0) > 0
  })
}

function ConnectionSection({ ctl, keychain, onWhere, fieldsOnly, known, quiet }: { ctl: PrinterController; keychain: boolean; onWhere: (f: HelpField) => void; fieldsOnly?: boolean; known?: Partial<Record<'host' | 'serial', boolean>>; quiet?: boolean }) {
  const { form, setForm, method, scan } = ctl
  const choices = connectionChoices(form)
  const check = method ? checkConnection(form, method) : null
  const setField = (k: 'host' | 'port' | 'serial' | 'username', v: string) => setForm((f) => ({ ...f, fields: { ...f.fields, [k]: v } }))
  const where = (f: HelpField) => (
    <button type="button" className="fr-textbtn" onClick={() => onWhere(f)}>
      Where do I find this?
    </button>
  )
  return (
    <>
      {fieldsOnly ? null : (
      <div className="fr-conns" role="radiogroup" aria-label="Connection type">
        {choices.map((id, i) => {
          const m = connectionMethod(id)
          const on = form.connection === id
          return (
            <button key={id} type="button" role="radio" aria-checked={on} className="fr-conn" data-on={on ? true : undefined} data-help="connection" onClick={() => setForm((f) => pickConnection(f, id))}>
              <Icon name={CONNECTION_ICON[id] ?? 'link'} />
              <span className="min0">
                <b>
                  {id === 'export' ? 'No connection (export files)' : m.name}
                  {i === 0 && id !== 'export' ? <Chip tone="green">Most likely</Chip> : null}
                </b>
                <small>{m.summary}</small>
              </span>
            </button>
          )
        })}
      </div>
      )}
      {method?.id === 'bambu-lan' && !fieldsOnly ? <BambuLanCard family={bambuFamily(currentModel(form)?.name)} /> : null}
      {method && method.id !== 'export' ? (
        <div className="fr-fields">
          {method.fields.map((f) => {
            const id = `fr-f-${f.key}`
            // What the printer announced (address, serial number) is not asked again.
            if ((f.key === 'host' || f.key === 'serial') && known?.[f.key] && !check?.errors[f.key]) return null
            if (f.key === 'host') {
              return (
                <div key={f.key} className="fr-hostrow">
                  <Field htmlFor={id} label={f.label} error={form.fields.host && check?.errors.host ? check.errors.host : undefined} aside={where('host')}>
                    <Input id={id} mono placeholder={method.id === 'moonraker' ? 'http://printer.local:7125' : (f.placeholder ?? '192.168.1.50')} value={form.fields.host} onChange={(e) => setField('host', e.target.value)} data-help="host" autoComplete="off" spellCheck={false} />
                  </Field>
                  {method.discovery.kind !== 'manual' && !fieldsOnly ? (
                    <Button icon="search" onClick={() => void ctl.runScan()} disabled={scan.status === 'scanning'}>
                      {scan.status === 'scanning' ? 'Looking' : 'Find on my network'}
                    </Button>
                  ) : null}
                </div>
              )
            }
            if (f.key === 'port') {
              return (
                <Field key={f.key} htmlFor={id} label={`${f.label} (optional)`} error={check?.errors.port} aside={where('port')}>
                  <Input id={id} mono inputMode="numeric" placeholder={f.placeholder ?? String(method.defaultPort ?? '')} value={form.fields.port} onChange={(e) => setField('port', e.target.value)} data-help="port" />
                </Field>
              )
            }
            if (f.key === 'serial' || f.key === 'username') {
              const k = f.key
              return (
                <Field key={f.key} htmlFor={id} label={`${f.label}${f.required ? '' : ' (optional)'}`} error={form.fields[k] && check?.errors[k] ? check.errors[k] : undefined} aside={where(k)}>
                  <Input id={id} mono placeholder={f.placeholder} value={form.fields[k]} onChange={(e) => setField(k, e.target.value)} data-help={k} autoComplete="off" spellCheck={false} />
                </Field>
              )
            }
            if (f.key === 'pairing') return <p key={f.key} className="fr-note" data-help="pairing">{method.summary} Keep the printer screen in view when you test.</p>
            const input = <SecretInput key={`${method.id}-${form.modelId}-${f.key}`} id={id} fieldKey={f.key as SecretKey} label={f.label} required={f.required} placeholder={f.placeholder} ctl={ctl} keychain={keychain} />
            if (f.key !== 'accessCode' || method.id !== 'bambu-lan') return input
            // Where the code is, drawn on the printer's own screen; a model we cannot place gets the plain words.
            const fam = bambuFamily(currentModel(form)?.name)
            return (
              <div key={`${method.id}-${form.modelId}-${f.key}`} className="fr-acfield">
                {input}
                {fam ? <AccessCodeScreen family={fam} /> : <p className="fr-note">Check your printer's network settings for the LAN Only page. The access code is shown there.</p>}
              </div>
            )
          })}
          {scan.status === 'scanning' && !fieldsOnly ? (
            <p className="fr-scan" role="status">
              <span className="fr-spin" aria-hidden="true" /> Looking on {ctl.host.scanRange}. This lists printers only; nothing connects.
            </p>
          ) : null}
          {scan.status === 'done' && !fieldsOnly ? (
            scan.found.length ? (
              <ul className="fr-found" aria-label="Printers found">
                {scan.found.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      className="fr-hit"
                      onClick={() => setForm((f) => ({ ...f, connection: (choices.includes(p.family as ConnectionId) ? p.family : f.connection) as ConnectionId, fields: { ...f.fields, host: p.address ?? f.fields.host, serial: p.serial ?? f.fields.serial } }))}
                    >
                      <Icon name="printer" />
                      {p.name}
                      <span className="sx-mono sx-dim">{p.address}</span>
                      {p.model ? <span className="sx-dim">{p.model}</span> : null}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="fr-note">No printers answered. Enter the IP address shown on the printer.</p>
            )
          ) : null}
          {scan.status === 'error' && !fieldsOnly ? <p className="app-err">{scan.message}</p> : null}
          {check && !check.ready ? <WhyNotReady blockers={quiet ? typedBlockers(testBlockers(form, method), form) : testBlockers(form, method)} /> : null}
          {check?.warnings.map((w) => (
            <p key={w} className="fr-warn" role="status">
              <Icon name="warning" size={16} /> {w}
            </p>
          ))}
        </div>
      ) : method ? (
        <p className="fr-note">{appName()} saves G-code for you to copy to the printer on USB or an SD card. You can connect it later in Printers.</p>
      ) : null}
    </>
  )
}

function redact(outcome: TestOutcome, form: PrinterForm): string {
  const m = form.connection ? connectionMethod(form.connection).name : 'none'
  const lines = [`Connection: ${m}`, `Address: ${addressOf(form)}`, `Result: ${outcome.ok ? 'connected' : `failed (${outcome.cause ?? 'unknown'})`}`]
  for (const s of outcome.steps) lines.push(`${s.id}: ${s.ok === null ? 'not reached' : s.ok ? 'ok' : 'failed'}${s.ms !== undefined ? ` ${(s.ms / 1000).toFixed(1)} s` : ''}`)
  if (outcome.kind) lines.push(`Kind: ${outcome.kind}`)
  if (outcome.details ?? outcome.message) lines.push(`Details: ${outcome.details ?? outcome.message}`)
  if (outcome.certificate) lines.push(`Certificate: ${outcome.certificate.verified ? 'issued by Bambu Lab for this printer' : 'not verified'} (${outcome.certificate.detail})`)
  // Credentials never reach this function; the serial number is shortened as well.
  if (form.fields.serial) lines.push(`Serial: ${form.fields.serial.slice(0, 4)}...`)
  return lines.join('\n')
}

/** "X1 Carbon, 0.4 mm nozzle, AMS with 4 slots": what a passing test read from the printer. */
export function readText(o: TestOutcome): string {
  const parts: string[] = []
  if (o.reportedModel) parts.push(o.reportedModel)
  if (o.nozzleMm) parts.push(`${o.nozzleMm} mm nozzle`)
  if (o.filamentSystem) parts.push(`${FILAMENT_LABELS[o.filamentSystem === 'toolchanger' ? 'other' : o.filamentSystem]}${o.slotCount ? ` with ${o.slotCount} slots` : ''}`)
  return parts.join(', ')
}

/** "Bambu Lab H2D "Workshop" at 192.168.1.52. Serial number read from the printer.": the line under a picked printer. */
export function foundText(p: FoundPrinter): string {
  const model = matchFound(p)
  const label = model ? `${tileForModel(model)?.name ?? ''} ${model.name}`.trim() : (p.model ?? p.name)
  const host = p.address ? (parseAddress(p.address)?.host ?? p.address) : null
  const named = p.name && p.name !== p.model && p.name !== p.address ? ` "${p.name}"` : ''
  const read = p.serial ? ' Model and serial number read from the printer.' : ''
  return `${label}${named}${host ? ` at ${host}` : ''}.${read}`
}

/** "H2D, left nozzle 0.6 mm and right nozzle 0.4 mm": what a passing test read, for the success line. */
export function connectedText(o: TestOutcome, modelName: string | undefined): string {
  const model = o.reportedModel ?? modelName
  const ex = (o.hardware?.extruders ?? []).filter((e) => e.nozzleDiameterMm !== undefined)
  const nozzles = ex.length > 1 ? ex.map((e) => `${e.position ? `${e.position} nozzle ` : ''}${e.nozzleDiameterMm} mm`).join(' and ') : ex[0] ? `${ex[0].nozzleDiameterMm} mm nozzle` : o.nozzleMm ? `${o.nozzleMm} mm nozzle` : ''
  return [model, nozzles].filter(Boolean).join(', ')
}

export function TestCard({ ctl, onUseReported }: { ctl: PrinterController; onUseReported: (name: string) => void }) {
  const { test, form, method } = ctl
  const edition = useEdition()
  const [copied, setCopied] = useState(false)
  const ready = method ? checkConnection(form, method).ready : false
  const steps = test.status === 'testing' ? test.steps : test.status === 'done' ? test.outcome.steps : null
  const outcome = test.status === 'done' ? test.outcome : null
  const picked = currentModel(form)
  const reported = outcome?.ok && outcome.reportedModel && picked && !outcome.reportedModel.toLowerCase().includes(picked.name.toLowerCase()) ? outcome.reportedModel : null
  const failed = outcome && !outcome.ok ? failureCopy(outcome, { address: parseAddress(form.fields.host)?.host ?? form.fields.host, family: form.connection, model: picked?.name }) : null
  const failStep = outcome && !outcome.ok ? TEST_STEPS.find((s) => outcome.steps.find((x) => x.id === s.id)?.ok === false) : undefined
  const sendReport = (o: TestOutcome) => {
    set({ bugReportDraft: { title: `Printer connection test failed: ${method?.name ?? 'printer'}`, happened: redact(o, form) }, bugReportOpen: true })
  }
  const site = edition.apps.web.origin
  // a test past 1.2 s gets the ravens; they land if it ends well
  const long = useLongWait(test.status === 'testing', test.status === 'idle')
  const orbit = long && (test.status === 'testing' || outcome?.ok) && steps
  const who = form.name || picked?.name || 'the printer'
  return (
    <div className="fr-test" data-state={test.status === 'done' ? (outcome?.ok ? 'ok' : 'bad') : test.status} aria-live="polite">
      {orbit ? <OrbitPanel title={test.status === 'testing' ? `Connecting to ${who}` : ''} steps={steps} method={method} landed={test.status !== 'testing'} onCancel={ctl.cancelTest} /> : null}
      {test.status === 'idle' ? <p className="fr-test-idle">{ready ? 'Not tested.' : 'Not tested. Test connection turns on once the connection fields above are complete.'}</p> : null}
      {test.status === 'skipped' ? (
        <p>
          <Pill state="warn">Not verified</Pill> Saved without a test.
        </p>
      ) : null}
      {test.status === 'testing' ? <div className="fr-test-line" aria-hidden="true" /> : null}
      {outcome?.ok ? (
        <>
          <p className="fr-ok" role="status">
            <Icon name="check" size={18} />
            <span>
              <b>Connected</b>
              {form.name ? ` to ${form.name}` : ''}
              {connectedText(outcome, picked?.name) ? `: ${connectedText(outcome, picked?.name)}.` : '.'}
            </span>
          </p>
          <p className="fr-test-facts sx-dim">
            {outcome.nozzleC !== undefined ? `Nozzle ${degC(outcome.nozzleC)}, ` : ''}
            {outcome.bedC !== undefined ? `bed ${degC(outcome.bedC)}, ` : ''}
            {outcome.state ?? 'idle'}.
            {outcome.firmware ? <span className="sx-mono"> Firmware {outcome.firmware}.</span> : null}
          </p>
        </>
      ) : null}
      {reported && ctl.keepReported !== reported ? (
        <div className="fr-notice" role="status">
          <Icon name="alert" size={16} /> The printer reports {reported}. Use it?
          <span className="fr-notice-act">
            <Button size="sm" onClick={() => onUseReported(reported)}>
              Use
            </Button>
            <Button size="sm" variant="ghost" onClick={() => ctl.setKeepReported(reported)}>
              Keep
            </Button>
          </span>
        </div>
      ) : null}
      {failed && outcome ? (
        <div className="fr-test-bad" data-kind={failed.kind}>
          <p className="fr-test-bad-h">
            <Icon name="alert" size={18} /> {failed.title}
          </p>
          <p>{failed.body}</p>
          {failed.tips.length ? (
            <ul className="fr-tips">
              {failed.tips.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          ) : null}
          <div className="fr-test-acts">
            {failed.actions.includes('retry') ? (
              <Button size="sm" icon="refresh" onClick={() => void ctl.runTest()} disabled={!ready}>
                Try again
              </Button>
            ) : null}
            {failed.actions.includes('report') ? (
              <Button size="sm" icon="bug" onClick={() => sendReport(outcome)}>
                Send a report
              </Button>
            ) : null}
            {failed.actions.includes('update') && site ? (
              <Button size="sm" variant="ghost" icon="external" onClick={() => void openLink(site)}>
                Update {appName()}
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              icon="copy"
              onClick={() => {
                void navigator.clipboard?.writeText(redact(outcome, form)).then(() => setCopied(true))
              }}
            >
              {copied ? 'Copied' : 'Copy details'}
            </Button>
          </div>
          {failStep ? <span className="sr-only">{failStep.label} failed.</span> : null}
        </div>
      ) : null}
      {steps && !orbit ? (
        <ol className="fr-checks">
          {TEST_STEPS.map((s) => {
            const st = steps.find((x) => x.id === s.id)
            const state = st?.running ? 'run' : st?.ok === true ? 'ok' : st?.ok === false ? 'bad' : 'wait'
            return (
              <li key={s.id} data-state={state}>
                <Icon name={state === 'ok' ? 'check' : state === 'bad' ? 'close' : state === 'run' ? 'refresh' : 'minus'} size={15} />
                <span>{s.label}</span>
                <span className="fr-step-word">{stepWord(st?.ok, st?.running)}</span>
                <span className="sx-mono sx-dim">{st?.ms !== undefined ? `${(st.ms / 1000).toFixed(1)} s` : state === 'run' ? '...' : ''}</span>
              </li>
            )
          })}
        </ol>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// The scan path: pick a printer the network announced.

const STATE_PILL: Partial<Record<NonNullable<FoundPrinter['state']>, { state: 'ok' | 'warn' | 'off' | 'run'; text: string }>> = {
  idle: { state: 'ok', text: 'Idle' },
  printing: { state: 'run', text: 'Printing' },
  paused: { state: 'warn', text: 'Paused' },
  finished: { state: 'ok', text: 'Finished' },
  error: { state: 'warn', text: 'Error' },
  offline: { state: 'off', text: 'Offline' },
}

/** The catalog model a scan result stands for: the announced name, then the name with leading vendor words dropped. */
export function matchFound(p: FoundPrinter): PrinterModel | undefined {
  const words = (p.model ?? p.name).split(/\s+/).filter(Boolean)
  for (let k = 0; k < Math.max(1, words.length - 1); k++) {
    const hit = searchSetup(words.slice(k).join(' ')).models[0]
    if (hit) return hit
  }
  return undefined
}

/** The form for a printer the scan found: its model, what it reported, its connection and address. */
export function adoptFound(form: PrinterForm, p: FoundPrinter): PrinterForm {
  const model = matchFound(p)
  let next = model ? pickModel(pickBrand(form, tileForModel(model)?.id ?? 'other'), model.id) : pickBrand(form, 'other')
  const family = p.family as ConnectionId
  if (connectionChoices(next).includes(family) || CONNECTION_METHOD_IDS.has(family)) next = { ...next, connection: family, secretLengths: {} }
  if (p.nozzleMm) {
    const size = (NOZZLE_SIZES as readonly number[]).includes(p.nozzleMm) ? p.nozzleMm : null
    next = { ...next, nozzleUnsure: false, nozzles: next.nozzles.map((n) => ({ ...n, size, other: size === null ? String(p.nozzleMm) : '' })) }
  }
  if (p.filamentSystem) next = { ...next, filament: filamentFor(p.filamentSystem, p.slotCount) }
  // Host and port apart: the usual port of the connection is left out, any other goes in the port field.
  const a = p.address ? parseAddress(p.address) : null
  const usual = next.connection ? connectionMethod(next.connection).defaultPort : undefined
  const port = a?.port !== undefined && a.port !== usual ? String(a.port) : ''
  const named = p.name && p.name !== p.address && p.name !== p.model ? { name: p.name } : {}
  return { ...next, ...named, fields: { ...next.fields, host: a?.host ?? p.address ?? '', port, serial: p.serial ?? '' } }
}

const CONNECTION_METHOD_IDS = new Set<string>(['bambu-lan', 'moonraker', 'octoprint', 'prusalink', 'duet', 'creality', 'snapmaker', 'elegoo', 'ultimaker', 'anycubic'])

function filamentFor(system: 'ams' | 'mmu' | 'toolchanger', slots?: number): PrinterForm['filament'] {
  if (system === 'ams') {
    const units = Math.max(1, Math.ceil((slots ?? 4) / 4))
    return { kind: 'ams', units, slots: units * 4 }
  }
  if (system === 'mmu') return { kind: 'mmu', units: 1, slots: slots ?? 5 }
  return { kind: 'single', units: 1, slots: slots ?? 1 }
}

/**
 * "Enter IP instead": asks one address directly (a Bambu Lab printer answers with its model and serial
 * number) and lists what answered. When nothing does, the hand-made form opens with the address in it.
 */
function EnterIp({ ctl, onFound, onNothing }: { ctl: PrinterController; onFound: (p: FoundPrinter) => void; onNothing: (ip: string) => void }) {
  const [ip, setIp] = useState('')
  const [state, setState] = useState<{ status: 'idle' | 'asking' } | { status: 'none' | 'bad'; text: string }>({ status: 'idle' })
  const look = async () => {
    const v = ip.trim()
    if (!v) {
      // Nothing typed yet: no error, just the field.
      document.getElementById('fr-enterip')?.focus()
      return
    }
    if (!isIPv4(v)) {
      setState({ status: 'bad', text: `"${v}" is not an IP address. Use four numbers such as 192.168.1.50, shown on the printer's network screen.` })
      return
    }
    setState({ status: 'asking' })
    let found: FoundPrinter[] = []
    try {
      found = ctl.host.probe ? await ctl.host.probe(v) : []
    } catch {
      found = []
    }
    const hit = found[0]
    if (hit) {
      setState({ status: 'idle' })
      onFound(hit)
    } else {
      setState({ status: 'none', text: `Nothing announced itself at ${v}. That is normal for Klipper, OctoPrint and PrusaLink printers: pick the brand and model, and the address is filled in.` })
    }
  }
  return (
    <form
      className="fr-enterip"
      onSubmit={(e) => {
        e.preventDefault()
        void look()
      }}
    >
      <Field htmlFor="fr-enterip" label="Printer IP address">
        <Input id="fr-enterip" mono placeholder="192.168.1.50" inputMode="decimal" autoComplete="off" spellCheck={false} value={ip} onChange={(e) => setIp(e.target.value)} {...(state.status === 'bad' ? { 'aria-invalid': true, 'aria-describedby': 'fr-enterip-msg' } : {})} />
      </Field>
      <Button type="submit" icon="search" disabled={state.status === 'asking'}>
        {state.status === 'asking' ? 'Asking' : 'Look up'}
      </Button>
      {state.status === 'bad' ? (
        <p className="fr-enterip-msg" id="fr-enterip-msg" data-tone="error" role="alert">
          {state.text}
        </p>
      ) : null}
      {state.status === 'none' ? (
        <p className="fr-enterip-msg" role="status">
          {state.text}{' '}
          <LinkButton icon="plus" onClick={() => onNothing(ip.trim())}>
            Add it by hand
          </LinkButton>
        </p>
      ) : null}
    </form>
  )
}

function FoundList({ ctl, picked, onPick, onClear, enterIp }: { ctl: PrinterController; picked: FoundPrinter | null; onPick: (p: FoundPrinter) => void; onClear: () => void; enterIp: ReactNode }) {
  const { scan } = ctl
  const pickedId = picked?.id ?? null
  // A picked printer stays on screen whatever a later scan finds.
  if (!picked && (scan.status === 'idle' || scan.status === 'scanning')) {
    return (
      <div className="fr-scanning" role="status">
        <div className="fr-test-line" aria-hidden="true" />
        <Icon name="connect-scan" size={22} />
        <p>Looking on {ctl.host.scanRange}. This asks printers to announce themselves; nothing signs in.</p>
      </div>
    )
  }
  if (!picked && scan.status === 'error') {
    return (
      <p className="app-err" role="alert">
        The scan failed: {scan.message}
      </p>
    )
  }
  const found = scan.status === 'done' ? scan.found : []
  if (!picked && found.length === 0) {
    return (
      <div className="fr-none">
        <Icon name="connect-fail" size={22} />
        <div>
          <b>No printer answered.</b>
          <p>Check that the printer is on and on the same network as this computer (not a guest network). Klipper printers need Moonraker. Then scan again, or enter the printer's IP address.</p>
          {enterIp}
        </div>
      </div>
    )
  }
  // Once one is picked the others fold away, so the connection and its test stay in view.
  const shown = picked ? [picked] : found
  return (
    <>
    <ul className="fr-foundlist" role="radiogroup" aria-label="Printers found">
      {shown.map((p) => {
        const on = p.id === pickedId
        const model = matchFound(p)
        const vendor = model ? (tileForModel(model)?.name ?? model.brand) : (p.model ?? p.name).split(' ')[0] ?? ''
        const pill = p.family === EXPORT_PLUGIN ? { state: 'off' as const, text: 'Export only' } : p.state ? STATE_PILL[p.state] : undefined
        return (
          <li key={p.id}>
            <button type="button" role="radio" aria-checked={on} className="fr-foundcard" data-on={on ? true : undefined} onClick={() => onPick(p)}>
              <span className="fr-brand-mark">{model ? <VendorMark vendor={vendor} size={26} /> : <Icon name="printer" size={24} />}</span>
              <span className="fr-found-main">
                <span className="fr-found-name">
                  {p.model ?? p.name}
                  {pill ? <Pill state={pill.state}>{pill.text}</Pill> : null}
                </span>
                <span className="fr-found-facts">
                  <Chip mono>{p.name}</Chip>
                  {p.address ? <Chip mono>{p.address}</Chip> : null}
                  {p.firmware ? <Chip mono>Firmware {p.firmware}</Chip> : null}
                  {p.lanOnly === false ? <Chip tone="orange">LAN Only Mode off</Chip> : null}
                  {p.nozzleMm ? <Chip mono icon="nozzle">{p.nozzleMm} mm</Chip> : null}
                  {p.filamentSystem ? <Chip icon="ams-unit">{model?.filamentUnit ?? FILAMENT_LABELS[p.filamentSystem === 'toolchanger' ? 'other' : p.filamentSystem]}{p.slotCount ? `, ${p.slotCount} slots` : ''}</Chip> : null}
                  {!model ? <Chip tone="orange">Not in the catalog</Chip> : null}
                </span>
              </span>
              <span className="fr-radio" aria-hidden="true" />
            </button>
          </li>
        )
      })}
    </ul>
    {picked && found.length > 1 ? (
      <LinkButton icon="list" className="fr-found-other" onClick={onClear}>
        Choose a different printer
      </LinkButton>
    ) : null}
    </>
  )
}

// ---------------------------------------------------------------------------
// Screen

export function PrinterStep({
  ctl,
  onBack,
  onSkip,
  onSaved,
  onNoPrinter,
  helpVisible,
  phone,
}: {
  ctl: PrinterController
  onBack: (() => void) | null
  onSkip: () => void
  onSaved: (p: SetupPrinter) => void
  onNoPrinter: () => void
  helpVisible: boolean
  phone: boolean
}) {
  const host = useHost()
  const { form, setForm, method, test } = ctl
  const [mode, setMode] = useState<'scan' | 'manual'>(() => (get().setup?.byHand ? 'manual' : 'scan'))
  // The printer picked from the scan, kept whole: a scan that runs again (by hand, or because setup opened at
  // launch while the bridge was still starting) must not take its address and serial number away.
  const [picked, setPicked] = useState<FoundPrinter | null>(null)
  const pickedId = picked?.id ?? null
  const setPickedId = (id: null) => setPicked(id)
  const [editDetails, setEditDetails] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [helpOpen, setHelpOpen] = useState(false)
  const [askIp, setAskIp] = useState(false)
  // An address typed in "Enter IP instead" waits for the hand-made form's connection fields.
  const typedHost = useRef<string | null>(null)
  const open = unlocked(form)
  const model = currentModel(form)
  const topic = topicFor('printer', mode === 'scan' && (ctl.field === null || ctl.field === 'brand') ? 'scan' : ctl.field, { connection: form.connection, ...(model ? { model } : {}) })
  const check = method ? checkConnection(form, method) : null
  const outcome = test.status === 'done' ? test.outcome : null

  // The scan starts by itself, once, when the screen opens.
  const started = useRef(false)
  useEffect(() => {
    if (started.current) return
    started.current = true
    if (ctl.scan.status === 'idle') void ctl.runScan()
    // Opened on the hand-made form (Add printer on Printers): it starts at the brand.
    if (mode === 'manual' && !ctl.form.brand) ctl.setField('brand')
  }, [ctl, mode])

  // On the scan path the connection tests itself as soon as its fields are complete.
  const ready = Boolean(check?.ready && method && method.id !== 'export')
  useEffect(() => {
    if (mode !== 'scan' || !pickedId || !ready || test.status !== 'idle') return
    const t = setTimeout(() => void ctl.runTest(), 500)
    return () => clearTimeout(t)
  }, [mode, pickedId, ready, test.status, ctl])

  // A passing test reads the nozzles, their material and the filament units into the form.
  useEffect(() => {
    if (!outcome?.ok) return
    if (outcome.hardware) {
      const hw = outcome.hardware
      setForm((f) => withHardware(f, hw))
      return
    }
    setForm((f) => {
      let next = f
      if (outcome.nozzleMm && nozzleMm(f.nozzles[0] ?? EMPTY_FORM.nozzles[0]!) !== outcome.nozzleMm) {
        const size = (NOZZLE_SIZES as readonly number[]).includes(outcome.nozzleMm) ? outcome.nozzleMm : null
        next = { ...next, nozzleUnsure: false, nozzles: next.nozzles.map((n) => ({ ...n, size, other: size === null ? String(outcome.nozzleMm) : '' })) }
      }
      if (outcome.filamentSystem) next = { ...next, filament: filamentFor(outcome.filamentSystem, outcome.slotCount) }
      return next
    })
  }, [outcome, setForm])

  const onFocus = (e: FocusEvent<HTMLDivElement>) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-help]')
    const f = el?.dataset['help'] as HelpField | undefined
    if (f && f !== ctl.field) ctl.setField(f)
  }

  const pickFound = (p: FoundPrinter) => {
    const next = adoptFound(ctl.current(), p)
    setForm(next)
    setPicked(p)
    setEditDetails(false)
    setAskIp(false)
    ctl.setField(null)
    // A printer the catalog does not know goes to the hand-made fields with the connection filled in.
    if (!matchFound(p)) setMode('manual')
  }

  // The address typed in "Enter IP instead" lands in the host field once the form has one.
  useEffect(() => {
    const h = typedHost.current
    if (!h || mode !== 'manual' || !method || method.id === 'export' || form.fields.host) return
    typedHost.current = null
    setForm((f) => ({ ...f, fields: { ...f.fields, host: h } }))
  }, [mode, method, form.fields.host, setForm])

  const foundByIp = (p: FoundPrinter) => {
    ctl.addFound(p)
    setAskIp(false)
    pickFound(p)
  }

  const toManual = () => {
    setMode('manual')
    setPickedId(null)
    if (!form.brand) ctl.setField('brand')
    requestAnimationFrame(() => document.getElementById('fr-brand-search')?.focus())
  }

  const toScan = () => {
    setMode('scan')
    ctl.setField(null)
  }

  const save = async (skipTest: boolean) => {
    setSaving(true)
    setError(null)
    try {
      if (skipTest && test.status !== 'done') ctl.setKeepReported(null)
      onSaved(await ctl.save())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  // Skip leaves the connection test out, not the printer that was picked.
  const skip = async () => {
    const keep = skipForm(ctl.current(), pickedId !== null)
    if (!keep) return onSkip()
    setSaving(true)
    setError(null)
    try {
      onSaved(await ctl.saveFrom(keep, false))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const answer: Record<SubstepId, string | null> = {
    brand: brandTile(form.brand)?.name ?? null,
    model: form.modelId ? modelLabel(form).model : null,
    nozzle: open.connection ? nozzleText(form) : null,
    connection: method ? (method.id === 'export' ? 'No connection' : method.name) : null,
    test: test.status === 'done' ? (test.outcome.ok ? 'Connected' : 'Failed') : null,
  }
  const status = (id: SubstepId): 'done' | 'open' | 'locked' => {
    const isOpen = id === 'brand' || (id === 'model' && open.model) || (id === 'nozzle' && open.nozzle) || (id === 'connection' && open.connection) || (id === 'test' && open.test)
    if (!isOpen) return 'locked'
    return answer[id] ? 'done' : 'open'
  }

  const network = method && method.id !== 'export'
  // What the printer announced and the form still holds is not asked again.
  const codeOnlyCheck = (h: boolean, sn: boolean) => mode === 'scan' && method?.id === 'bambu-lan' && h && sn
  const knownHost = Boolean(picked?.address) && !editDetails && form.fields.host === (picked?.address ? (parseAddress(picked.address)?.host ?? picked.address) : '')
  const knownSerial = Boolean(picked?.serial) && !editDetails && form.fields.serial === picked?.serial
  // A Bambu Lab printer the scan found needs only its access code: the one card does it all.
  const codeOnly = codeOnlyCheck(knownHost, knownSerial)
  const sendTestReport = (o: TestOutcome) => set({ bugReportDraft: { title: `Printer connection test failed: ${method?.name ?? 'printer'}`, happened: redact(o, form) }, bugReportOpen: true })
  const blockers = method && method.id !== 'export' ? testBlockers(form, method) : []
  const bambuFound = ctl.scan.status === 'done' ? ctl.scan.found.filter((p) => p.family === 'bambu-lan') : []
  const complete = open.connection && form.connection !== null && (mode === 'manual' || pickedId !== null)
  let primary: FooterAction
  let secondary: { label: string; onClick: () => void; disabled?: boolean } | null = null
  if (codeOnly && !(test.status === 'done' && test.outcome.ok)) {
    primary = { label: 'Continue', onClick: () => undefined, disabled: true }
    if (test.status === 'done' && !test.outcome.ok) secondary = { label: 'Continue without testing', onClick: () => void save(true), disabled: saving }
  } else if (!complete) {
    const hint = mode === 'scan' ? 'Pick a printer from the list, enter its IP address, or add it by hand.' : !open.model ? 'Pick a brand first.' : !open.nozzle ? 'Pick a model first.' : !open.connection ? 'Set the nozzle first.' : 'Choose a connection first.'
    primary = { label: 'Continue', onClick: () => undefined, disabled: true, hint }
  }
  else if (!network) primary = { label: saving ? 'Saving' : 'Continue', onClick: () => void save(false), disabled: saving }
  else if (test.status === 'done' && test.outcome.ok) primary = { label: saving ? 'Saving' : 'Continue', onClick: () => void save(false), disabled: saving }
  else if (test.status === 'testing') primary = { label: 'Testing', onClick: () => undefined, disabled: true, icon: 'refresh' }
  else {
    // On the scan path nothing reads as an error before the person types: an empty code is a prompt.
    const typed = mode === 'scan' && !editDetails ? typedBlockers(blockers, form) : blockers
    const hint = typed.length ? blockerHint(typed) : blockers.length ? 'Enter the access code from the printer screen to test the connection.' : undefined
    primary = { label: test.status === 'done' ? 'Test again' : 'Test connection', onClick: () => void ctl.runTest(), disabled: !check?.ready, icon: 'refresh', ...(hint ? { hint, ...(typed.length ? {} : { hintTone: 'info' as const }) } : {}) }
    secondary = { label: 'Continue without testing', onClick: () => void save(true), disabled: saving || !check?.ready }
  }

  const helpPane = <HelpPane topic={topic} />
  const found = ctl.scan.status === 'done' ? ctl.scan.found.length : null

  const scanView = (
    <div className="fr-printer-main fr-scanview" onFocusCapture={onFocus}>
      <header className="fr-head">
        <h1 className="fr-title fr-display">Find your printer</h1>
        <p className="fr-lede">{appName()} looks on your network and reads the model, nozzles, filament units and firmware from the printer itself, then checks the connection. Everything can be changed later in Printers.</p>
      </header>
      {/* Up front while nothing is picked; a picked Bambu Lab printer gets it next to its access code. */}
      {picked ? null : <BambuLanCard family={bambuFamily(bambuFound[0]?.model)} lanOnly={bambuFound.some((p) => p.lanOnly === false) ? false : undefined} />}
      <div className="fr-scanbar">
        <span className="fr-scanbar-txt" role="status">
          {ctl.scan.status === 'scanning' || ctl.scan.status === 'idle' ? 'Scanning' : found === null ? '' : found === 0 ? 'Nothing found' : found === 1 ? '1 printer found' : `${found} printers found`}
          {ctl.scan.status === 'done' ? <span className="sx-dim"> on {ctl.host.scanRange}</span> : null}
        </span>
        <Button size="sm" variant="ghost" icon="refresh" disabled={ctl.scan.status === 'scanning'} onClick={() => void ctl.runScan()}>
          Scan again
        </Button>
      </div>
      <FoundList
        ctl={ctl}
        picked={picked}
        onPick={pickFound}
        onClear={() => {
          setPickedId(null)
          ctl.setField(null)
        }}
        enterIp={<EnterIp ctl={ctl} onFound={foundByIp} onNothing={(ip) => { typedHost.current = ip; toManual() }} />}
      />
      {picked && !codeOnly ? (
        <p className="fr-ok fr-found-ok" role="status">
          <Icon name="check" size={18} />
          <span>
            <b>Found it.</b> {foundText(picked)}
          </span>
        </p>
      ) : null}
      {picked && codeOnly ? (
        <>
          <CodeCard ctl={ctl} picked={picked} onReport={() => outcome && sendTestReport(outcome)} />
          {outcome?.ok ? <ConfirmCard form={form} setForm={setForm} hardware={outcome.hardware} reportedNozzle={Boolean(outcome.nozzleMm)} reportedFilament={Boolean(outcome.filamentSystem)} firmware={outcome.firmware} /> : null}
          <LinkButton icon="sliders" className="fr-editdetails" onClick={() => setEditDetails(true)}>
            Edit connection details
          </LinkButton>
        </>
      ) : pickedId && network ? (
        <section className="fr-connect" aria-labelledby="fr-connect-h">
          <h2 id="fr-connect-h" className="fr-connect-h">
            <Icon name="connect-test" size={18} /> {method?.name}
            {ready || test.status !== 'idle' ? (
              <span className="fr-connect-sub">The connection tests itself.</span>
            ) : (
              <span className="fr-connect-sub">{blockers.every((b) => b.field === 'accessCode') ? 'Enter the 8-character access code from the printer screen; the test runs by itself.' : 'Fill in what the printer asks for; the test runs by itself.'}</span>
            )}
          </h2>
          {picked?.family === 'bambu-lan' ? <BambuLanCard family={bambuFamily(picked.model ?? matchFound(picked)?.name)} lanOnly={picked.lanOnly} open={!outcome?.ok} /> : null}
          <ConnectionSection
            ctl={ctl}
            keychain={ctl.host.keychain}
            fieldsOnly
            known={{ host: knownHost, serial: knownSerial }}
            quiet={!editDetails}
            onWhere={(f) => {
              ctl.setField(f)
              if (phone) setHelpOpen(true)
            }}
          />
          {(knownHost || knownSerial) && !editDetails ? (
            <LinkButton icon="sliders" className="fr-editdetails" onClick={() => setEditDetails(true)}>
              Edit connection details
            </LinkButton>
          ) : null}
          {test.status !== 'idle' ? (
            <TestCard
              ctl={ctl}
              onUseReported={(name) => {
                ctl.setKeepReported(name)
                const hit = searchSetup(name).models[0]
                if (hit) setForm((f) => ({ ...pickModel(f, hit.id), connection: f.connection, fields: f.fields, secretLengths: f.secretLengths }))
              }}
            />
          ) : null}
          {outcome?.ok ? <ConfirmCard form={form} setForm={setForm} hardware={outcome.hardware} reportedNozzle={Boolean(outcome.nozzleMm)} reportedFilament={Boolean(outcome.filamentSystem)} firmware={outcome.firmware} /> : null}
        </section>
      ) : null}
      {askIp && !picked && found !== 0 ? <EnterIp ctl={ctl} onFound={foundByIp} onNothing={(ip) => { typedHost.current = ip; toManual() }} /> : null}
      <div className="fr-scan-links">
        {found !== 0 && !askIp && !picked ? (
          <LinkButton icon="search" onClick={() => setAskIp(true)}>
            Not found? Enter IP instead
          </LinkButton>
        ) : null}
        <LinkButton icon="plus" onClick={toManual}>
          Not listed? Add it by hand
        </LinkButton>
        <LinkButton icon="skip" onClick={onNoPrinter} className="fr-noprinter">
          I do not have a printer yet
        </LinkButton>
      </div>
      {error ? (
        <p className="app-err" role="alert">
          The printer was not saved: {error}
        </p>
      ) : null}
    </div>
  )

  const manualView = (
    <>
      <nav className="fr-mini" aria-label="Printer setup steps">
        <ol>
          {SUBSTEPS.map((s) => {
            const st = status(s.id)
            return (
              <li key={s.id} data-state={st}>
                <button type="button" disabled={st === 'locked'} onClick={() => scrollTo(s.id, true)}>
                  <i aria-hidden="true">{st === 'done' ? <Icon name="check" size={12} /> : null}</i>
                  {s.label}
                </button>
              </li>
            )
          })}
        </ol>
      </nav>
      <div className="fr-printer-main" onFocusCapture={onFocus}>
        <header className="fr-head">
          <LinkButton icon="arrow-left" onClick={toScan} className="fr-toscan">
            Back to the scan
          </LinkButton>
          <h1 className="fr-title fr-display">Add your printer</h1>
          <p className="fr-lede">Pick the printer, its nozzle and how {appName()} reaches it. Every part can be changed later in Printers.</p>
        </header>
        <Section id="brand" title="Brand" locked={false} lockedText="" answer={answer.brand}>
          <BrandSection ctl={ctl} onNoPrinter={onNoPrinter} />
        </Section>
        <Section id="model" title="Model" locked={!open.model} lockedText="Pick a brand first." answer={answer.model}>
          <ModelSection ctl={ctl} />
        </Section>
        <Section id="nozzle" title="Nozzle" locked={!open.nozzle} lockedText="Pick a model first." answer={answer.nozzle}>
          <NozzleSection ctl={ctl} />
        </Section>
        <Section id="connection" title="Connection" locked={!open.connection} lockedText="Set the nozzle first." answer={answer.connection}>
          <ConnectionSection
            ctl={ctl}
            keychain={ctl.host.keychain}
            onWhere={(f) => {
              ctl.setField(f)
              if (phone) setHelpOpen(true)
            }}
          />
        </Section>
        <Section id="test" title="Test connection" locked={!open.test} lockedText={form.connection === 'export' ? 'Nothing to test without a connection.' : 'Choose a connection first.'} answer={answer.test}>
          <TestCard
            ctl={ctl}
            onUseReported={(name) => {
              ctl.setKeepReported(name)
              const hit = searchSetup(name).models[0]
              if (hit) setForm((f) => ({ ...pickModel(f, hit.id), connection: f.connection, fields: f.fields, secretLengths: f.secretLengths }))
            }}
          />
        </Section>
        {error ? (
          <p className="app-err" role="alert">
            The printer was not saved: {error}
          </p>
        ) : null}
      </div>
    </>
  )

  return (
    <>
      <div className="fr-body fr-body-printer">
        <div className="fr-printer" data-mode={mode}>
          {mode === 'scan' ? scanView : manualView}
          {helpVisible && !phone ? helpPane : null}
        </div>
        {helpVisible && phone ? (
          <div className="fr-sheet" data-open={helpOpen ? true : undefined}>
            <button type="button" className="fr-sheet-bar" aria-expanded={helpOpen} onClick={() => setHelpOpen(!helpOpen)}>
              <Icon name="help" size={16} /> Help: {topic.title}
              <Icon name={helpOpen ? 'chevron-down' : 'chevron-up'} size={16} />
            </button>
            {helpOpen ? helpPane : null}
          </div>
        ) : null}
      </div>
      <Footer back={onBack ? { label: 'Back', onClick: onBack } : null} skip={{ label: 'Skip', onClick: () => void skip() }} primary={primary} secondary={secondary} />
    </>
  )
}
