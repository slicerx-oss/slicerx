// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Print the rest from this height. After a stop with
// the part still on the bed: the measured height or the printer's layer number, the plan from
// sx-geom (packages/app/src/geom/resume.ts), a silhouette of what is left, and the slice from there.
import { isNoLocalEngine } from '@slicerx/contracts'
import { Button, Dialog, Field, Icon, Input, SwitchRow } from '@slicerx/ui'
import { useEffect, useMemo, useRef, useState } from 'react'
import { resolveConfig } from '../adapters/settings'
import { registerCommands } from '../commands/registry'
import { fromGeom, toGeom } from '../geom/client'
import { planResume, type ResumePlan } from '../geom/resume'
import { useHost } from '../host'
import { Silhouette } from '../parts'
import { slicePlate } from '../state/actions'
import { get, showSliced, useApp } from '../state/store'
import { closeResume, openResume, useResumeAsk } from './resume-state'
import { activeResume, jobLayerTops, printEverythingAgain, resumeFor, resumeElsewhere, resumeLayers, resumeVoid, setResume, sliceInputsKey, type ResumeLayers } from './resume-tops'
import './resume-dialog.css'
import { appName } from '../edition'

type By = 'height' | 'layer'

/** Shown while the engine works out the job's layers, when the app has none (a reopened project, a printer's resume). */
const WORKING = 'Working out the layers...'
/**
 * A host that slices only in the cloud has no engine to work the layers out on this device, and a cloud job for them
 * would spend one of the day's cloud slices unasked. The person slices the plate instead, as they slice anything.
 */
const SLICE_FIRST = 'Slice the plate first. This device slices in the cloud, and the plan counts in the layers of that slice.'

