// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// G-code lint for the send sheet: mimir's gcode_inspect run as a plain function (no model, no
// key). It reads the exported file and warns about flow over the filament profile's limit and
// nozzle temperatures outside the material's range. Warnings only: it never blocks a send.
import type { PrinterHost, SliceResult } from '@slicerx/contracts'

/** Bigger files are skipped rather than parsed on the UI thread. */
const MAX_BYTES = 20_000_000

/** A print this long runs unattended for most people, so the overnight checks (camera, runout sensor, spool margin) join the warnings. */
export const OVERNIGHT_S = 8 * 3600

/** One line in the Print sheet's checks: a short sentence, with the numbers and what to do in its tooltip. */
export interface SheetNote {
  text: string
  tip?: string
}

type Rec = Record<string, unknown>
const rec = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {})
const grams = (g: number): string => `${Math.round(g)} g`

/** The G-code findings worded for the sheet: sustained flow over the material's limit, a nozzle temperature out of range. */
export function gcodeNotes(output: unknown): SheetNote[] {
  const facts = Array.isArray(rec(output)['facts']) ? (rec(output)['facts'] as Rec[]) : []
  const out: SheetNote[] = []
  for (const f of facts) {
    if (f['kind'] === 'flow' && f['basis'] === 'profile') {
      out.push({ text: 'The G-code runs faster than its filament profile allows', tip: `Most of the print runs at up to ${f['mm3s']} mm3/s; the filament profile allows ${f['limit']} mm3/s. Slice it again with this profile.` })
    } else if (f['kind'] === 'flow') {
      const hf = typeof f['highFlow'] === 'number' ? ` A high flow hotend takes ${f['highFlow']} mm3/s.` : ''
      out.push({ text: `Prints faster than ${f['material']} melts in a standard hotend`, tip: `Most of the print runs at up to ${f['mm3s']} mm3/s; ${f['material']} manages about ${f['limit']} mm3/s in a standard hotend.${hf} Expect thin, weak walls unless the hotend is high flow.` })
    } else if (f['kind'] === 'temp' && typeof f['c'] === 'number') {
      const hot = typeof f['hi'] === 'number' && f['c'] > f['hi']
      out.push({ text: `Nozzle at ${f['c']} C is too ${hot ? 'hot' : 'cold'} for ${f['material']}`, tip: `${f['material']} prints between ${f['lo'] ?? '?'} and ${f['hi'] ?? '?'} C. Check the filament profile.` })
    }
  }
  return out
}

/**
 * The spool check worded for the sheet. Says nothing when the spool covers the print or when nobody knows how much
 * is left: an AMS without a reading reports -1 or 0, and that is not an empty spool.
 */
export function spoolNotes(output: unknown): SheetNote[] {
  const r = rec(output)
  if (r['status'] === 'pass' || typeof r['availG'] !== 'number' || (r['availSource'] !== 'spoolman' && r['availSource'] !== 'estimated')) return []
  const slot = typeof r['slot'] === 'string' ? r['slot'] : 'the loaded slot'
  const avail = r['availG'] as number
  const need = typeof r['needG'] === 'number' ? r['needG'] : 0
  if (need <= 0) return []
  const backups = (Array.isArray(r['backups']) ? r['backups'] : []).map(rec)
  const refill = r['autoRefill'] === true ? backups.find((b) => b['enough'] === true) : undefined
  const left = `About ${grams(avail)} left in ${slot}${r['availSource'] === 'estimated' ? ' (from the AMS percentage)' : ''}; the print needs ${grams(need)}.`
  if (refill) return [{ text: `${slot} may run out; the AMS then switches to ${String(refill['slot'])}`, tip: `${left} ${String(refill['slot'])} holds the same material, so the print carries on. Keep brand and color the same.` }]
  const layer = typeof r['swapAfterLayer'] === 'number' && typeof r['layerCount'] === 'number' && r['swapAfterLayer'] > 0 ? ` Swap spools around layer ${r['swapAfterLayer']} of ${r['layerCount']}, or load a fuller spool.` : ' Load a fuller spool.'
  if (r['status'] === 'warn') return [{ text: `${slot} is just enough, with little to spare`, tip: `${left} Keep an eye on it near the end.` }]
  return [{ text: `${slot} runs out before the print ends`, tip: `${left}${layer}` }]
}

