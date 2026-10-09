// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Slice sidebar's footer: the estimate on one line (time, grams, cost, filament changes, warnings), the time
// opening a breakdown, and the one Print as a split button with the file exports in its menu.
import { Button, Menu, MenuItem, Popover, SplitButton, tipAttrs } from '@slicerx/ui'
import { lazy, Suspense, useState, type CSSProperties } from 'react'
import { useHost } from '../../host'
import { slicedIn } from '../../lib/estimate-line'
import { isExportOnly } from '../../lib/hand-printers'
import { formatCost, formatDuration, formatGrams } from '../../lib/preview-stats'
import { useSliceNote } from '../../lib/slice-note'
import { printTarget, usePrinter } from '../../lib/use-printer'
import { useWaited } from '../../lib/waited'
import { printBlock } from '../../plate/heimdall'
import { sequenceProblem } from '../../plate/sequence-check'
import { cancelSlice, exportGcode, sendToPrinter, slicePlate } from '../../state/actions'
import { get, showSliced, shownSlice, toast, useApp } from '../../state/store'
import { sliceFraction } from '../slice-progress'
import './estimate-footer.css'

const SliceGlide = lazy(() => import('../../ravens/waits').then((m) => ({ default: m.SliceGlide })))
// The breakdown reads the toolpath summary; its code loads when it is first opened.
const Breakdown = lazy(() => import('./estimate-breakdown').then((m) => ({ default: m.EstimateBreakdown })))

