// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What the setup side panel needs from mimir. Every change it suggests comes back as a
// proposal that the person applies or dismisses on a card; nothing applies by itself. Proposals
// never carry secrets and never press Test on their own.
//
// `createGuidePilot` answers from the setup help topics and the printer catalog, with no model and
// nothing sent anywhere. With a model connection, the printer_setup skill in @slicerx/pilot drives
// the same cards (tool results fill fields, approval requests become proposals).
import { LOOK_IDS, LOOK_OPTIONS, type LookId } from '@slicerx/contracts'
import type { ConnectionId } from '@slicerx/printer-catalog'
import { FAILURE_HELP, TOPICS, type TestCause } from './help-topics'
import { searchSetup, tileForModel, type NozzleType } from './printer-form'

export type Proposal =
  | { id: string; kind: 'set-look'; look: LookId; title: string }
  | { id: string; kind: 'set-model'; brand: string; modelId: string; title: string }
  | { id: string; kind: 'set-nozzle'; size: number; type: NozzleType; unsure: boolean; title: string }
  | { id: string; kind: 'set-connection'; connection: ConnectionId; title: string }
  | { id: string; kind: 'scan'; range: string; title: string }
  | { id: string; kind: 'test'; title: string }
  /** A request from the model-backed skill; Apply resolves it with the approval broker. */
  | { id: string; kind: 'approval'; requestId: string; title: string; lines: string[] }

export interface PilotReply {
  text: string
  /** The help topic the answer used, cited under it. */
  topicId?: string
  unsure?: boolean
  proposals: Proposal[]
}

/** `guide`: answers from the setup guide only. The others are the states of a model connection. */
export type PilotStatus = 'ready' | 'guide' | 'no-model' | 'offline' | 'rate-limited'

export interface PilotQuestion {
  step: 'look' | 'printer'
  text: string
  /** Non-secret form values (printer-form formView). */
  form: Record<string, string>
  /** The last test result, for "why did the test fail". */
  lastTest?: { ok: boolean; cause?: TestCause } | null
  /** Where the person was when they asked, for context. */
  topicId?: string
  /** True when the connection fields pass validation, so a test proposal makes sense. */
  canTest?: boolean
  scanRange?: string
}

export interface OnboardingPilot {
  status(): PilotStatus
  /** Resolves with the whole reply; `onUpdate` streams it as it grows. */
  ask(q: PilotQuestion, signal?: AbortSignal, onUpdate?: (partial: PilotReply) => void): Promise<PilotReply>
  /** Answers a card the pilot itself is waiting on (`approval`). Other cards are applied by the screen. */
  resolve?(proposal: Proposal, apply: boolean): Promise<void>
}

export const STARTERS: Readonly<Record<'look' | 'printer', readonly string[]>> = {
  look: ['Which style is closest to my current slicer?', 'What changes between the styles?', 'Can I change it later?'],
  printer: ['Find my printer on the network', 'Which nozzle do I have?', 'Why did the test fail?'],
}

let seq = 0
const pid = () => `p${++seq}`

const SLICERS: readonly [RegExp, LookId, string][] = [
  [/bambu/i, 'bambu-studio', 'Bambu Studio'],
  [/prusa/i, 'prusaslicer', 'PrusaSlicer'],
  [/orca/i, 'orcaslicer', 'OrcaSlicer'],
  [/\b(cura|simplify3d|ideamaker|superslicer|creality print|none|nothing|new to|first)\b/i, 'slicerx', ''],
]

function lookReply(text: string): PilotReply {
  const t = text.toLowerCase()
  for (const [re, look, name] of SLICERS) {
    if (!re.test(text)) continue
    const label = LOOK_OPTIONS[look].label
    return look === 'slicerx'
      ? { text: `${label} is the best start then. It follows Bambu Studio's flow with a calmer layout, and every control can be remapped later.`, topicId: 'look.overview', proposals: [{ id: pid(), kind: 'set-look', look, title: `Use ${label}` }] }
      : { text: `${label} follows ${name}'s mouse and layout conventions, so your hands already know it. It changes controls and layout only, never your settings.`, topicId: 'look.overview', proposals: [{ id: pid(), kind: 'set-look', look, title: `Use ${label}` }] }
  }
  if (/later|change it|undo|switch back/.test(t)) return { text: TOPICS['look.later']!.body, topicId: 'look.later', proposals: [] }
  if (/change|differ|compare|between/.test(t)) {
    const lines = LOOK_IDS.map((id) => `${LOOK_OPTIONS[id].label}: ${LOOK_OPTIONS[id].summary}`)
    return { text: `The styles differ in mouse buttons, shortcuts and where panels sit.\n${lines.join('\n')}`, topicId: 'look.overview', proposals: [] }
  }
  if (/mouse|button|zoom|pan|rotate|camera/.test(t)) return { text: TOPICS['look.controls']!.body, topicId: 'look.controls', proposals: [] }
  if (/closest|which|current|use now|recommend/.test(t)) return { text: 'Which slicer do you use now: Bambu Studio, PrusaSlicer, OrcaSlicer, or something else? I will pick the matching style.', topicId: 'look.overview', proposals: [] }
  return { text: 'I am not sure what you mean. I can match a style to the slicer you use now, or explain what the styles change.', unsure: true, proposals: [] }
}

