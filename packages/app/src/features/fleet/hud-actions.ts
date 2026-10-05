// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What the device view changes on a printer besides pause, resume and stop (those are printerAction):
// the speed profile, which a person approves on a printer.adjust card the hub takes from the app
// alone, and the chamber light, the app's own switch like the one on the printer's screen.
import type { ApprovalToken, Host, PrinterInfo } from '@slicerx/contracts'
import { askApproval, buildApproval } from '../../state/actions'
import { toast } from '../../state/store'
import { SPEED_PROFILES, type SpeedLimits } from './hud'

interface AdjustHub {
  adjust: {
    limits(printerId: string): Promise<{ speed: SpeedLimits }>
    apply(printerId: string, change: { kind: 'speed'; percent: number }, token: ApprovalToken): Promise<void>
    light?(printerId: string, on: boolean): Promise<void>
  }
}

/** The hub's print changes, when the host has them (the link). */
export function adjustHub(host: Host): AdjustHub | null {
  const p = host.printers as Partial<AdjustHub> | undefined
  return typeof p?.adjust?.apply === 'function' && typeof p.adjust.limits === 'function' ? (p as AdjustHub) : null
}

/** Asks for the person's approval, then sets the speed profile. Nothing reaches the printer without the approved card. */
export async function setSpeed(host: Host, printer: Pick<PrinterInfo, 'id' | 'name'>, percent: number): Promise<boolean> {
  const hub = adjustHub(host)
  const approvals = host.approvals
  const profile = SPEED_PROFILES.find((p) => p.percent === percent)
  if (!hub || !approvals || !profile) return false
  const change = { kind: 'speed' as const, percent }
  const request = await buildApproval({
    tool: 'printer.adjust',
    permission: 'start',
    title: `Print ${printer.name} at ${profile.label} speed?`,
    lines: [`${profile.label}: ${percent}% of the sliced speeds`, 'Takes effect from the next moves of this print'],
    printerId: printer.id,
    actions: [{ action: 'printer.adjust', target: printer.id, params: { printerId: printer.id, change } }],
  })
  try {
    const token = await askApproval(approvals, request)
    if (!token) return false
    await hub.adjust.apply(printer.id, change, token)
    toast(`${printer.name} prints at ${profile.label} speed`, 'ok')
    return true
  } catch (e) {
    toast(e instanceof Error ? e.message : `Could not reach ${printer.name}`, 'error')
    return false
  }
}

/** Switches the chamber light. */
export async function setLight(host: Host, printer: Pick<PrinterInfo, 'id' | 'name'>, on: boolean): Promise<void> {
  const hub = adjustHub(host)
  if (!hub?.adjust.light) return
  try {
    await hub.adjust.light(printer.id, on)
  } catch (e) {
    toast(e instanceof Error ? e.message : `Could not reach ${printer.name}`, 'error')
  }
}
