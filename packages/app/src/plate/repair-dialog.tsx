// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The details view of a mesh repair: what was fixed, per object, in plain words.
import { Dialog } from '@slicerx/ui'
import { useEffect } from 'react'
import { registerCommands } from '../commands/registry'
import { toast } from '../state/store'
import { closeRepairReport, repairChanged, repairLines, showLastRepair, sumRepair, useRepairReport } from './repair-report'

export function RepairDialog() {
  const view = useRepairReport()
  useEffect(
    () =>
      registerCommands([
        { id: 'repair-report', title: 'Show the last repair report', section: 'plate', keywords: ['mesh', 'fixed', 'holes', 'details'], run: () => void (showLastRepair() || toast('No repair has run yet.', 'info')) },
      ]),
    [],
  )
  const total = view ? sumRepair(view.entries.map((e) => e.report)) : null
  return (
    <Dialog open={view !== null} onClose={closeRepairReport} title={view?.title ?? 'Repair report'} size="md">
      {view && total ? (
        <div className="repair-report">
          {view.entries.length > 1 ? <p className="sx-small sx-muted">All together</p> : null}
          <Lines lines={repairLines(total)} clean={!repairChanged(total)} />
          {view.entries.length > 1
            ? view.entries.map((e) => (
                <section key={e.label}>
                  <h4 className="sx-small">{e.label}</h4>
                  <Lines lines={repairLines(e.report)} clean={!repairChanged(e.report)} />
                </section>
              ))
            : null}
          {total.watertight === undefined ? null : <p className="sx-small sx-muted">{total.watertight ? 'The result is closed and ready to slice.' : 'The result still has open edges. Slicing may leave gaps there.'}</p>}
        </div>
      ) : null}
    </Dialog>
  )
}

function Lines({ lines, clean }: { lines: string[]; clean: boolean }) {
  if (lines.length === 0) return <p className="sx-small">{clean ? 'Nothing needed fixing.' : 'Nothing to report.'}</p>
  return (
    <ul>
      {lines.map((l) => (
        <li key={l}>{l}</li>
      ))}
    </ul>
  )
}