const SIZE_RE = /\b(0\.[2468])\s*(mm)?\b/

function printerReply(q: PilotQuestion): PilotReply {
  const t = q.text.toLowerCase()
  if (/access code|api key|password|secret|token/.test(t)) {
    return { text: `${TOPICS['printer.secret']!.body} Type it into the field on the form yourself; I never ask for it here.`, topicId: 'printer.secret', proposals: [] }
  }
  if (/fail|why|error|did not|didn't|wrong/.test(t) && /test|connect|fail/.test(t)) {
    const last = q.lastTest
    if (!last) return { text: 'There is no test result yet. Fill in the connection fields, then test. I will read the result with you.', topicId: 'printer.test', proposals: [] }
    if (last.ok) return { text: 'The last test passed. The printer answered and reported its temperatures.', topicId: 'printer.test', proposals: [] }
    const h = FAILURE_HELP[last.cause ?? 'unreachable']
    return {
      text: `${h.title}. ${h.cause} ${h.action}`,
      topicId: 'printer.test',
      proposals: q.canTest ? [{ id: pid(), kind: 'test', title: 'Test the connection again' }] : [],
    }
  }
  if (/find|scan|network|discover|search for/.test(t) && !/nozzle/.test(t)) {
    const range = q.scanRange ?? 'your local network'
    return { text: `I can look for printers on ${range}. The scan only listens for printers that announce themselves and lists them; it connects to nothing.`, topicId: 'printer.connection', proposals: [{ id: pid(), kind: 'scan', range, title: `Scan ${range} for printers` }] }
  }
  if (/nozzle|diameter|hardened|brass|carbon|glow/.test(t)) {
    const size = Number(SIZE_RE.exec(t)?.[1] ?? '')
    const hardened = /hardened|carbon|glow|abrasive/.test(t)
    if (size) {
      const type: NozzleType = hardened ? 'hardened-steel' : 'brass'
      return { text: hardened ? 'Hardened steel is required for carbon fiber and glow filaments.' : `A ${size} mm nozzle it is.`, topicId: 'printer.nozzle-type', proposals: [{ id: pid(), kind: 'set-nozzle', size, type, unsure: false, title: `Set nozzle to ${size} mm ${type === 'brass' ? 'brass' : 'hardened steel'}` }] }
    }
    return {
      text: `${TOPICS['printer.nozzle']!.body} If you cannot see it, I can set 0.4 mm brass and mark it for checking later.`,
      topicId: 'printer.nozzle',
      proposals: [{ id: pid(), kind: 'set-nozzle', size: 0.4, type: hardened ? 'hardened-steel' : 'brass', unsure: true, title: 'Set nozzle to 0.4 mm brass, to confirm later' }],
    }
  }
  const { models } = searchSetup(q.text.replace(/\b(i have|my|a|an|the|printer|it is|its|it's)\b/gi, ' '))
  if (models.length > 0 && models.length <= 3) {
    return {
      text: models.length === 1 ? `That sounds like the ${models[0]!.name}.` : 'That could be one of these. Pick the one on your printer\'s label.',
      topicId: 'printer.model',
      proposals: models.map((m) => ({ id: pid(), kind: 'set-model' as const, brand: tileForModel(m)?.id ?? 'other', modelId: m.id, title: `Set printer to ${tileForModel(m)?.name ?? ''} ${m.name}`.replace(/\s+/g, ' ') })),
    }
  }
  if (/model|label|which printer/.test(t)) return { text: TOPICS['printer.model']!.body, topicId: 'printer.model', proposals: [] }
  if (/firmware|klipper|marlin/.test(t)) return { text: TOPICS['printer.firmware']!.body, topicId: 'printer.firmware', proposals: [] }
  return { text: 'I am not sure. Tell me the brand and model on the printer\'s label, or ask about the nozzle or the connection.', unsure: true, proposals: [] }
}

/** Answers from the setup guide and the catalog. Nothing leaves the machine. */
export function createGuidePilot(opts: { delayMs?: number } = {}): OnboardingPilot {
  const delay = opts.delayMs ?? 250
  return {
    status: () => 'guide',
    async ask(q, signal) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, delay)
        signal?.addEventListener('abort', () => {
          clearTimeout(t)
          reject(new DOMException('Canceled', 'AbortError'))
        }, { once: true })
      })
      return q.step === 'look' ? lookReply(q.text) : printerReply(q)
    },
  }
}