function Body({ printerName, startLayer }: { printerName?: string | undefined; startLayer?: number | undefined }) {
  const host = useHost()
  const plate = useApp((s) => s.plate)
  const easy = useApp((s) => s.easy)
  const overrides = useApp((s) => s.overrides)
  // The plan that holds for this plate as it is; a kept plan that does not is said apart (kept).
  const active = useApp(activeResume)
  const kept = useApp((s) => resumeVoid(s) !== null)
  // A plan kept for another plate: planning here replaces it.
  const elsewhere = useApp(resumeElsewhere)
  const activePlate = useApp((s) => s.activePlate)
  const storedTops = useApp((s) => activeResume(s)?.layerTopsMm)
  const doneSlice = useApp((s) => (s.slice.status === 'done' && !s.slice.stale ? s.slice.result : null))
  // What the plate's layers come from (every slice input that moves them): the job's layers hold while it stays the same.
  const inputs = useApp(sliceInputsKey)
  const cfg = useMemo(() => resolveConfig(easy, overrides), [easy, overrides])
  const layerHeightMm = Number(cfg['layer_height']) || 0.2
  const firstLayerHeightMm = Number(cfg['initial_layer_print_height']) || layerHeightMm
  const [by, setBy] = useState<By>(startLayer ? 'layer' : 'height')
  const [height, setHeight] = useState('')
  const [layer, setLayer] = useState(startLayer ? String(startLayer) : '')
  const [declareZ, setDeclareZ] = useState(false)
  const [plan, setPlan] = useState<(ResumePlan & { tops: number[] }) | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // The job's layers the plan counts in, for the plate they came from: the app's, or the engine's when the app has none.
  const [layers, setLayers] = useState<ResumeLayers | null>(null)
  const [layersError, setLayersError] = useState<string | null>(null)
  // No engine on this device: the layers wait for a slice the person starts here (Slice plate).
  const [needsSlice, setNeedsSlice] = useState(false)
  const [asked, setAsked] = useState(false)
  const sliceRunning = useApp((s) => s.slice.status === 'running')
  const sliceError = useApp((s) => (s.slice.status === 'error' ? s.slice.message : null))
  const abort = useRef<AbortController | null>(null)
  // The engine's layers for the inputs they were worked out for, kept while those stay the same.
  const engineLayers = useRef<ResumeLayers | null>(null)
  const parts = useMemo(() => plate.filter((p) => p.printable !== false).flatMap((p) => p.parts.map((part) => ({ mesh: toGeom(part), transform: p.transform }))), [plate])
  const value = by === 'height' ? Number(height.replace(',', '.')) : Number(layer)
  const valid = by === 'height' ? Number.isFinite(value) && value > 0 : Number.isInteger(value) && value >= 1

  // The job's layers: the app's when it has them, else the engine's, worked out again only when the plate or its slice
  // inputs change. The same layers keep the plan as it is, so a slice landing in the background changes nothing on
  // screen. Closing the dialog or showing another plate drops a run still going, and its answer with it.
  useEffect(() => {
    const holds = (l: ResumeLayers | null): l is ResumeLayers => l !== null && l.plate === activePlate && l.inputs === inputs
    const keep = (next: ResumeLayers) => setLayers((prev) => (holds(prev) && sameTops(prev.tops, next.tops) ? prev : next))
    setLayersError(null)
    setNeedsSlice(false)
    const job = jobLayerTops(get())
    if (job) return keep({ plate: activePlate, inputs, tops: job })
    if (holds(engineLayers.current)) return keep(engineLayers.current)
    setLayers(null)
    if (parts.length === 0) return
    const ac = new AbortController()
    resumeLayers(host, ac.signal)
      .then((l) => {
        if (ac.signal.aborted || !l) return
        engineLayers.current = l
        keep(l)
      })
      .catch((e: unknown) => {
        if (ac.signal.aborted) return
        if (isNoLocalEngine(e)) setNeedsSlice(true)
        else setLayersError(e instanceof Error ? e.message : String(e))
      })
    return () => ac.abort()
  }, [host, parts.length, activePlate, inputs, storedTops, doneSlice])

  const working = parts.length > 0 && !layers && !layersError && !needsSlice
  // The slice asked for here, when it fails (a used-up cloud quota, say), says why where the plan would be.
  const firstError = needsSlice && asked && !sliceRunning ? sliceError : null
  const sliceFirst = () => {
    setAsked(true)
    // Planning again: the void plan stays kept (so Print and Export wait) while this slice reads the plate's layers.
    void slicePlate(host, { planning: true })
  }
  const layersReady = layers !== null && layers.plate === activePlate ? layers : null

  // The plan follows the input, a moment after typing stops, in the job's layers.
  useEffect(() => {
    abort.current?.abort()
    setPlan(null)
    setError(null)
    setBusy(false)
    if (!valid || parts.length === 0 || !layersReady) return
    const tops = layersReady.tops
    const ac = new AbortController()
    abort.current = ac
    const t = setTimeout(() => {
      setBusy(true)
      planResume(parts, { ...(by === 'height' ? { measuredHeightMm: value } : { failedLayer: value }), layerHeightMm, firstLayerHeightMm, layerTopsMm: tops, includeRemainingMesh: true }, ac.signal)
        .then((p) => {
          if (!ac.signal.aborted) setPlan({ ...p, tops })
        })
        .catch((e: unknown) => {
          if (!ac.signal.aborted) setError(e instanceof Error ? e.message : String(e))
        })
        .finally(() => {
          if (!ac.signal.aborted) setBusy(false)
        })
    }, 400)
    return () => {
      clearTimeout(t)
      ac.abort()
    }
  }, [by, value, valid, parts, layerHeightMm, firstLayerHeightMm, layersReady])

  const remaining = useMemo(() => (plan?.remaining ? [fromGeom(plan.remaining, 'rest', 1)] : null), [plan])
  const whole = useMemo(() => plate.filter((p) => p.printable !== false).flatMap((p) => p.parts), [plate])

  const go = () => {
    if (!plan) return
    // The layers the plan counted in are the job's, so the slice sends them back as sliced and prints the same ones.
    // They hold for this plate as it is now: a plate switch or an edit leaves them out of the next slice.
    setResume(resumeFor(get(), { plan: { resumeLayer: plan.resumeLayer, printedHeightMm: plan.printedHeightMm }, ...(declareZ ? { declareZ: true } : {}), layerTopsMm: plan.tops }))
    closeResume()
    showSliced()
    void slicePlate(host)
  }
  const everything = () => {
    printEverythingAgain()
    closeResume()
  }

  return (
    <div className="rs">
      <p className="rs-lede">
        {printerName ? `${printerName} stopped with the part still on the bed. ` : 'The part is still on the bed. '}
        Leave it where it is. Tell {appName()} how far it got and it slices only the layers above, lined up with what is printed.
      </p>
      {parts.length === 0 ? (
        <p className="rs-warn" role="status">
          <Icon name="warning" size={15} /> Nothing is on the plate. Open the project that was printing first; the rest is sliced from it.
        </p>
      ) : null}
      {kept ? (
        <p className="rs-active" role="status" data-testid="resume-kept">
          <Icon name="warning" size={16} /> The resume plan for this plate no longer matches it, so the plate does not slice, print or export. Plan it again here, or
          <button type="button" className="rs-link" onClick={everything}>
            Print everything again
          </button>
        </p>
      ) : null}
      {elsewhere !== null ? (
        <p className="rs-active" role="status" data-testid="resume-elsewhere-dialog">
          <Icon name="layers" size={16} /> A resume plan is kept for plate {elsewhere}. A plan made here replaces it.
        </p>
      ) : null}
      {active ? (
        <p className="rs-active" role="status">
          <Icon name="layers" size={16} /> The plate is set to print from layer {active.plan.resumeLayer + 1}.
          <button type="button" className="rs-link" onClick={everything}>
            Print everything again
          </button>
        </p>
      ) : null}
      <div className="rs-by" role="radiogroup" aria-label="How far it got">
        <label className="rs-opt" data-on={by === 'height' ? true : undefined}>
          <input type="radio" name="rs-by" checked={by === 'height'} onChange={() => setBy('height')} />
          <span>
            <b>Measure the part</b>
            <small>Calipers or a ruler from the bed to the top of what printed.</small>
          </span>
        </label>
        <label className="rs-opt" data-on={by === 'layer' ? true : undefined}>
          <input type="radio" name="rs-by" checked={by === 'layer'} onChange={() => setBy('layer')} />
          <span>
            <b>Use the printer&apos;s layer number</b>
            <small>The layer its screen showed when it stopped. That layer prints again.</small>
          </span>
        </label>
      </div>
      {by === 'height' ? (
        <Field htmlFor="rs-height" label="Height of the part on the bed" hint={`Layers are ${layerHeightMm} mm${firstLayerHeightMm !== layerHeightMm ? `, the first ${firstLayerHeightMm} mm` : ''}. A measurement within half a layer of a layer top counts that layer as done.`}>
          <Input id="rs-height" mono unit="mm" inputMode="decimal" placeholder="31.4" value={height} onChange={(e) => setHeight(e.target.value)} autoFocus />
        </Field>
      ) : (
        <Field htmlFor="rs-layer" label="Layer the printer stopped on" hint="Counting from 1, as the printer shows it.">
          <Input id="rs-layer" mono inputMode="numeric" placeholder="157" value={layer} onChange={(e) => setLayer(e.target.value)} autoFocus />
        </Field>
      )}
      {needsSlice ? (
        <div className="rs-first" role="status">
          <Icon name="slice" size={15} />
          <span>{sliceRunning ? 'Slicing the plate...' : SLICE_FIRST}</span>
          <Button size="sm" icon="slice" busy={sliceRunning} disabled={sliceRunning} onClick={sliceFirst}>
            Slice plate
          </Button>
        </div>
      ) : null}
      {layersError || firstError || error ? (
        <p className="app-err" role="alert">
          {layersError ?? firstError ?? error}
        </p>
      ) : null}
      <div className="rs-plan" data-state={busy || working ? 'busy' : plan ? 'ready' : 'idle'} aria-live="polite">
        <div className="rs-art" aria-hidden="true">
          <div className="rs-sil">
            {whole.length ? <Silhouette parts={whole} /> : null}
            {plan ? <i className="rs-cut" style={{ bottom: `${Math.max(0, Math.min(100, (plan.printedHeightMm / Math.max(0.001, plateHeight(whole))) * 100))}%` }} /> : null}
          </div>
          <Icon name="arrow-right" size={16} />
          <div className="rs-sil rs-rest">{remaining ? <Silhouette parts={remaining} /> : <span className="rs-empty">{busy ? 'Planning' : 'What is left'}</span>}</div>
        </div>
        <dl className="rs-facts">
          <div>
            <dt>Printed</dt>
            <dd>{plan ? `${plan.printedHeightMm.toFixed(2)} mm, ${plan.resumeLayer} of ${plan.layerCount} layers` : working ? WORKING : needsSlice ? 'After the slice' : busy ? 'Planning' : 'Enter a height or a layer'}</dd>
          </div>
          <div>
            <dt>Resumes at</dt>
            <dd>{plan ? `layer ${plan.resumeLayerNumber}, nozzle at ${plan.resumeZMm.toFixed(2)} mm` : ''}</dd>
          </div>
          <div>
            <dt>Left to print</dt>
            <dd>{plan ? `${plan.remainingLayers} layers` : ''}</dd>
          </div>
        </dl>
        {plan?.warnings.map((w) => (
          <p key={w} className="rs-warn">
            <Icon name="warning" size={15} /> {w}
          </p>
        ))}
      </div>
      <SwitchRow
        id="rs-declare"
        label="Set the nozzle height by hand"
        detail={declareZ ? `Before the print: home X and Y, then move the nozzle down until it touches the top of the part. The G-code then declares that as ${plan ? `${plan.printedHeightMm.toFixed(2)} mm` : 'the printed height'} and continues.` : 'Off: the printer keeps the Z it has. Turn this on when it lost its position (power cut, homed since).'}
        checked={declareZ}
        onChange={setDeclareZ}
      />
      <div className="rs-act">
        <Button variant="ghost" onClick={closeResume}>
          Cancel
        </Button>
        <Button variant="primary" icon="slice" disabled={!plan || plan.resumeLayer <= 0} onClick={go}>
          Slice the rest
        </Button>
      </div>
    </div>
  )
}

