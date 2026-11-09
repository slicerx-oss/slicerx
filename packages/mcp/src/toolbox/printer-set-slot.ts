// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Asks a person to set one filament slot (an AMS slot's type, color, preset and nozzle range), as the app's own slot
// write does. The hub checks the setting against the printer, raises a card only a person answers in the app on the
// computer (never from a phone away from home), and writes the slot itself once they approve it. The client never
// gets a token and cannot answer the card. Without a setting it reads the slots back.
import { pluginHas, productName, REASON_PREFIX, type FilamentSlot, type PrinterInfo, type SlotSetting } from '@slicerx/contracts'
import { z } from 'zod'
import { ToolInputError } from '../models'
import { serverTool, type ServerToolDeps } from './deps'

/** Filament types the hub takes on a slot card (sx-link agent_work.rs SLOT_MATERIALS), in capitals as printers store them. */
export const SLOT_MATERIALS = ['PLA', 'PETG', 'PET', 'ABS', 'ASA', 'PC', 'PA', 'TPU', 'PVA', 'HIPS', 'PP', 'PPS', 'PEEK', 'BVOH', 'EVA', 'PLA-CF', 'PETG-CF', 'PET-CF', 'PA-CF', 'PA6-CF', 'PAHT-CF', 'PPA-CF', 'PPS-CF', 'ABS-GF', 'PA-GF', 'PPA-GF'] as const

// The hub's own rules for a slot setting (SlotSetting::problem in sx-connect).
const ID = /^[A-Za-z0-9_+. -]+$/
const temp = z.number().int().min(150).max(350)
const setting = z.object({
  slot: z.string().min(1).max(4).regex(ID).describe('Slot id as the printer reports it, such as "A2" (slicerx_printer_status slots)'),
  material: z.string().min(2).max(12).regex(/^[A-Za-z0-9-]+$/).describe(`Filament type, one of ${SLOT_MATERIALS.join(', ')}`),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).describe('Color as #rrggbb'),
  filamentId: z.string().min(1).max(16).regex(ID).describe(`The slot's name: the filament preset id the printer knows, such as "GFG99" (at most 16 characters)`),
  nozzleTempMin: temp.describe('Lowest nozzle temperature for this filament, °C'),
  nozzleTempMax: temp.describe('Highest nozzle temperature for this filament, °C, at least nozzleTempMin'),
})

type Input = { printerId: string; setting?: z.infer<typeof setting> | undefined; reason?: string | undefined }

/** The setting as the hub checks and hashes it: the type in capitals, the color in lower case, these keys only. */
function asSetting(s: z.infer<typeof setting>): SlotSetting {
  const material = s.material.toUpperCase()
  if (!(SLOT_MATERIALS as readonly string[]).includes(material)) throw new ToolInputError(`"${s.material}" is not a filament type the hub takes on a slot. Use one of ${SLOT_MATERIALS.join(', ')}.`, 'invalid_input')
  if (s.nozzleTempMin > s.nozzleTempMax) throw new ToolInputError('nozzleTempMin is at most nozzleTempMax.', 'invalid_input')
  return { slot: s.slot, filamentId: s.filamentId, material, color: s.color.toLowerCase(), nozzleTempMin: s.nozzleTempMin, nozzleTempMax: s.nozzleTempMax }
}

/** Why the printer cannot take a slot setting now, or null. The hub checks again before it raises the card. */
function notSettable(info: PrinterInfo, state: string): string | null {
  if (!pluginHas(info.plugin, 'slot_write')) return `This printer does not take a slot setting from ${productName()}.`
  if (['printing', 'paused', 'preparing'].includes(state)) return 'The printer is printing. A slot is set while no print runs.'
  return null
}

