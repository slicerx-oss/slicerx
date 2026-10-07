// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The printer screen when setup runs again for someone who already has a printer: their printers, the
// chosen one first, kept with Next. "Add another printer" opens the usual scan.
import { Button } from '@slicerx/ui'
import { useEffect } from 'react'
import { useFleet } from '../lib/queries'
import { shownPrinter } from '../lib/use-printer'
import { VendorMark } from '../lib/vendor-mark'
import { useApp } from '../state/store'

export function KnownPrinter({ onAddAnother }: { onAddAnother: () => void }) {
  const fleet = useFleet()
  const printerId = useApp((s) => s.printerId)
  const rows = fleet.data ?? []
  const printer = shownPrinter(rows, printerId)
  const list = printer ? [printer, ...rows.filter((r) => r.id !== printer.id)] : rows
  // The stored printer is gone (removed, or another computer): nothing to keep, so the usual scan opens.
  const loading = fleet.isPending && fleet.fetchStatus !== 'idle'
  const none = !loading && list.length === 0
  useEffect(() => {
    if (none) onAddAnother()
  }, [none, onAddAnother])
  if (loading || none) return <div className="fr-wait" aria-busy="true" />
  return (
    <div className="fr-known">
      <header className="fr-head">
        <h1 className="fr-title fr-display">Your printer</h1>
        <p className="fr-lede">{list.length > 1 ? `Setup keeps your ${list.length} printers and slices for the first one.` : 'Setup keeps it as it is.'} Add another one if you like.</p>
      </header>
      <ul className="fr-known-list" aria-label="Your printers">
        {list.slice(0, 6).map((r, i) => (
          <li key={r.id} className="fr-card fr-known-row" data-on={i === 0 ? true : undefined}>
            <VendorMark vendor={r.vendor} size={28} />
            <span className="fr-card-main">
              <span className="fr-card-name">{r.name}</span>
              <span className="fr-card-sum">
                {r.vendor} {r.model}
              </span>
            </span>
            {i === 0 ? <span className="fr-known-tag">Slices for this one</span> : null}
          </li>
        ))}
      </ul>
      <Button variant="ghost" icon="plus" onClick={onAddAnother}>
        Add another printer
      </Button>
    </div>
  )
}
