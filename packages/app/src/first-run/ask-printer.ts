// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// With no printers at all, the desktop app opens printer setup once per launch, after the agreement and any setup
// already showing. "I do not have a printer yet" and "Slice without a printer" stop it; the Model workspace still
// offers Add your printer. Having a printer again, however it was added, clears "no printer", so a person who later
// removes every printer is asked again.
import { useEffect } from 'react'
import { useHost } from '../host'
import { bridgeConnector } from '../link/connector'
import { useFleet, usePrinters } from '../lib/queries'
import { set, useApp } from '../state/store'
import { openSetup } from './look'

let offered = false

/** Whether launch should open printer setup now. */
export function shouldAskForPrinter(s: { kind: string; printers: number | null; bridgeSettled: boolean; setupOpen: boolean; agreementOpen: boolean; noPrinter: boolean; offered: boolean }): boolean {
  return s.kind === 'desktop' && s.bridgeSettled && s.printers === 0 && !s.setupOpen && !s.agreementOpen && !s.noPrinter && !s.offered
}

/** Whether "no printer" should be cleared: the fleet has answered and it has a printer. */
export function clearsNoPrinter(s: { printers: number | null; noPrinter: boolean }): boolean {
  return s.noPrinter && s.printers !== null && s.printers > 0
}

export function useAskForPrinter(): void {
  const host = useHost()
  const fleet = useFleet()
  const source = usePrinters()
  // The desktop bridge brings the network printers; until it answers, an empty list means nothing yet.
  const bridge = useApp((s) => s.bridgeStatus.state)
  const bridgeSettled = !bridgeConnector()?.automatic || bridge === 'on' || bridge === 'error'
  const setupOpen = useApp((s) => s.setup !== null)
  const agreementOpen = useApp((s) => s.agreementOpen)
  const noPrinter = useApp((s) => s.noPrinter)
  const printers = !source ? null : fleet.isSuccess && !fleet.isFetching ? (fleet.data?.length ?? 0) : null
  useEffect(() => {
    if (clearsNoPrinter({ printers, noPrinter })) set({ noPrinter: false })
  }, [printers, noPrinter])
  useEffect(() => {
    // Setup that showed this launch (the first run, or opened by hand) already asked.
    if (setupOpen) offered = true
    if (!shouldAskForPrinter({ kind: host.kind, printers, bridgeSettled, setupOpen, agreementOpen, noPrinter, offered })) return
    offered = true
    openSetup('printer')
  }, [host.kind, printers, bridgeSettled, setupOpen, agreementOpen, noPrinter])
}