export default (d: ServerToolDeps) => {
  const printers = d.printers
  if (!printers) return null
  const hub = () => {
    if (printers.kind !== 'link') throw new ToolInputError(`These printers have no hub. A slot is set beside the ${productName()} app, through its hub.`, 'not_supported', { reason: 'no_hub' })
    return printers.host
  }
  const printer = async (id: string): Promise<PrinterInfo> => {
    const info = (await hub().list()).find((p) => p.id === id)
    if (!info) throw new ToolInputError(`No printer ${id}`, 'not_found')
    return info
  }
  return serverTool<Input>({
    name: 'printer.set_slot',
    title: 'Set a filament slot',
    version: '1.0.0',
    source: 'command',
    permission: 'start',
    // Reading the slots is a read; asking for a card is a change to the printer that a person approves.
    classNote: 'start (Start or resume prints) when setting changes the slot, read when it only reads it',
    permissionFor: (i) => (i.setting ? 'start' : 'read'),
    printerFor: (i) => i.printerId,
    toolset: 'printers',
    description: `Ask a person to set one filament slot on a printer, such as an AMS slot: its filament type, color, name (the printer's filament preset id, filamentId) and nozzle range, as when the person edits the slot in ${productName()}. With setting, the ${productName()} hub checks it against the printer (a printer whose driver writes slots, no print running, a slot it reports, no spool with an RFID tag, which sets the slot itself) and raises an approval card; a person approves in the app on the computer, and a phone away from home cannot approve it. The hub writes the slot once they approve. This tool never writes a slot itself and cannot approve the card; slicerx_approve cannot either. Returns status needs_person and request_id; read the outcome with slicerx_pending_approvals (done or failed with the hub's code) and the slot itself with this tool without setting. Without setting it reads the printer's slots as it reports them (output.slots: id, material, color, remaining), whether a slot can be set now (output.settable) and why not (output.reason). Refusals: invalid_input for a setting outside the rules (material one of ${SLOT_MATERIALS.join(', ')}; color #rrggbb; filamentId, the slot's name, is the preset id of 1 to 16 letters, digits or _ + . - and space; nozzle range 150 to 350 °C, low before high), not_found for a slot or printer the hub does not know, not_supported for a printer that takes no slot setting, bad_state while a print runs, refused for a spool with an RFID tag. Simulated printers have no hub and are refused with not_supported and reason no_hub.`,
    input: z.object({
      printerId: z.string().min(1).describe('Id from slicerx_printer_list, such as "bay-1"'),
      setting: setting.optional().describe('The slot to set. Leave out to read the slots back.'),
      reason: z.string().min(3).max(200).optional().describe('Why, in plain words, such as "The spool tag says PETG"; shown on the card'),
    }),
    hints: { readOnly: false, idempotent: true, openWorld: true },
    async approval(i) {
      if (!i.setting) throw new ToolInputError('Give setting to ask for a slot change.', 'invalid_input')
      const s = asSetting(i.setting)
      const info = await printer(i.printerId)
      return {
        title: `Set slot ${s.slot} on ${info.name} to ${s.material}?`,
        lines: [...(i.reason ? [`${REASON_PREFIX}${i.reason}`] : []), `${s.material}, color ${s.color}, preset ${s.filamentId}`, `Nozzle ${s.nozzleTempMin} to ${s.nozzleTempMax} °C`],
        printerId: info.id,
        actions: [{ action: 'printer.adjust' as const, target: info.id, params: { printerId: info.id, slot: s } }],
      }
    },
    async agentWork(i) {
      if (!i.setting) throw new ToolInputError('Give setting to ask for a slot change.', 'invalid_input')
      const info = await printer(i.printerId)
      return { kind: 'slot', printerId: info.id, setting: asSetting(i.setting) }
    },
    async run(i) {
      // A slot is written by the hub once a person approves its card; there is no other path for it.
      if (i.setting) return { ok: false, summary: `Setting a slot runs through the ${productName()} hub, once a person approves the card.` }
      const info = await printer(i.printerId)
      const status = await hub().status(info.id)
      const why = notSettable(info, status.state)
      const slots = (status.slots ?? []).map((s: FilamentSlot) => ({ id: s.id, material: s.material ?? null, color: s.color ?? null, remainingPct: s.remainingPct ?? null, tagged: Boolean(s.spoolUid) }))
      return {
        summary: why ? `${info.name}: ${why}` : `${info.name}: ${slots.length} slot${slots.length === 1 ? '' : 's'}; set one with setting`,
        output: { printerId: info.id, settable: why === null, ...(why ? { reason: why } : {}), slots },
      }
    },
  })
}
