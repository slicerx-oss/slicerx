// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Writing a filament slot back to the printer's AMS, as Bambu Studio does when you edit a slot there
// (`ams_filament_setting`: preset id, type, color, nozzle range). It is the person's action only: the
// approval card is the confirm, its `printer.adjust` action binds the exact setting, and the hub
// accepts the write from the app alone, never from an agent. After it, the slot shows what the printer
// reports.
import { pluginHas, type ApprovalToken, type FilamentSlot, type Host, type PrinterInfo, type SlotSetting } from '@slicerx/contracts'
import { resolveConfig } from '../adapters/config'
import { askApproval, buildApproval } from '../state/actions'
import { get, set, toast, type AppState } from '../state/store'
import { resetSlots, resolveSlots } from './slots'
import { appName } from '../edition'

interface SlotWriter {
  adjust: { setSlot(printerId: string, setting: SlotSetting, token: ApprovalToken): Promise<{ slot?: FilamentSlot; shown: boolean }> }
}

/** The hub's slot write, when the host has one (the link). */
export function slotWriter(host: Host): SlotWriter | null {
  const p = host.printers as Partial<SlotWriter> | undefined
  return typeof p?.adjust?.setSlot === 'function' ? (p as SlotWriter) : null
}

const nth = (v: unknown, i: number): number => Number(Array.isArray(v) ? (v[i] ?? v[0]) : v)

/**
 * The setting for slot `index` as SlicerX has it now, or why it cannot be written: the printer must
 * declare `slot_write` and not be printing, a spool with an RFID tag sets itself, and the slot needs a
 * filament preset with an id and a nozzle range.
 */
export function slotSettingFor(st: Pick<AppState, 'slotSetup' | 'printerSlots' | 'plate' | 'plates' | 'activePlate' | 'profile' | 'easy' | 'overrides'>, index: number, printer: Pick<PrinterInfo, 'plugin'> & { status?: { state: string } }): { setting: SlotSetting } | { reason: string } {
  if (!pluginHas(printer.plugin, 'slot_write')) return { reason: `This printer does not take a slot setting from ${appName()}.` }
  if (printer.status && ['printing', 'paused', 'preparing'].includes(printer.status.state)) return { reason: 'The printer is printing. Set the slot when it is done.' }
  const on = st.printerSlots[index - 1]
  if (!on) return { reason: 'The printer reports no slot here.' }
  if (on.spoolUid) return { reason: "This spool has an RFID tag, which sets the slot itself." }
  const slot = resolveSlots(st as AppState).find((r) => r.index === index)
  if (!slot) return { reason: 'The printer reports no slot here.' }
  const filamentId = st.profile?.filamentIds?.[index - 1] ?? ''
  if (!filamentId) return { reason: 'This filament has no preset the printer knows. Pick a brand and product.' }
  const config = resolveConfig(st.easy, st.overrides) as Record<string, unknown>
  const min = nth(config['nozzle_temperature_range_low'], index - 1)
  const max = nth(config['nozzle_temperature_range_high'], index - 1)
  if (!(min >= 150 && max <= 350 && min <= max)) return { reason: "This filament's preset has no nozzle range." }
  return { setting: { slot: on.id, filamentId, material: slot.type, color: slot.color.toLowerCase(), nozzleTempMin: Math.round(min), nozzleTempMax: Math.round(max) } }
}

/** True when the printer's slot already holds what SlicerX has. */
export function slotMatches(on: FilamentSlot | undefined, s: SlotSetting): boolean {
  return Boolean(on?.color && on.color.toLowerCase() === s.color && on.material?.toUpperCase().includes(s.material.toUpperCase()))
}

/** Asks for the person's approval, writes the slot, and shows what the printer reports afterwards. */
export async function writeSlot(host: Host, printer: PrinterInfo, index: number): Promise<void> {
  const writer = slotWriter(host)
  const approvals = host.approvals
  if (!writer || !approvals) return
  const got = slotSettingFor(get(), index, printer)
  if ('reason' in got) return void toast(got.reason, 'error')
  const s = got.setting
  const request = await buildApproval({
    tool: 'printer.adjust',
    permission: 'start',
    title: `Set slot ${s.slot} on ${printer.name} to ${s.material}?`,
    lines: [
      `${s.material}, color ${s.color}, preset ${s.filamentId}`,
      `Nozzle ${s.nozzleTempMin} to ${s.nozzleTempMax} °C`,
      `${printer.name} keeps this for slot ${s.slot} until another spool goes in, as when you set it in Bambu Studio`,
    ],
    printerId: printer.id,
    actions: [{ action: 'printer.adjust', target: printer.id, params: { printerId: printer.id, slot: s } }],
  })
  try {
    const token = await askApproval(approvals, request)
    if (!token) return
    const r = await writer.adjust.setSlot(printer.id, s, token)
    if (r.slot) set((st) => ({ printerSlots: st.printerSlots.map((x, i) => (i === index - 1 ? r.slot! : x)) }))
    if (r.shown) {
      // The printer now reports what SlicerX had, so the slot follows the printer again.
      resetSlots(index)
      toast(`${printer.name} reports slot ${s.slot} as ${r.slot?.material ?? s.material}, ${r.slot?.color ?? s.color}`, 'ok')
    } else {
      toast(`Sent to ${printer.name}. Slot ${s.slot} still reports ${r.slot?.material ?? 'nothing'}${r.slot?.color ? `, ${r.slot.color}` : ''}; check the printer's screen.`, 'error')
    }
  } catch (e) {
    toast(e instanceof Error ? e.message : `Could not reach ${printer.name}`, 'error')
  }
}