/** Whether two lists of layer tops are the same layers, to the engine's float precision. */
function sameTops(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((t, i) => Math.abs(t - b[i]!) < 1e-6)
}

function plateHeight(parts: readonly { positions: Float32Array }[]): number {
  let hi = 0
  for (const p of parts) for (let i = 2; i < p.positions.length; i += 3) hi = Math.max(hi, p.positions[i] ?? 0)
  return hi
}

/** Mounted once by the shell. Registers the palette command and shows the dialog when asked. */
export function ResumeDialog() {
  const ask = useResumeAsk()
  useEffect(
    () =>
      registerCommands([
        { id: 'print-rest', title: 'Print the rest from this height', section: 'plate', keywords: ['resume', 'failed print', 'continue', 'power loss', 'restart from layer'], run: () => openResume() },
        { id: 'print-everything', title: 'Print everything again', section: 'plate', keywords: ['resume', 'whole plate', 'clear resume'], enabled: () => get().resume !== null, run: () => printEverythingAgain() },
      ]),
    [],
  )
  return (
    <Dialog open={ask !== null} onClose={closeResume} title="Print the rest from this height" size="md">
      {ask ? <Body {...(ask.printerName ? { printerName: ask.printerName } : {})} {...(ask.layer ? { startLayer: ask.layer } : {})} /> : null}
    </Dialog>
  )
}
