// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The spool pick in the chat: once a run has finished a part and the printer has spools loaded, the Filament section's
// spools come up under the run's last words, so the part goes to slicing on the spool the person picks.
import type { Transcript } from '@slicerx/pilot/ui'
import { useEffect } from 'react'
import { spoolLeft } from '../../filament/left'
import { SlotRail } from '../../filament/slot-rail'
import { useResolvedSlots } from '../../filament/use-slots'
import { usePrinter } from '../../lib/use-printer'
import { set, useApp } from '../../state/store'

/** The last run built something and ended: no question or sheet waiting, no error, not stopped. */
export function finishedPart(t: Transcript, running: boolean): boolean {
  if (running) return false
  const blocks = t.turns.at(-1)?.blocks ?? []
  const last = blocks.at(-1)
  if (!last || last.kind === 'error' || (last.kind === 'summary' && last.stopped)) return false
  if (blocks.some((b) => (b.kind === 'choice' && b.picked === null) || (b.kind === 'sheet' && b.answer === null))) return false
  return blocks.some((b) => b.kind === 'tools' || b.kind === 'summary')
}

export function MimirFilamentPick({ transcript, running }: { transcript: Transcript; running: boolean }) {
  // The Slice sidebar keeps the printer's spools in the store; this tab may open before it ever showed.
  const reported = usePrinter().printer?.status.slots
  useEffect(() => {
    if (reported) set({ printerSlots: reported })
  }, [reported])
  const slots = useResolvedSlots()
  const loaded = useApp((s) => s.printerSlots.some((p) => p.material || p.color))
  const parts = useApp((s) => s.plate.length)
  if (!finishedPart(transcript, running) || !loaded || parts === 0) return null
  return (
    <section className="mimir-filament" data-testid="mimir-filament" aria-label="Pick a filament">
      <h3>Print with</h3>
      <SlotRail slots={slots} left={spoolLeft} />
    </section>
  )
}
