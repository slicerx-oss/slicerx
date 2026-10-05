// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The words on an approval card for work an agent asked for. The title and lines of such a request
// are written by the requester (mimir, an MCP client), so the phone does not show them. It builds
// the card from what the computer's hub checked: the actions the approval unlocks, each with its
// printer and a hash of the exact parameters (file name and content hash included). The person sees
// what will happen and to which printer, and can match the fingerprint against the computer.
import type { ApprovalAction, ApprovalRequest, SideEffectAction } from '@slicerx/contracts'

const VERB: Record<SideEffectAction, string> = {
  'printer.upload': 'Send a file to',
  'printer.start': 'Start a print on',
  'printer.pause': 'Pause the print on',
  'printer.resume': 'Resume the print on',
  'printer.cancel': 'Stop the print on',
  'printer.gcode': 'Run a G-code line on',
  'printer.adjust': 'Change the running print on',
  'printer.config': 'Change settings on',
  'plugin.call': 'Run a tool of',
  'profile.write': 'Change the saved profile',
  'project.replace': 'Replace objects in project',
  'share.notify': 'Send a notification through',
  'share.publish': 'Publish a report to',
}

/** Most important first: the question names the action that does the most. */
const ORDER: SideEffectAction[] = ['printer.start', 'printer.cancel', 'printer.gcode', 'printer.adjust', 'printer.config', 'printer.resume', 'printer.pause', 'printer.upload', 'profile.write', 'project.replace', 'plugin.call', 'share.publish', 'share.notify']

/** Requests the requester described itself. A phone's own job and a click on the computer are not. */
export function describedByRequester(r: Pick<ApprovalRequest, 'origin'>, source: 'pilot' | 'pair' | 'host'): boolean {
  if (source === 'pair') return false
  return r.origin !== 'phone' && r.origin !== 'local_click'
}

function targetName(a: ApprovalAction, names: Record<string, string>): string {
  return names[a.target] ?? a.target
}

/** `abcd1234`, the start of the hash the hub checked. */
export const fingerprint = (hash: string): string => hash.slice(0, 8)

export function verifiedCard(request: ApprovalRequest, names: Record<string, string> = {}): Pick<ApprovalRequest, 'title' | 'lines'> {
  const actions = [...request.actions].sort((a, b) => ORDER.indexOf(a.action) - ORDER.indexOf(b.action))
  const first = actions[0]
  if (!first) return { title: 'A request needs your answer', lines: ['It unlocks no action the computer could verify. Deny it unless you expected it.'] }
  const noun = (a: ApprovalAction) => `${VERB[a.action]} ${targetName(a, names)}`
  const title = `${noun(first)}?`
  const lines = actions.map((a) => `${noun(a)}. Request fingerprint ${fingerprint(a.paramsHash)}`)
  if (request.title || request.lines.length > 0) lines.push("The requester's own description is not shown. Check the fingerprint on your computer")
  return { title, lines }
}

/** The request as the phone shows it. */
export function forDisplay(request: ApprovalRequest, source: 'pilot' | 'pair' | 'host', names: Record<string, string> = {}): ApprovalRequest {
  return describedByRequester(request, source) ? { ...request, ...verifiedCard(request, names) } : request
}

/** Said on a card the phone may not approve over the relay. */
export const AT_HOME = 'Approve this at home or in SlicerX. Over the internet this phone can only approve pausing or stopping a print'

/**
 * Over the relay the phone answers only pause and stop cards. Starts, resume, G-code and changes to a
 * running print are approvable from the phone on the home network only, so the card offers no Approve.
 * Deny always works.
 */
export function relayBlock(request: Pick<ApprovalRequest, 'actions'>, via: 'lan' | 'relay'): string | undefined {
  if (via !== 'relay') return undefined
  const ok = request.actions.length > 0 && request.actions.every((a) => a.action === 'printer.pause' || a.action === 'printer.cancel')
  return ok ? undefined : AT_HOME
}