/** Printer findings that matter for this print: only the slots it uses, and only the ones that can spoil it. */
export function configNotes(output: unknown, usedSlots: readonly string[]): SheetNote[] {
  const findings = (Array.isArray(rec(output)['findings']) ? rec(output)['findings'] : []) as Rec[]
  const out: SheetNote[] = []
  for (const f of findings) {
    const text = typeof f['finding'] === 'string' ? f['finding'] : ''
    if (f['severity'] !== 'warn' && f['severity'] !== 'bad') continue
    const m = /^(\S+) holds (.+?)(?:,| in the AMS)/.exec(text)
    if (!m || !usedSlots.includes(m[1]!)) continue
    const [, slot, mat] = m
    if (/abrasive/.test(text)) out.push({ text: `${mat} in ${slot} wears out the stock nozzle`, tip: text })
    else if (/not compatible with the AMS/.test(text)) out.push({ text: `${mat} in ${slot} should not feed through the AMS`, tip: text })
    else if (/hotend stops at/.test(text)) out.push({ text: `${mat} in ${slot} needs more heat than this hotend gives`, tip: text })
  }
  return out
}

/**
 * The send sheet's checks, run as plain functions: the G-code lint, the printer against what the knowledge base
 * knows about its model, and whether the loaded spool lasts for the sliced plate. Each comes back as one short
 * line, only when it matters, with the detail in a tooltip. Warnings only; a check that could not run adds nothing.
 */
export async function sendWarnings(input: { data: ArrayBuffer; printers: PrinterHost; printerId: string; result: SliceResult; material?: string; slots?: readonly string[]; maxFlowMm3s?: number }): Promise<SheetNote[]> {
  const { data, printers, printerId, result, material } = input
  const text = data.byteLength > 0 && data.byteLength <= MAX_BYTES ? new TextDecoder().decode(data) : undefined
  const { preflight } = await import('@slicerx/pilot/functions')
  const shared: NonNullable<import('@slicerx/pilot/functions').FunctionEnv['shared']> = { slices: new Map(), machineRates: new Map() }
  shared.slices.set(1, { plate: 1, result, data })
  const r = await preflight({ printerId, plate: 1, ...(text !== undefined && (text.startsWith(';') || /^[GMT]\d/m.test(text.slice(0, 4096))) ? { gcode: text } : {}), ...(material ? { material } : {}), ...(input.maxFlowMm3s !== undefined ? { maxFlowMm3s: input.maxFlowMm3s } : {}) }, { host: { printers }, shared })
  const out: SheetNote[] = []
  if (result.stats.timeS >= OVERNIGHT_S) out.push(...(await overnightWarnings({ printers, printerId, shared, material })))
  for (const c of r.checks) {
    if (!c.result.ok) continue
    if (c.name === 'gcode_inspect') out.push(...gcodeNotes(c.result.output))
    else if (c.name === 'spool_fit') out.push(...spoolNotes(c.result.output))
    else out.push(...configNotes(c.result.output, input.slots ?? []))
  }
  const seen = new Set<string>()
  return out.filter((n) => !seen.has(n.text) && Boolean(seen.add(n.text)))
}

const LONG: Record<string, string> = { Camera: 'No camera to watch this long print', 'Runout sensor': 'No runout sensor for this long print', 'Failure detection': 'No failure detection for this long print' }

/** The overnight readiness findings that need a look. The printer state, spool, hotend and enclosure are already checked by the send sheet and the preflight, so only what is specific to a long unattended run is kept, and only when it is known. */
async function overnightWarnings(input: { printers: PrinterHost; printerId: string; shared: import('@slicerx/pilot/functions').FunctionEnv['shared']; material: string | undefined }): Promise<SheetNote[]> {
  const { runAppFunction } = await import('@slicerx/pilot/functions')
  const r = await runAppFunction('overnight_readiness', { printerId: input.printerId, plate: 1, ...(input.material ? { material: input.material } : {}) }, { host: { printers: input.printers }, ...(input.shared ? { shared: input.shared } : {}) })
  if (!r.ok) return []
  const rows = (r.display ?? []).flatMap((d) => (d.kind === 'table' ? d.rows : []))
  const out: SheetNote[] = []
  for (const row of rows) {
    const [check, level, detail] = row.map((c) => (typeof c === 'string' ? c : c.text))
    if (!check || !LONG[check] || /unknown|not in the knowledge base/.test(detail ?? '')) continue
    if (level === 'fail' || (level === 'warn' && check === 'Camera')) out.push({ text: LONG[check]!, ...(detail ? { tip: `${detail.charAt(0).toUpperCase()}${detail.slice(1)}.` } : {}) })
  }
  return out
}
