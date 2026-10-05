// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The nozzle size of the selected printer. The size picks the printer, filament and process presets that match it
// (a 0.6 mm nozzle prints at 0.24 to 0.4 mm layers with wider lines), so it is set per printer and kept. A printer that
// reports its own size shows that size and cannot be changed here.
import { Seg } from '@slicerx/ui'
import { setPrinterNozzle } from '../../state/profile-sync'
import { useApp } from '../../state/store'

const label = (n: number): string => `${n} mm`

export function NozzlePicker({ id = 'nozzle' }: { id?: string }) {
  const profile = useApp((s) => s.profile)
  const printerId = useApp((s) => s.printerModel?.id)
  if (!profile || !printerId || profile.nozzles.length < 2) return null
  const fixed = profile.nozzleFrom === 'printer'
  return (
    <div className="nozzle-picker" data-section="nozzle">
      <span className="sx-small sx-muted" id={`${id}-l`}>
        Nozzle
      </span>
      <Seg<string>
        label="Nozzle size"
        size="sm"
        value={String(profile.nozzle)}
        options={profile.nozzles.map((n) => ({ value: String(n), label: label(n), disabled: fixed && n !== profile.nozzle }))}
        onChange={(v) => setPrinterNozzle(printerId, Number(v))}
      />
      {fixed ? <span className="sx-small sx-muted">The printer reports this nozzle.</span> : null}
    </div>
  )
}
