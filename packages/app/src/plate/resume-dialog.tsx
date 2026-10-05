// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Print the rest from this height. After a stop with
// the part still on the bed: the measured height or the printer's layer number, the plan from
// sx-geom (packages/app/src/geom/resume.ts), a silhouette of what is left, and the slice from there.
import { Button, Dialog, Field, Icon, Input, SwitchRow } from '@slicerx/ui'
import { useEffect, useMemo, useRef, useState } from 'react'
import { resolveConfig } from '../adapters/settings'
import { registerCommands } from '../commands/registry'
import { fromGeom, toGeom } from '../geom/client'
import { planResume, type ResumePlan } from '../geom/resume'
import { useHost } from '../host'
import { Silhouette } from '../parts'
import { slicePlate } from '../state/actions'
import { get, markStale, set, setWorkspace, useApp } from '../state/store'
import { closeResume, openResume, useResumeAsk } from './resume-state'
import './resume-dialog.css'
import { appName } from '../edition'

type By = 'height' | 'layer'

/** The failed job's layer tops: the last slice's layers when it is still current, else nothing (even layers). */
function lastLayerTops(): number[] | undefined {
  const s = get()
  if (s.resume?.layerTopsMm?.length) return s.resume.layerTopsMm
  if (s.slice.status !== 'done') return undefined
  const z = (s.slice.result as { layerZ?: ArrayLike<number> }).layerZ
  return z && z.length ? Array.from(z) : undefined
}

function Body({ printerName, startLayer }: { printerName?: string | undefined; startLayer?: number | undefined }) {
  const host = useHost()
  const plate = useApp((s) => s.plate)
  const easy = useApp((s) => s.easy)
  const overrides = useApp((s) => s.overrides)
  const active = useApp((s) => s.resume)
  const cfg = useMemo(() => resolveConfig(easy, overrides), [easy, overrides])
  const layerHeightMm = Number(cfg['layer_height']) || 0.2
  const firstLayerHeightMm = Number(cfg['initial_layer_print_height']) || layerHeightMm
  const [by, setBy] = useState<By>(startLayer ? 'layer' : 'height')
  const [height, setHeight] = useState('')
  const [layer, setLayer] = useState(startLayer ? String(startLayer) : '')
  const [declareZ, setDeclareZ] = useState(false)
  const [plan, setPlan] = useState<ResumePlan | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const abort = useRef<AbortController | null>(null)
  const parts = useMemo(() => plate.filter((p) => p.printable !== false).flatMap((p) => p.parts.map((part) => ({ mesh: toGeom(part), transform: p.transform }))), [plate])
  const value = by === 'height' ? Number(height.replace(',', '.')) : Number(layer)
  const valid = by === 'height' ? Number.isFinite(value) && value > 0 : Number.isInteger(value) && value >= 1

  // The plan follows the input, a moment after typing stops.
  useEffect(() => {
    abort.current?.abort()
    setPlan(null)
    setError(null)
    if (!valid || parts.length === 0) return
    const ac = new AbortController()
    abort.current = ac
    const t = setTimeout(() => {
      setBusy(true)
      const tops = lastLayerTops()
      planResume(parts, { ...(by === 'height' ? { measuredHeightMm: value } : { failedLayer: value }), layerHeightMm, firstLayerHeightMm, ...(tops ? { layerTopsMm: tops } : {}), includeRemainingMesh: true }, ac.signal)
        .then((p) => {
          if (!ac.signal.aborted) setPlan(p)
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
  }, [by, value, valid, parts, layerHeightMm, firstLayerHeightMm])

  const remaining = useMemo(() => (plan?.remaining ? [fromGeom(plan.remaining, 'rest', 1)] : null), [plan])
  const whole = useMemo(() => plate.filter((p) => p.printable !== false).flatMap((p) => p.parts), [plate])

  const go = () => {
    if (!plan) return
    const tops = lastLayerTops()
    set({ resume: { plan: { resumeLayer: plan.resumeLayer, printedHeightMm: plan.printedHeightMm }, ...(declareZ ? { declareZ: true } : {}), ...(tops ? { layerTopsMm: tops } : {}) } })
    markStale()
    closeResume()
    setWorkspace('preview')
    void slicePlate(host)
  }
  const everything = () => {
    set({ resume: null })
    markStale()
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
      {error ? (
        <p className="app-err" role="alert">
          {error}
        </p>
      ) : null}
      <div className="rs-plan" data-state={busy ? 'busy' : plan ? 'ready' : 'idle'} aria-live="polite">
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
            <dd>{plan ? `${plan.printedHeightMm.toFixed(2)} mm, ${plan.resumeLayer} of ${plan.layerCount} layers` : busy ? 'Planning' : 'Enter a height or a layer'}</dd>
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
      ]),
    [],
  )
  return (
    <Dialog open={ask !== null} onClose={closeResume} title="Print the rest from this height" size="md">
      {ask ? <Body {...(ask.printerName ? { printerName: ask.printerName } : {})} {...(ask.layer ? { startLayer: ask.layer } : {})} /> : null}
    </Dialog>
  )
}
