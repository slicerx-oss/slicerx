// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Whether the printer's bed is known to be clear. The Print sheet's confirm button carries the
// bed-clear statement only when it is not: a local start right after the printer saw the last
// plate removed is a plain "Start print". The answer comes from the hub (link-client `bed.state`)
// when the printer host is a connected bridge; any other host cannot
// tell, so the statement shows (docs/safety.md, bed clear row).
import type { Host, JobFile, PrinterStatus, StartOptions } from '@slicerx/contracts'

export type BedState =
  /** The hub confirmed the last plate was removed and nothing ran since. */
  | 'clear'
  /** Nothing confirms the bed is empty: the last job ended with no removal, or the printer cannot tell. */
  | 'unknown'
  /** The start comes from somewhere other than this screen (phone, mimir, MCP), so nobody may be present. */
  | 'remote'

/** The hub's answer about a build plate (link-client `BedInfo`, the part the sheet reads). */
interface BedInfo {
  state: 'clear' | 'not_cleared' | 'unknown' | 'busy'
  askOnPrint: boolean
}

/** The hub methods the sheet uses when the printer host is a connected bridge. */
export interface LocalPrintHost {
  /** `objects`: the plate's labeled objects, kept by the hub for printers that cannot list them (Bambu Lab). */
  printLocal(printerId: string, file: JobFile, opts?: StartOptions, bedClear?: boolean, objects?: { id: string; name: string; skipped: false; polygon: [number, number][] }[]): Promise<unknown>
  bed: { state(printerId: string): Promise<BedInfo> }
}

/** The printer host as a hub, when it is one (the bridge puts the link host in `host.printers`). */
export function localPrintHost(host: Host): LocalPrintHost | null {
  const p = host.printers as Partial<LocalPrintHost> | undefined
  return p && typeof p.printLocal === 'function' && p.bed && typeof p.bed.state === 'function' ? (p as LocalPrintHost) : null
}

/** The bed state for a local start from this screen. Unknown whenever the host cannot say. */
export async function bedStateFor(host: Host, printerId: string, _status: PrinterStatus | null): Promise<BedState> {
  const hub = localPrintHost(host)
  if (!hub) return 'unknown'
  try {
    const info = await hub.bed.state(printerId)
    return info.askOnPrint ? 'unknown' : 'clear'
  } catch {
    return 'unknown'
  }
}

/** The confirm button's label for a start: the safety statement when the bed is not known to be clear. */
export function startLabel(bed: BedState): string {
  return bed === 'clear' ? 'Start print' : 'Bed is clear, start print'
}
