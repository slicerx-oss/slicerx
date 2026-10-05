// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The plate checks as plain UI: two commands run a check on the plate and show its findings in a dialog.
// A risk with a fix gets a button that applies it to that object (risk-fixes.ts); the check itself
// changes nothing, and nothing here slices or prints.
import type { Cell, ToolDisplay } from '@slicerx/contracts'
import { Button, Dialog } from '@slicerx/ui'
import { useEffect, useState } from 'react'
import { registerCommands } from '../commands/registry'
import { useHost } from '../host'
import { get, toast, useApp } from '../state/store'
import { freshWarnings, runPlateCheck, type PlateCheck, type PlateCheckKind } from './checks'
import { repairSelected } from './geom-ops'
import { applyRiskFix, fixInPlace, type RiskFix } from './risk-fixes'

const text = (c: Cell | undefined): string => (c === undefined ? '' : typeof c === 'string' ? c : c.text)
const tone = (c: Cell | undefined): string | undefined => (c !== undefined && typeof c !== 'string' ? c.tone : undefined)

export function ChecksDialog() {
  const host = useHost()
  const [view, setView] = useState<PlateCheck | 'busy' | null>(null)
  useEffect(() => {
    const open = (kind: PlateCheckKind) => {
      setView('busy')
      // Thin walls, floating islands and long bridges come from the engine's checks of a current slice.
      const sliced = kind === 'risks' && freshWarnings(get()) === null ? import('../state/actions').then((a) => a.slicePlate(host)).catch(() => undefined) : Promise.resolve()
      void sliced
        .then(() => runPlateCheck(kind, get(), host.printers))
        .then(setView)
        .catch(() => {
          setView(null)
          toast('The check could not run.', 'warn')
        })
    }
    return registerCommands([
      { id: 'check-risks', title: 'Check the plate for print risks', section: 'plate', keywords: ['warp', 'overhang', 'tall', 'before slicing', 'warnings'], workspace: 'prepare', enabled: () => get().plate.length > 0, run: () => open('risks') },
      { id: 'check-printers', title: 'Find a printer that fits this plate', section: 'plate', keywords: ['match', 'nozzle', 'enclosure', 'material', 'which printer'], workspace: 'prepare', enabled: () => get().plate.length > 0, run: () => open('printers') },
    ])
  }, [host])
  const done = view !== null && view !== 'busy' ? view : null
  return (
    <Dialog open={view !== null} onClose={() => setView(null)} title={done?.title ?? 'Checking the plate'} size="md">
      {view === 'busy' ? <p className="sx-small sx-muted">Checking the plate. It is sliced first when it changed.</p> : null}
      {done ? (
        <div className="plate-checks">
          <p className="sx-small">{done.summary}</p>
          {done.display.map((d, i) => (
            <Block key={i} d={d} />
          ))}
          {done.fixes.length ? <Fixes fixes={done.fixes} repair={() => repairSelected(host.slicer)} /> : null}
        </div>
      ) : null}
    </Dialog>
  )
}

const RISK: Record<RiskFix['risk'], string> = {
  warp: 'Warping',
  tall_thin: 'Tall and thin',
  overhang: 'Overhangs',
  open_edges: 'Open edges',
  first_layer: 'Small bed contact',
  thin_wall: 'Thin walls',
  floating: 'Floating island',
  long_bridge: 'Long bridge',
}

function Fixes({ fixes, repair }: { fixes: RiskFix[]; repair: () => Promise<unknown> }) {
  // Re-render when settings change, so a fix already in place shows as done.
  useApp((s) => s.objectSettings)
  useApp((s) => s.overrides)
  useApp((s) => s.plate)
  const [busy, setBusy] = useState<number | null>(null)
  const [repaired, setRepaired] = useState<Set<number>>(new Set())
  const apply = (f: RiskFix, i: number) => {
    setBusy(i)
    void applyRiskFix(f, repair)
      .then(() => {
        if (f.repair) setRepaired((r) => new Set(r).add(i))
        toast(f.repair ? `Repaired ${f.object}.` : `${f.label} on ${f.object}. Slice again to see it.`, 'ok')
      })
      .catch(() => toast('The fix could not be applied.', 'warn'))
      .finally(() => setBusy(null))
  }
  return (
    <ul className="warns plate-fixes" aria-label="Fixes">
      {fixes.map((f, i) => {
        const set = repaired.has(i) || fixInPlace(f)
        return (
          <li key={`${f.risk}-${f.objectId}`}>
            <span className="sx-small">
              {RISK[f.risk]} on {f.object}
            </span>
            {set ? (
              <span className="sx-small sx-muted">Applied</span>
            ) : (
              <Button size="sm" disabled={busy !== null} onClick={() => apply(f, i)}>
                {f.label}
              </Button>
            )}
          </li>
        )
      })}
    </ul>
  )
}

function Block({ d }: { d: ToolDisplay }) {
  if (d.kind === 'text') return <p className="sx-small">{d.text}</p>
  if (d.kind === 'log')
    return (
      <ul>
        {d.lines.map((l, i) => (
          <li key={i} className="sx-small" data-tone={l.tone}>
            {l.text}
          </li>
        ))}
      </ul>
    )
  if (d.kind === 'kv')
    return (
      <dl className="sx-small">
        {d.rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd data-tone={tone(v)}>{text(v)}</dd>
          </div>
        ))}
      </dl>
    )
  if (d.kind === 'table')
    return (
      <table className="sx-small">
        <thead>
          <tr>
            {d.head.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {d.rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j} data-tone={tone(c)}>
                  {text(c)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    )
  return null
}
