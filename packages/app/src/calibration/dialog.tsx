// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The calibration menu: pick a test, set its range, build the model on a new plate, then pick the value
// that printed best and save it to the filament settings.
import { Button, Dialog, Field, Icon, Input, Select } from '@slicerx/ui'
import { useEffect, useMemo, useState } from 'react'
import { useHost } from '../host'
import { set, toast, useApp } from '../state/store'
import { useResolvedSlots } from '../filament/use-slots'
import { addCalibrationPlate, applyCalibrationResult, calibPrinter, defaultValues } from './actions'
import { addCombinedPlate, COMBINED_TESTS, combinedValues } from './combined'
import { calibIdFor, needFor, NEED_LABEL, plannedTests, PLAN, visibleTests, type CalibNeed, type CalibPrinter, type PlanTest } from './plan'
import { CALIB_TESTS, calibTest, checkValues, type CalibId } from './tests'

export function CalibrationDialog() {
  const host = useHost()
  const open = useApp((s) => s.calibrationOpen)
  const run = useApp((s) => s.calibration[s.activePlate])
  const [id, setId] = useState<CalibId>('temp-tower')
  const [values, setValues] = useState<Record<string, string>>(() => stringify(defaultValues('temp-tower')))
  const [busy, setBusy] = useState(false)
  const slots = useResolvedSlots()
  const [slot, setSlot] = useState(1)
  const presets = useApp((s) => s.userPresets)
  const profile = useApp((s) => s.profile)
  const slotFromCard = useApp((s) => s.calibrationSlot)
  const [printer, setPrinter] = useState<CalibPrinter>({ flavor: 'marlin' })
  const [showAll, setShowAll] = useState(false)
  const [chosenNeed, setChosenNeed] = useState<CalibNeed | null>(null)
  const [done, setDone] = useState<Set<CalibId>>(new Set())
  const [picked, setPicked] = useState<string>('')
  const [measured, setMeasured] = useState('')
  const [picks, setPicks] = useState<Record<string, string>>({})
  useEffect(() => {
    if (!open) return
    void calibPrinter().then(setPrinter, () => undefined)
    if (slotFromCard !== null) setSlot(slotFromCard)
    setChosenNeed(null)
    setDone(new Set())
  }, [open, slotFromCard])
  const spool = slots.find((s) => s.index === slot)
  const autoNeed = useMemo(() => (spool ? needFor(presets, spool, profile?.printerId ?? '', profile?.nozzle ?? 0.4) : null), [presets, spool, profile])
  const need = chosenNeed ?? autoNeed
  const planned = need ? plannedTests(need, printer) : null
  const recommended: { test: PlanTest; id: CalibId; optional: boolean }[] = planned ? [...planned.run.map((t) => ({ test: t, id: calibIdFor(t, printer), optional: false })), ...planned.optional.map((t) => ({ test: t, id: calibIdFor(t, printer), optional: true }))] : []
  const next = recommended.find((r) => !r.optional && !done.has(r.id))
  // One plate for a new spool: every test the plan asks for that fits on one plate.
  const combinable = need === 'new-spool' ? COMBINED_TESTS.filter((t) => recommended.some((r) => !r.optional && (r.id === t || (t === 'pressure-advance' && r.id === 'pa-pattern')))) : []
  const listed = visibleTests(printer, showAll)
  const test = calibTest(id)
  const numbers = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.trim() === '' ? NaN : Number(v)]))
  const problem = checkValues(test, numbers)
  const choose = (next: CalibId) => {
    setId(next)
    setValues(stringify(defaultValues(next)))
  }
  const close = () => set({ calibrationOpen: false, calibrationSlot: null })
  const runTest = calibTest(run?.test ?? id)
  const candidates = run?.values ?? []
  const params = run?.params ?? {}
  const measuredNumber = measured.trim() === '' ? NaN : Number(measured.replace(',', '.'))
  const measuredValue = runTest.measure && Number.isFinite(measuredNumber) ? runTest.measure.toValue(measuredNumber, params) : null
  // The value has to land in the setting's own window (shrinkage: 50 to 150 percent, as in Orca's definition).
  const measuredProblem = runTest.measure && measuredValue !== null && (measuredValue < runTest.measure.min || measuredValue > runTest.measure.max) ? `That gives ${Number(measuredValue.toFixed(1))} ${runTest.result.unit}, outside ${runTest.measure.min} to ${runTest.measure.max}. Check the measurement.` : null
  const chosen = picked && candidates.map(String).includes(picked) ? picked : ''
  return (
    <Dialog
      open={open}
      onClose={close}
      size="lg"
      className="calib-dialog"
      title="Calibration"
      footer={
        <Button variant="primary" onClick={close}>
          Done
        </Button>
      }
    >
      {slots.length > 0 ? (
        <section className="calib-plan" aria-label="Recommended tests">
          <h4>{need ? `Recommended for ${spool ? [spool.brand, spool.type].filter(Boolean).join(' ') || 'this filament' : 'this filament'}` : 'This spool is tuned for this printer and nozzle'}</h4>
          <Field htmlFor="cal-need" label="Why calibrate">
            <Select id="cal-need" value={need ?? ''} onChange={(e) => setChosenNeed((e.target.value || null) as CalibNeed | null)}>
              {autoNeed === null && !chosenNeed ? <option value="">Nothing new</option> : null}
              {(Object.keys(PLAN) as CalibNeed[]).map((n) => (
                <option key={n} value={n}>
                  {NEED_LABEL[n]}
                </option>
              ))}
            </Select>
          </Field>
          {recommended.length ? (
            <ul>
              {recommended.map((r) => (
                <li key={r.id} className={done.has(r.id) ? 'done' : ''}>
                  <Button size="sm" variant={next?.id === r.id ? 'primary' : 'default'} onClick={() => choose(r.id)}>
                    {calibTest(r.id).label}
                  </Button>
                  <span className="sx-small sx-muted">{done.has(r.id) ? 'Saved' : r.optional ? 'Optional' : next?.id === r.id ? 'Next' : ''}</span>
                </li>
              ))}
            </ul>
          ) : need ? <p className="sx-small sx-muted">Your printer covers every test this needs.</p> : null}
          {combinable.length >= 2 ? (
            <div className="calib-act">
              <Button
                icon="new-plate"
                variant="primary"
                disabled={busy}
                onClick={async () => {
                  setBusy(true)
                  try {
                    await addCombinedPlate(host.slicer, combinable, combinedValues(defaultValues), slot)
                    setPicks({})
                    toast('The new spool plate is ready. Slice and print it, then read all of it.', 'ok')
                  } catch (e) {
                    toast(e instanceof Error ? e.message : String(e), 'error')
                  } finally {
                    setBusy(false)
                  }
                }}
              >
                Add {combinable.map((t) => calibTest(t).label.toLowerCase()).join(', ')} to one plate
              </Button>
              <span className="sx-small sx-muted">One print, objects one after another. Reads {combinable.length} results for this spool.</span>
            </div>
          ) : null}
          {planned?.note ? <p className="sx-small sx-muted">{planned.note}</p> : null}
          {planned?.notes.map((n) => (
            <p key={n} className="sx-small sx-muted">{n}</p>
          ))}
        </section>
      ) : null}
      <div className="calib-tests" role="radiogroup" aria-label="Calibration test">
        {CALIB_TESTS.filter((t) => listed.includes(t.id) || t.id === id).map((t) => (
          <button key={t.id} type="button" role="radio" aria-checked={t.id === id} className="calib-test" onClick={() => choose(t.id)}>
            <b>{t.label}</b>
            <small>{t.blurb}</small>
          </button>
        ))}
      </div>
      <label className="sx-small calib-all">
        <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Show every test
      </label>
      {slots.length > 1 ? (
        <Field htmlFor="cal-slot" label="Filament">
          <Select id="cal-slot" value={String(slot)} onChange={(e) => setSlot(Number(e.target.value))}>
            {slots.map((s) => (
              <option key={s.index} value={String(s.index)}>
                {s.label}: {[s.brand, s.type].filter(Boolean).join(' ')}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      <div className="calib-fields">
        {test.fields.map((f) => (
          <Field key={f.key} htmlFor={`cal-${f.key}`} label={f.label} aside={f.unit}>
            <Input id={`cal-${f.key}`} inputMode="decimal" value={values[f.key] ?? ''} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />
          </Field>
        ))}
      </div>
      {problem ? <p className="sx-small calib-problem" role="status">{problem}</p> : <p className="sx-small sx-muted">{test.candidates(numbers).length} steps.</p>}
      <div className="calib-act">
        <Button
          icon="new-plate"
          disabled={busy || Boolean(problem)}
          onClick={async () => {
            setBusy(true)
            try {
              await addCalibrationPlate(host.slicer, id, numbers, slot)
              setPicked('')
              toast(`${test.label} is on a new plate. Slice and print it.`, 'ok')
            } catch (e) {
              toast(e instanceof Error ? e.message : String(e), 'error')
            } finally {
              setBusy(false)
            }
          }}
        >
          Add to a new plate
        </Button>
      </div>
      {run?.combined ? (
        <section className="calib-result" aria-label="Result of the new spool plate">
          <h4>
            <Icon name="calibration" size={14} /> Result of this plate: new spool
          </h4>
          <ol className="sx-small calib-steps">
            {run.instructions.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ol>
          {run.combined.map((part) => {
            const t = calibTest(part.test)
            return (
              <Field key={part.test} htmlFor={`cal-pick-${part.test}`} label={t.result.label} aside={t.result.unit}>
                <Select id={`cal-pick-${part.test}`} value={picks[part.test] ?? ''} onChange={(e) => setPicks({ ...picks, [part.test]: e.target.value })}>
                  <option value="">Choose the best step</option>
                  {part.values.map((c, i) => (
                    <option key={c} value={String(c)}>
                      Step {i + 1}: {c}
                    </option>
                  ))}
                </Select>
              </Field>
            )
          })}
          <Button
            icon="check"
            disabled={!Object.values(picks).some(Boolean)}
            onClick={() => {
              const next = new Set(done)
              for (const part of run.combined ?? []) {
                const v = picks[part.test]
                if (!v) continue
                applyCalibrationResult(part.test, Number(v), run.slot ?? slot)
                next.add(part.test)
                if (part.test === 'pressure-advance') next.add('pa-pattern')
              }
              setDone(next)
            }}
          >
            Save to filament
          </Button>
        </section>
      ) : run ? (
        <section className="calib-result" aria-label="Result">
          <h4>
            <Icon name="calibration" size={14} /> Result of this plate: {runTest.label}
          </h4>
          <ol className="sx-small calib-steps">
            {run.instructions.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ol>
          {runTest.measure ? (
            <>
              <Field htmlFor="cal-measure" label={runTest.measure.label} aside={runTest.measure.unit} error={measuredProblem ?? undefined}>
                <Input id="cal-measure" inputMode="decimal" value={measured} onChange={(e) => setMeasured(e.target.value)} />
              </Field>
              {measuredValue !== null && !measuredProblem ? <p className="sx-small sx-muted">{runTest.result.label}: {Number(measuredValue.toFixed(runTest.result.digits))} {runTest.result.unit}</p> : null}
              <Button icon="check" disabled={measuredValue === null || measuredProblem !== null} onClick={() => {
                  if (measuredValue === null) return
                  applyCalibrationResult(runTest.id, measuredValue, slot)
                  setDone(new Set([...done, runTest.id]))
                }}>
                Save to filament
              </Button>
            </>
          ) : runTest.result.firmware ? (
            <>
              <Field htmlFor="cal-pick" label={runTest.result.label} aside={runTest.result.unit}>
                <Select id="cal-pick" value={chosen} onChange={(e) => setPicked(e.target.value)}>
                  <option value="">Choose the best band</option>
                  {candidates.map((c) => (
                    <option key={c} value={String(c)}>
                      {Number(c.toFixed(runTest.result.digits + 1))}
                    </option>
                  ))}
                </Select>
              </Field>
              {chosen && run.bandGcode?.[chosen] ? (
                <>
                  <p className="sx-small sx-muted">This goes in your printer's configuration, not in the profile. The commands below set it for one session; a printer file keeps it.</p>
                  <textarea className="sx-input sx-mono calib-gcode" readOnly rows={4} aria-label="Commands for your printer" value={run.bandGcode[chosen]} />
                  <Button icon="copy" onClick={() => void navigator.clipboard?.writeText(run.bandGcode![chosen]!).then(() => toast('Copied', 'ok'))}>
                    Copy the commands
                  </Button>
                </>
              ) : null}
            </>
          ) : (
            <>
              <Field htmlFor="cal-pick" label={runTest.result.label} aside={runTest.result.unit}>
                <Select id="cal-pick" value={chosen} onChange={(e) => setPicked(e.target.value)}>
                  <option value="">Choose the best step</option>
                  {candidates.map((c, i) => (
                    <option key={c} value={String(c)}>
                      Step {i + 1}: {c}
                    </option>
                  ))}
                </Select>
              </Field>
              <Button icon="check" disabled={!chosen} onClick={() => {
                  applyCalibrationResult(runTest.id, Number(chosen), slot)
                  setDone(new Set([...done, runTest.id]))
                }}>
                Save to filament
              </Button>
            </>
          )}
        </section>
      ) : null}
    </Dialog>
  )
}

function stringify(v: Record<string, number>): Record<string, string> {
  return Object.fromEntries(Object.entries(v).map(([k, n]) => [k, String(n)]))
}
