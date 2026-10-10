// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Cards the hub raises for work an AI agent asked for over MCP (a print start, a resume, a G-code line).
// The person decides from what the hub itself verified: the actions it will run and the printer they
// target, plus the file name, size, hash and options when the hub sends them. The agent's own title and
// lines are never the headline: they show as one labeled note, cut short, because a misled agent could
// title a start "Pause the print?". The G-code line is shown whole: the hub refuses any line a card
// cannot show in full, and a card that still carries one gets no Approve.
import { slotMapLine, type ApprovalRequest, type ApprovalToken } from '@slicerx/contracts'
import { appStore, get, set, toast, type PendingApproval } from '../state/store'
import { appName } from '../edition'

/** The hub's own summary of the work it holds for a card, when the bridge sends one. */
export interface VerifiedWork {
  kind: 'print' | 'resume' | 'gcode' | 'adjust' | 'pause' | 'cancel'
  printerId: string
  file?: { name: string; sizeBytes?: number; sha256?: string }
  opts?: Record<string, unknown>
  line?: string
  change?: Record<string, unknown>
}

export type HubCard = ApprovalRequest & {
  work?: VerifiedWork
  /** Set by the hub on a partner app's card: the name the partner's key was made with. Never the asker's own words. */
  partner?: string
}

export interface CardText {
  title: string
  lines: string[]
  /** The card starts a print, so the person confirms the bed is clear. */
  startsPrint: boolean
  /** Why Approve stays off: the hub sent work this app will not word for a person. */
  blocked?: string
}

const NOTE_MAX = 160
/** The hub refuses longer G-code lines (`MAX_GCODE_LINE` in sx-connect), so a card always shows the line whole. */
export const GCODE_LINE_MAX = 96
/** One G-code command a card can show whole: printable ASCII, no line breaks, at most 96 characters. */
export const plainGcodeLine = (line: string) => line.trim().length > 0 && line.length <= GCODE_LINE_MAX && /^[\x20-\x7e]+$/.test(line)
/**
 * Text someone else wrote, made safe to read on a card: one line, and every control, format (bidirectional
 * overrides, zero-width marks), private-use or unassigned character shown as a replacement mark, so the text
 * cannot reorder or hide what follows it.
 */
const oneLine = (s: string) => s.replace(/\s+/g, ' ').replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cn}]/gu, '�').trim()
/**
 * The name each printer goes by on a card. Two printers whose names read the same (equal after NFKC, with
 * invisible characters dropped, spaces collapsed, trimmed and case folded) both get their id appended, so a
 * card cannot pass one printer off as another. A printer with no name shows its id.
 */
export function printerLabels(list: readonly { id: string; name: string }[]): Map<string, string> {
  const key = (n: string) => n.normalize('NFKC').replace(/[\p{Cf}]/gu, '').replace(/\s+/g, ' ').trim().toLowerCase()
  const count = new Map<string, number>()
  for (const p of list) count.set(key(p.name), (count.get(key(p.name)) ?? 0) + 1)
  return new Map(
    list.map((p) => {
      const name = oneLine(p.name)
      const id = oneLine(p.id)
      if (!key(p.name)) return [p.id, id]
      return [p.id, (count.get(key(p.name)) ?? 0) > 1 ? `${name} (${id})` : name]
    }),
  )
}

