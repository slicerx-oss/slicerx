// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The hub's own summary of agent work (`request.work`): the file name, size and hash, the printer, the
// G-code line or the adjustment. The words come from what the hub will run, and the phone checks that
// the hashes of the card's actions are the hashes of exactly this work before it offers Approve. A card
// whose actions do not match its summary shows a warning and no Approve.
import { hashParams, type ApprovalRequest } from '@slicerx/contracts'

type Work =
  | { kind: 'print'; printerId: string; file: { name: string; sizeBytes: number; sha256: string }; opts?: Record<string, unknown> }
  | { kind: 'resume' | 'pause' | 'cancel'; printerId: string }
  | { kind: 'gcode'; printerId: string; line: string }
  | { kind: 'adjust'; printerId: string; change: unknown }

export const MISMATCH = 'This request does not match what your computer checked. Do not approve it'

/** The hub refuses longer G-code lines (`MAX_GCODE_LINE` in sx-connect), so the card shows a line whole. */
export const GCODE_LINE_MAX = 96
/** One G-code command a card can show whole: printable ASCII, no line breaks, at most 96 characters. */
export const plainGcodeLine = (line: string) => line.trim().length > 0 && line.length <= GCODE_LINE_MAX && /^[\x20-\x7e]+$/.test(line)

const obj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The summary as the hub sent it, or null when absent or not in a shape this phone knows. */
export function readWork(request: ApprovalRequest): Work | null | 'unknown' {
  const raw = (request as { work?: unknown }).work
  if (raw === undefined || raw === null) return null
  if (!obj(raw) || typeof raw['printerId'] !== 'string') return 'unknown'
  const printerId = raw['printerId']
  switch (raw['kind']) {
    case 'print': {
      const f = raw['file']
      if (!obj(f) || typeof f['name'] !== 'string' || typeof f['sha256'] !== 'string' || typeof f['sizeBytes'] !== 'number') return 'unknown'
      const opts = obj(raw['opts']) ? raw['opts'] : undefined
      return { kind: 'print', printerId, file: { name: f['name'], sizeBytes: f['sizeBytes'], sha256: f['sha256'] }, ...(opts ? { opts } : {}) }
    }
    case 'resume':
    case 'pause':
    case 'cancel':
      return { kind: raw['kind'], printerId }
    case 'gcode':
      // A line this card cannot show whole (a break, a control character, over 96 characters) could hide
      // a second command after a long first one: such a card gets no Approve.
      return typeof raw['line'] === 'string' && plainGcodeLine(raw['line']) ? { kind: 'gcode', printerId, line: raw['line'] } : 'unknown'
    case 'adjust':
      return { kind: 'adjust', printerId, change: raw['change'] }
    default:
      return 'unknown'
  }
}

/** The actions the card must carry for this work, in order, with their hashes. */
async function expected(w: Work): Promise<{ action: string; target: string; paramsHash: string }[]> {
  const t = w.printerId
  switch (w.kind) {
    case 'print':
      return [
        { action: 'printer.upload', target: t, paramsHash: await hashParams({ printerId: t, name: w.file.name, sha256: w.file.sha256 }) },
        { action: 'printer.start', target: t, paramsHash: await hashParams({ printerId: t, name: w.file.name, opts: w.opts ?? {}, sha256: w.file.sha256 }) },
      ]
    case 'resume':
    case 'pause':
    case 'cancel':
      return [{ action: `printer.${w.kind}`, target: t, paramsHash: await hashParams({ printerId: t }) }]
    case 'gcode':
      return [{ action: 'printer.gcode', target: t, paramsHash: await hashParams({ printerId: t, line: w.line }) }]
    case 'adjust':
      return [{ action: 'printer.adjust', target: t, paramsHash: await hashParams({ printerId: t, change: w.change }) }]
  }
}

/** `code` is a G-code line to show whole, in a monospace font. */
export type WorkCheck = { state: 'none' } | { state: 'verified'; title: string; lines: string[]; code?: string } | { state: 'mismatch' }

const tidy = (s: string, max = 90) => {
  // eslint-disable-next-line no-control-regex
  const clean = s.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}...` : clean
}

function size(bytes: number): string {
  return bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/** Checks a request's work summary against its action hashes and words the card from it. */
export async function checkWork(request: ApprovalRequest, printerName: (id: string) => string): Promise<WorkCheck> {
  const w = readWork(request)
  if (w === null) return { state: 'none' }
  if (w === 'unknown') return { state: 'mismatch' }
  const want = await expected(w)
  const got = request.actions
  const same = want.length === got.length && want.every((e, i) => got[i] && got[i].action === e.action && got[i].target === e.target && got[i].paramsHash === e.paramsHash)
  if (!same || (request.printerId !== undefined && request.printerId !== w.printerId)) return { state: 'mismatch' }
  const on = printerName(w.printerId)
  switch (w.kind) {
    case 'print': {
      const opts = Object.entries(w.opts ?? {}).map(([k, v]) => `${k}: ${tidy(String(v), 40)}`)
      return {
        state: 'verified',
        title: `Print ${tidy(w.file.name, 50)} on ${on}?`,
        lines: [`File ${tidy(w.file.name)}, ${size(w.file.sizeBytes)}`, `SHA-256 ${w.file.sha256.slice(0, 16)}`, `Printer ${on}`, ...(opts.length ? [`Options ${opts.join(', ')}`] : [])],
      }
    }
    case 'gcode':
      return { state: 'verified', title: `Send G-code to ${on}?`, lines: [`Printer ${on}`], code: w.line }
    case 'adjust':
      return { state: 'verified', title: `Change the running print on ${on}?`, lines: [`Change ${tidy(JSON.stringify(w.change), 160)}`, `Printer ${on}`] }
    case 'resume':
      return { state: 'verified', title: `Resume the print on ${on}?`, lines: [`Printer ${on}`] }
    case 'pause':
      return { state: 'verified', title: `Pause the print on ${on}?`, lines: [`Printer ${on}`] }
    case 'cancel':
      return { state: 'verified', title: `Stop the print on ${on}?`, lines: [`Printer ${on}`] }
  }
}
