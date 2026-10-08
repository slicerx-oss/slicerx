// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// First-run setup: Printer, then "Which slicer do you use now?", then an optional mimir screen (docs/first-run.md).
// Loaded on demand; the shell mounts it while `setup` is set in the store.
import type { LookAndFeelChoice } from '@slicerx/contracts'
import { Button, Dialog } from '@slicerx/ui'
import { lazy, Suspense, useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { useEdition } from '../edition'
import { useHost } from '../host'
import { useMediaQuery } from '../lib/media'
import { get, set, useApp, type AppState } from '../state/store'
import { Footer } from './frame'
import { themeForPreset, useLookChoice } from './look'
import { BASE_STEPS, contractStep, initialFlow, normalizeStep, outcome, progress, reduceFlow, stepLabel, type FlowState, type SetupStep } from './model'
import { MimirStep, type MimirChoice } from './mimir-step'
import { bedOf } from './printer-form'
import { withoutDirtying } from '../project/unsaved'
import { PrinterStep, usePrinterController } from './printer-step'
import { setupHostFor } from './setup-host'
import './first-run.css'
import { appName, currentEdition } from '../edition'
import { EditionMark } from '../shell/edition-logo'

// The slicer screen needs the viewport's control maps, which live in the viewport chunk; load it with the step.
const SlicerStep = lazy(() => import('./slicer-step').then((m) => ({ default: m.SlicerStep })))

export function FirstRun() {
  const host = useHost()
  const opened = useApp((s) => s.setup?.step)
  const storedLook = useApp((s) => s.lookAndFeel)
  const choice = useLookChoice()
  const phone = useMediaQuery('(max-width: 720px)')
  const setupHost = useMemo(() => setupHostFor(host), [host])
  const ctl = usePrinterController(setupHost)
  const edition = useEdition()
  // The mimir screen is offered when the edition has mimir and it is not connected yet.
  const [steps] = useState<readonly SetupStep[]>(() => (edition.features.pilot && get().pilot?.mode !== 'on' && get().pilot?.mode !== 'off' ? [...BASE_STEPS, 'mimir'] : BASE_STEPS))
  const [flow, dispatch] = useReducer(reduceFlow, null, () => initialFlow(normalizeStep(opened, steps), choice, null, steps))
  const [mimir, setMimir] = useState<MimirChoice>('skip')
  const atOpen = useRef({ look: storedLook, scheme: get().scheme, follow: get().themeFollowsSystem })
  const themeAtLook = useRef<{ scheme: 'dark' | 'light'; follow: boolean } | null>(null)
  const themeTouched = useRef(false)
  const [announce, setAnnounce] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)

  // The app behind stays visible but out of reach of focus and screen readers while setup is open.
  useEffect(() => {
    const app = document.querySelector<HTMLElement>('.app')
    app?.setAttribute('inert', '')
    return () => app?.removeAttribute('inert')
  }, [])

  // The phone help pill sits right above the footer, whatever height the footer wraps to.
  useEffect(() => {
    const root = rootRef.current
    const foot = root?.querySelector<HTMLElement>('.fr-foot')
    if (!root || !foot || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => root.style.setProperty('--fr-foot-h', `${foot.offsetHeight}px`))
    ro.observe(foot)
    return () => ro.disconnect()
  }, [flow.step])

  // Apply the look live while the flow runs, so the app behind matches the chosen card.
  useEffect(() => {
    // A null stored choice means the edition default; picking that same default writes nothing.
    if (JSON.stringify(get().lookAndFeel ?? choice) !== JSON.stringify(flow.look)) set({ lookAndFeel: flow.look })
    // choice is the value at mount; only flow.look drives this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow.look])

  // Remember the theme when the slicer screen opens, for Back. Keep progress so setup can resume from Settings.
  useEffect(() => {
    if (flow.step === 'look') {
      themeAtLook.current = { scheme: get().scheme, follow: get().themeFollowsSystem }
      themeTouched.current = false
    }
    setAnnounce(stepLabel(flow.step, flow.steps).text)
    rootRef.current?.querySelector<HTMLElement>('.fr-body')?.scrollTo({ top: 0 })
    if (!flow.closed) {
      const prior = get().firstRun
      set({ firstRun: { completedAt: prior?.completedAt ?? null, step: contractStep(flow.step), look: prior?.look ?? flow.look, printerId: prior?.printerId ?? null } })
    }
    // flow.look is read for a first record only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow.step, flow.closed])

  // Closing: write what the flow decided, then unmount.
  useEffect(() => {
    if (!flow.closed) return
    const prior = get().firstRun
    const o = outcome(flow, new Date().toISOString(), prior)
    const patch: Partial<AppState> = { firstRun: o.firstRun, setup: null }
    if (o.look) Object.assign(patch, { lookAndFeel: o.look })
    else Object.assign(patch, { lookAndFeel: atOpen.current.look, scheme: atOpen.current.scheme, themeFollowsSystem: atOpen.current.follow })
    if (o.printerId) Object.assign(patch, { printerId: o.printerId })
    if (flow.closed === 'finished') {
      if (flow.printer) {
        const bed = bedOf(ctl.form)
        if (bed) Object.assign(patch, { bed })
      }
      Object.assign(patch, { workspace: 'prepare' })
    }
    // Choosing a printer changes the bed, which is not an edit of the plate: closing right after setup must not ask to save.
    withoutDirtying(() => set(patch))
  }, [flow, ctl.form])

  const pickLook = useCallback(
    (c: LookAndFeelChoice) => {
      dispatch({ type: 'pick-look', look: c })
      if (!themeTouched.current && c.id !== flow.look.id) {
        const t = themeForPreset(c.id)
        set({ scheme: t.scheme, themeFollowsSystem: t.follow })
      }
    },
    [flow.look.id],
  )

  const back = () => {
    if (flow.step === 'look' && themeAtLook.current) set({ scheme: themeAtLook.current.scheme, themeFollowsSystem: themeAtLook.current.follow })
    dispatch({ type: 'back' })
  }

  // Escape asks before leaving (and answers Stay while that question is open).
  const leaving = useRef(false)
  leaving.current = flow.confirmLeave
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && leaving.current) {
        e.preventDefault()
        dispatch({ type: 'stay' })
        return
      }
      if (e.defaultPrevented || e.key !== 'Escape') return
      // Other native dialogs (Mouse buttons, Settings) handle their own Escape.
      if (document.querySelector('dialog[open]')) return
      e.preventDefault()
      dispatch({ type: 'request-leave' })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const label = stepLabel(flow.step, flow.steps)
  const last = flow.steps[flow.steps.length - 1] === flow.step

  return (
    <div className="fr" ref={rootRef} role="dialog" aria-modal="true" aria-labelledby="fr-step-label" data-step={flow.step} data-testid="setup" data-wide>
      <header className="fr-top" data-tauri-drag-region>
        <span className="fr-mark" role="img" aria-label={appName()}>
          <EditionMark edition={currentEdition()} size={24} />
        </span>
        <span className="fr-top-title">Set up {appName()}</span>
        <span className="fr-top-sp" />
        <Button variant="ghost" size="sm" data-testid="setup-skip-all" onClick={() => dispatch({ type: 'skip-all' })}>
          Skip, use defaults
        </Button>
        <span className="fr-stepno sx-mono" id="fr-step-label" aria-label={label.text}>
          Step {label.index} of {label.total}
        </span>
      </header>
      <div className="fr-rail" role="progressbar" aria-label="Setup progress" aria-valuemin={1} aria-valuemax={label.total} aria-valuenow={label.index} aria-valuetext={label.text}>
        <i style={{ transform: `scaleX(${progress(flow.step, flow.steps)})` }} />
      </div>
      <p className="sr-only" aria-live="polite">
        {announce}
      </p>
      <div className="fr-stage">
        <main className="fr-main">
          {flow.step === 'printer' ? (
            <PrinterStep
              ctl={ctl}
              onBack={flow.trail.length ? back : null}
              onSkip={() => dispatch({ type: 'skip' })}
              onSaved={(p) => dispatch({ type: 'printer-saved', printer: p })}
              onNoPrinter={() => {
                set({ noPrinter: true })
                dispatch({ type: 'no-printer' })
              }}
              helpVisible
              phone={phone}
            />
          ) : null}
          {flow.step === 'look' ? (
            <>
              <div className="fr-body">
                <Suspense fallback={<div className="fr-wait" aria-busy="true" />}>
                  <SlicerStep choice={flow.look} onPick={pickLook} onTheme={() => (themeTouched.current = true)} phone={phone} />
                </Suspense>
              </div>
              <Footer
                back={flow.trail.length ? { label: 'Back', onClick: back } : null}
                primary={last ? { label: 'Open the plate', onClick: () => dispatch({ type: 'finish' }), icon: 'prepare' } : { label: 'Next', onClick: () => dispatch({ type: 'next' }), icon: 'arrow-right' }}
              />
            </>
          ) : null}
          {flow.step === 'mimir' ? (
            <>
              <div className="fr-body">
                <MimirStep choice={mimir} onChoose={setMimir} />
              </div>
              <Footer
                back={flow.trail.length ? { label: 'Back', onClick: back } : null}
                skip={mimir === 'skip' ? null : { label: 'Skip', onClick: () => dispatch({ type: 'finish' }) }}
                primary={{ label: 'Open the plate', onClick: () => dispatch({ type: 'finish' }), icon: 'prepare' }}
              />
            </>
          ) : null}
        </main>
      </div>
      {/* Required: only its buttons and Escape (handled above) answer it, so a late native close event cannot undo a new question. */}
      <Dialog
        open={flow.confirmLeave}
        required
        onClose={() => undefined}
        title="Leave setup?"
        testId="setup-leave-dialog"
        footer={
          <>
            <Button data-testid="setup-leave" onClick={() => dispatch({ type: 'leave' })}>Leave</Button>
            <Button variant="primary" autoFocus data-testid="setup-stay" onClick={() => dispatch({ type: 'stay' })}>
              Stay
            </Button>
          </>
        }
      >
        <p>You can finish it later from Settings.</p>
      </Dialog>
    </div>
  )
}

export type { SetupStep }