const size = (bytes: number) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`)

const FAN_WORDS: Record<string, string> = { part: 'part cooling fan', aux: 'auxiliary fan', chamber: 'chamber fan' }

/** The change in plain words, from the hub's checked summary. `null` for a change this app does not know how to word. */
export function describeChange(change: Record<string, unknown> | undefined): string | null {
  if (!change) return null
  const n = (k: string) => (typeof change[k] === 'number' && Number.isFinite(change[k]) ? (change[k] as number) : null)
  switch (change['kind']) {
    case 'nozzle':
      return n('celsius') === null ? null : `Set the nozzle to ${n('celsius')} °C`
    case 'bed':
      return n('celsius') === null ? null : `Set the bed to ${n('celsius')} °C`
    case 'speed':
      return n('percent') === null ? null : `Set the print speed to ${n('percent')}%`
    case 'fan': {
      const fan = FAN_WORDS[String(change['fan'])]
      return fan && n('percent') !== null ? `Set the ${fan} to ${n('percent')}%` : null
    }
    default:
      return null
  }
}

/**
 * The filament slot map in plain words. Keys are 0 based, as the contract has them (`StartOptions.slotMap`).
 * Every pair, never cut: the hub keeps slot ids to 32 printable characters, and a cut list could hide a slot.
 */
const slotWords = (map: unknown): string | null => (map && typeof map === 'object' ? slotMapLine(map as Record<string, unknown>, oneLine) : null)

/** The card actions each kind of hub work runs, in order (`Work::actions` in the hub). */
const WORK_ACTIONS: Record<VerifiedWork['kind'], string[]> = {
  print: ['printer.upload', 'printer.start'],
  resume: ['printer.resume'],
  gcode: ['printer.gcode'],
  adjust: ['printer.adjust'],
  pause: ['printer.pause'],
  cancel: ['printer.cancel'],
}

/** True when the hub's work is exactly what the card's actions say, on the same printer. */
const workMatches = (card: HubCard, w: VerifiedWork): boolean => {
  const want = WORK_ACTIONS[w.kind]
  return Boolean(want) && want.length === card.actions.length && card.actions.every((a, i) => a.action === want[i] && a.target === w.printerId)
}

const ACTION_WORDS: Record<string, string> = {
  'printer.upload': 'upload a file',
  'printer.start': 'start a print',
  'printer.pause': 'pause the print',
  'printer.resume': 'resume the print',
  'printer.cancel': 'cancel the print',
  'printer.gcode': 'send a G-code line',
  'printer.config': 'change the running print',
  'printer.adjust': 'change the running print',
  'plugin.call': 'call a plugin',
  'profile.write': 'change a profile',
  'project.replace': 'replace objects in the project',
  'share.notify': 'send a notification',
  'share.publish': 'publish a report',
}

/** The card as the person sees it. Everything above the note comes from the hub: its actions, their targets and its work summary. */
export function describeCard(card: HubCard, printerName: (id: string) => string = (id) => id): CardText {
  // Cards an AI agent raised (MCP) and cards a paired phone raised away from home are both described from what the hub verified.
  if (card.origin !== 'mcp' && card.origin !== 'phone') return { title: card.title, lines: card.lines, startsPrint: card.actions.some((a) => a.action === 'printer.start') }
  const has = (action: string) => card.actions.some((a) => a.action === action)
  const targetOf = (action: string) => card.actions.find((a) => a.action === action)?.target
  const printerId = targetOf('printer.start') ?? targetOf('printer.resume') ?? targetOf('printer.gcode') ?? targetOf('printer.config') ?? card.actions.find((a) => a.action.startsWith('printer.'))?.target
  const printer = printerId ? printerName(printerId) : null
  const on = printer ? ` on ${printer}` : ''
  const startsPrint = has('printer.start')
  // A partner app's card names the partner, by the name only the hub sets, and says nothing about AI.
  const partner = card.origin === 'mcp' && card.partner ? oneLine(card.partner).slice(0, 60) : ''
  const asker = card.origin === 'phone' ? 'a paired phone' : partner || 'an AI agent'
  const who = card.origin === 'phone' ? 'the phone' : partner || 'the agent'
  const title = startsPrint
    ? `Start a print${on}?`
    : has('printer.pause')
      ? `Pause the print${on}?`
      : has('printer.cancel')
        ? `Cancel the print${on}?`
    : has('printer.resume')
      ? `Resume the print${on}?`
      : has('printer.gcode')
        ? `Send a G-code line${printer ? ` to ${printer}` : ''}?`
        : has('printer.config') || has('printer.adjust')
          ? `Change the running print${on}?`
          : `Let ${asker} ${ACTION_WORDS[card.actions[0]?.action ?? ''] ?? 'act'}${on}?`
  const lines: string[] = [card.origin === 'phone' ? 'Asked by a paired phone. Only you can approve it here.' : partner ? `Asked by ${partner}, a partner app.` : 'Asked by an AI agent over MCP. It cannot approve this itself.']
  const did = [...new Set(card.actions.map((a) => ACTION_WORDS[a.action] ?? a.action))]
  lines.push(`If you approve, the hub will ${did.join(', then ')}${on}.`)
  // Every card from an agent or a phone carries the hub's work. Without it, or with work that is not exactly what the
  // actions say, the card has nothing checked to show, so it gets no Approve.
  const w = card.work && workMatches(card, card.work) ? card.work : undefined
  let blocked: string | undefined = w ? undefined : `${appName()} did not get the details the hub checked for this request, so it cannot show what would run. Deny this request.`
  if (w?.file) {
    const name = oneLine(w.file.name)
    // The name is the agent's: it is what the file is called on the printer, not a description of it.
    lines.push(`File (named by ${who}): ${name.length > 120 ? `${name.slice(0, 120)}...` : name}${w.file.sizeBytes ? `, ${size(w.file.sizeBytes)}` : ''}`)
    if (w.file.sha256) lines.push(`SHA-256: ${w.file.sha256.slice(0, 16)}`)
  }
  // The whole line, never cut: a cut line could hide a second command after a long first one.
  if (w?.line !== undefined) {
    if (plainGcodeLine(w.line)) lines.push(`G-code: ${w.line}`)
    else blocked = 'The G-code is not one short line, so it cannot be shown in full. Deny this request.'
  }
  if (has('printer.adjust')) {
    // The change is what the hub runs; a card that cannot word it gets no Approve.
    const said = describeChange(w?.change)
    if (said) lines.push(`Change: ${said}${on}`)
    else blocked ??= `${appName()} cannot show this change in plain words. Deny this request.`
  }
  const options = Object.entries(w?.opts ?? {}).filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v))
  // The hub's options are a fixed set of numbers and switches, so the whole list is short; it is never cut.
  if (options.length) lines.push(`Options: ${options.map(([k, v]) => `${oneLine(k)} ${oneLine(String(v))}`).join(', ')}`)
  // Every start option the hub holds is on the card: slot ids decide which filament goes where.
  const slots = slotWords(w?.opts?.['slotMap'])
  if (slots) lines.push(slots)
  const said = oneLine(card.title)
  if (said) lines.push(`Note from ${who}, not checked by ${appName()}: "${said.length > NOTE_MAX ? `${said.slice(0, NOTE_MAX)}...` : said}"`)
  return { title, lines, startsPrint, ...(blocked ? { blocked } : {}) }
}

/** The part of the bridge's approval broker the card screen uses. */
export interface HubCards {
  onRequest(cb: (r: ApprovalRequest) => void): () => void
  pending?(): Promise<ApprovalRequest[]>
  grantWith(requestId: string, opts: { bedClear: boolean }): Promise<ApprovalToken | { queued: true }>
  deny(requestId: string, reason?: string): Promise<unknown>
}

export const BED_CLEAR = 'The build plate is clear'

/**
 * Shows the hub's cards in the approval dialog, one at a time, oldest first. Approve and Deny are the only
 * ways a card is answered. Returns a function that stops listening and drops the cards not yet shown.
 */
export function watchHubCards(cards: HubCards, printerName: (id: string) => string = (id) => id, refreshNames?: () => Promise<unknown>): () => void {
  let queue: HubCard[] = []
  let showing: string | null = null
  const seen = new Set<string>()
  const next = () => {
    if (showing || get().approval) return
    const card = queue.shift()
    if (!card) return
    if (Date.parse(card.expiresAt) <= Date.now()) return next()
    const text = describeCard(card, printerName)
    showing = card.id
    const done = () => {
      showing = null
      set({ approval: null })
    }
    const pending: PendingApproval = {
      requests: [{ ...card, title: text.title, lines: text.lines }],
      ...(text.blocked ? { checks: { errors: [text.blocked], warnings: [] } } : {}),
      ...(text.startsPrint ? { confirm: BED_CLEAR, go: 'Bed is clear, approve' } : {}),
      approve: async () => {
        done()
        // The approve button of a start says the bed is clear, so pressing it carries that answer.
        await cards.grantWith(card.id, { bedClear: text.startsPrint }).then(
          () => toast('Approved. The hub is running it now.', 'ok'),
          (e: unknown) => toast(e instanceof Error ? e.message : String(e), 'error'),
        )
      },
      deny: async () => {
        done()
        await cards.deny(card.id, 'Denied in the approval dialog').catch(() => undefined)
      },
    }
    set({ approval: pending })
  }
  const add = (r: ApprovalRequest) => {
    if (seen.has(r.id)) return
    seen.add(r.id)
    const go = () => {
      queue.push(r as HubCard)
      next()
    }
    // Printer names are read again for every card, so a rename since the app connected shows.
    if (refreshNames) void refreshNames().then(go, go)
    else go()
  }
  const offRequest = cards.onRequest(add)
  // Cards raised before this app connected are waiting on the hub.
  void cards.pending?.().then((list) => list.filter((r) => r.origin === 'mcp' || r.origin === 'phone' || r.origin === 'queue' || r.origin === 'schedule').forEach(add), () => undefined)
  // When any approval closes, the next card takes its place.
  const offStore = appStore.subscribe((now, was) => {
    if (was.approval && !now.approval) {
      showing = null
      next()
    }
  })
  return () => {
    offRequest()
    offStore()
    queue = []
    if (showing) set({ approval: null })
    showing = null
  }
}