/** The estimate and the one Print. `label` is the look's name for the Slice action. */
export function SliceBlock({ label = 'Slice plate' }: { label?: string; compact?: boolean }) {
  const host = useHost()
  const sliceNote = useSliceNote()
  const slice = useApp((s) => s.slice)
  const plate = useApp((s) => s.plate)
  const auto = useApp((s) => s.autoSlice)
  // While a new slice runs the last one stays, stale, so the estimate never empties and comes back.
  const done = shownSlice(slice)
  // A strike in the slice holds Print and Export back. Before a slice, objects closer or taller than the printer
  // profile allows by object are a heads-up: heimdall checks every move when the plate slices.
  const unsafe = useApp(printBlock)
  const heads = useApp(sequenceProblem)
  const fresh = done !== null && !done.stale && unsafe === null
  const { printer, rows } = usePrinter()
  const target = printTarget(printer, rows)
  const exportOnly = printer !== undefined && isExportOnly(printer)
  const [menu, setMenu] = useState(false)
  const [breakdown, setBreakdown] = useState(false)
  const progress = slice.status === 'running' ? slice.progress : null
  const running = slice.status === 'running'
  // A slice past about 1.2 s gets muninn riding its bar.
  const longSlice = useWaited(running)
  // Slice, Print and the export-only printer's Export wait while a model is still loading; the menu stays usable.
  const loading = useApp((s) => s.plateLoading)

  // Why the main action waits, as its tooltip.
  const reason = plate.length === 0 ? 'Add a model to the plate.' : loading ? 'The model is still loading.' : unsafe !== null ? unsafe : heads !== null && !done ? heads : !fresh ? (auto ? 'The slice is updating.' : 'Slice the plate first.') : undefined
  const run = (fn: () => Promise<unknown>) => {
    setMenu(false)
    void fn().catch((e: unknown) => toast(e instanceof Error ? e.message : String(e), 'error'))
  }
  const outputMenu = (
    <Menu open={menu} onClose={() => setMenu(false)} label="Output" align="end">
      <MenuItem icon="sd-card" data-testid="slice-output-export-gcode" aria-disabled={!fresh ? true : undefined} {...(!fresh && reason ? tipAttrs({ title: 'Export G-code', reason }) : {})} onClick={() => fresh && run(() => exportGcode(host))}>
        Export G-code
      </MenuItem>
      <MenuItem icon="send-to-printer" data-testid="slice-output-export-3mf" aria-disabled={unsafe !== null || plate.length === 0 ? true : undefined} {...(unsafe !== null ? tipAttrs({ title: 'Export plate 3MF', reason: unsafe }) : {})} onClick={() => unsafe === null && plate.length > 0 && run(() => import('../../export/actions').then((m) => m.exportGcode3mf(host)))}>
        Export plate 3MF
      </MenuItem>
    </Menu>
  )
  // With Auto slice on there is no Slice button: Print is the action, ready once the background slice is current. It
  // opens the Print sheet on that printer; without one it shows the preview, where the G-code export lives. An
  // export-only printer's action is Export G-code.
  const primary = !auto && !(done && !done.stale) ? (
    <Button variant="primary" size="lg" full icon="slice" data-testid="slice-estimate-slice" disabled={plate.length === 0 || loading} {...(loading ? { tip: { title: label, reason: 'The model is still loading.' } } : {})} onClick={() => void slicePlate(host).then(() => get().slice.status === 'done' && showSliced())}>
      {done && !done.stale ? 'Slice again' : label}
    </Button>
  ) : exportOnly ? (
    <SplitButton variant="primary" size="lg" full icon="sd-card" data-testid="slice-estimate-export-gcode" disabled={!fresh || loading} {...(reason ? { tip: { title: 'Export G-code', reason } } : {})} menuLabel="More output" menuOpen={menu} onMenu={() => setMenu(!menu)} menuProps={{ 'data-testid': 'slice-output-menu' }} menu={outputMenu} onClick={() => void exportGcode(host)}>
      Export G-code
    </SplitButton>
  ) : (
    <SplitButton variant="primary" size="lg" full icon="send-to-printer" data-testid="danger-slice-print" disabled={!fresh || loading} {...(reason ? { tip: { title: 'Print', reason } } : {})} menuLabel="More output" menuOpen={menu} onMenu={() => setMenu(!menu)} menuProps={{ 'data-testid': 'slice-output-menu' }} menu={outputMenu} onClick={() => (target ? void sendToPrinter(host, target) : showSliced())}>
      Print
    </SplitButton>
  )
  // With Auto slice off and a current slice, Slice again sits on the estimate line as a quiet button.
  const again = !auto && done && !done.stale && !running ? (
    <Button size="sm" variant="ghost" icon="slice" className="est-again" data-testid="slice-estimate-slice" onClick={() => void slicePlate(host).then(() => get().slice.status === 'done' && showSliced())}>
      Slice again
    </Button>
  ) : null

  // A slice in progress takes the button's place in a track of the button's own height, so the footer never moves
  // when a slice starts or ends; muninn rides the bar in the track's top row, clear of the text above.
  const track = (
    <div className="slice-track" role="status" aria-label={progress ? `Slicing, ${progress.stage}` : 'Slicing'} data-testid="slice-track">
      <div className="rv-ride" style={{ '--p': Math.max(0.04, sliceFraction(progress)) } as CSSProperties}>
        <div className="app-bar-track">
          <i style={{ transform: `scaleX(${Math.max(0.04, sliceFraction(progress))})` }} />
        </div>
        {longSlice ? <Suspense fallback={null}><SliceGlide done={false} /></Suspense> : null}
      </div>
      <Button size="sm" variant="ghost" onClick={() => cancelSlice()}>
        Cancel
      </Button>
    </div>
  )
  const problems = (
    <>
      {unsafe !== null ? (
        <p className="app-err" role="alert">
          {unsafe}
        </p>
      ) : heads !== null && !done ? (
        <p className="app-note">{heads}</p>
      ) : null}
      {slice.status === 'error' ? (
        <p className="app-err est-error" role="alert" data-testid="slice-estimate-error">
          {slice.message}
        </p>
      ) : null}
    </>
  )

  if (!done) {
    // Before a first slice, and while it runs, one muted line above the button or the track.
    const stageLine = progress ? `Slicing: ${progress.stage}` : 'Slicing'
    return (
      <div className="slice-lite" data-section="estimate" data-testid="slice-estimate">
        <p className="est-line">{running ? stageLine : plate.length ? (auto ? 'Time, filament and cost appear after the first slice.' : 'Slice to see time, filament and cost.') : 'Add a model to the plate.'}</p>
        {running ? track : primary}
        {problems}
      </div>
    )
  }

  const r = done.result
  const grams = r.stats.filamentG.reduce((a, b) => a + b, 0)
  const used = r.stats.filamentG.filter((g) => g > 0).length
  const warnings = r.warnings.length
  return (
    <div className="slice-lite slice-done" data-section="estimate" data-testid="slice-estimate" data-stale={done.stale ? true : undefined}>
      <div className="est-row">
        <span className="sx-menu-anchor est-anchor">
          <button type="button" className="est-time" data-testid="slice-estimate-time" aria-haspopup="dialog" aria-expanded={breakdown} {...tipAttrs({ title: slicedIn(r.wallMs, host.capabilities.threads), body: 'Click for where the time and filament go.' })} onClick={() => setBreakdown(!breakdown)}>
            {formatDuration(r.stats.timeS)}
          </button>
          <Popover open={breakdown} onClose={() => setBreakdown(false)} label="Estimate breakdown" className="est-pop">
            <Suspense fallback={<div className="ws-loading" aria-busy="true" />}>
              <Breakdown />
            </Suspense>
          </Popover>
        </span>
        <span className="est-fig">{formatGrams(grams)}</span>
        {r.stats.cost > 0 ? <span className="est-fig">{formatCost(r.stats.cost)}</span> : null}
        {used > 1 ? <span className="est-fig est-muted">{r.stats.toolChanges} {r.stats.toolChanges === 1 ? 'change' : 'changes'}</span> : null}
        <span className="est-grow" />
        {warnings > 0 ? (
          <button type="button" className="est-warn" data-testid="slice-estimate-warnings" {...tipAttrs({ title: warnings === 1 ? '1 warning' : `${warnings} warnings`, body: 'Show the first one on the plate.' })} onClick={() => void import('../../lib/warning-actions').then((m) => r.warnings[0] && m.jumpToWarning(r.warnings[0]))}>
            {warnings} {warnings === 1 ? 'warning' : 'warnings'}
          </button>
        ) : null}
        {done.stale ? <span className="app-tag stale">{auto ? 'Updating' : 'Settings changed'}</span> : null}
        {again}
      </div>
      {running && auto ? (
        <div className="slicing-edge" role="status" aria-label="Slicing">
          <i style={{ transform: `scaleX(${Math.max(0.04, sliceFraction(progress))})` }} />
        </div>
      ) : null}
      {running && !auto ? track : primary}
      {problems}
      {sliceNote ? <p className="app-note">{sliceNote}</p> : null}
    </div>
  )
}
