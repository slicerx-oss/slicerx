// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A stand-in model for builds without an LLM provider: it recognizes the four
// showcase requests and drives the real runtime, tools, printers and approval
// gate with them. Steps read earlier tool results, so what it says matches the
// printers it actually sees. Anything else gets a short explanation.
import type { LlmClient, LlmEvent, LlmMessage, LlmRequest } from './provider/types'
import type { ScriptStep, ScriptStepData } from './provider/scripted'

type Rec = Record<string, unknown>
const obj = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {})

/** Tool results so far in this turn, by tool name, newest last. */
function results(messages: LlmMessage[]): Map<string, unknown[]> {
  const byId = new Map<string, string>()
  for (const m of messages) if (m.role === 'assistant') for (const c of m.toolCalls ?? []) byId.set(c.id, c.name)
  const out = new Map<string, unknown[]>()
  for (const m of messages) {
    if (m.role !== 'tool') continue
    const name = byId.get(m.callId)
    if (!name) continue
    let body: unknown
    try {
      body = JSON.parse(m.content)
    } catch {
      continue
    }
    const r = obj(body)['result']
    const data = obj(r)['untrusted'] === true ? obj(r)['data'] : r
    out.set(name, [...(out.get(name) ?? []), data])
  }
  return out
}

const last = (m: Map<string, unknown[]>, name: string): unknown => m.get(name)?.at(-1)

/** True when the newest call of a tool succeeded, so the reply may cite what it returned. */
function found(messages: LlmMessage[], name: string): boolean {
  const ids = new Set<string>()
  for (const m of messages) if (m.role === 'assistant') for (const c of m.toolCalls ?? []) if (c.name === name) ids.add(c.id)
  const reply = messages.findLast((m) => m.role === 'tool' && ids.has(m.callId))
  if (reply?.role !== 'tool') return false
  try {
    return obj(JSON.parse(reply.content))['ok'] === true
  } catch {
    return false
  }
}

interface PrinterRow {
  id: string
  name: string
  model: string
  state: string
  materials: string[]
}

function printers(m: Map<string, unknown[]>): PrinterRow[] {
  const list = last(m, 'printer.list')
  if (!Array.isArray(list)) return []
  return list.map((p) => {
    const r = obj(p)
    const st = obj(r['status'])
    const slots = Array.isArray(st['slots']) ? st['slots'].map(obj) : []
    return { id: String(r['id']), name: String(r['name']), model: String(r['model']), state: String(st['state'] ?? 'offline'), materials: slots.map((s) => String(s['material'] ?? '')).filter(Boolean) }
  })
}

const free = (p: PrinterRow): boolean => p.state === 'idle' || p.state === 'finished'
const listText = (xs: string[]): string => (xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1) ?? ''}`)

const BATCH: ScriptStep[] = [
  { reasoning: 'Friday leaves time, so cost and strength decide. Turn the request into settings first, then see which printers are free and what they have loaded.', calls: [{ name: 'kb.intent', args: { text: 'Print 12 strong PETG brackets by Friday, cheapest printers first.' } }] },
  { calls: [{ name: 'printer.list', args: {} }, { name: 'spoolman.list_spools', args: { material: 'PETG' } }] },
  (msgs): ScriptStepData => {
    const ps = printers(results(msgs))
    const freeOnes = ps.filter(free)
    const petg = freeOnes.filter((p) => p.materials.some((x) => /petg/i.test(x)))
    const busy = ps.filter((p) => !free(p)).map((p) => `${p.name} is ${p.state}`)
    const pick = petg.length ? petg : freeOnes
    const text = `${pick.length ? `${listText(pick.map((p) => `${p.name} (${p.model})`))} ${pick.length === 1 ? 'is' : 'are'} free${petg.length ? ' with PETG loaded' : ''}.` : 'No printer is free right now.'} ${busy.length ? `${listText(busy)}.` : ''}${petg.length ? '' : ' None of the free printers has PETG loaded, so load a PETG spool before the plates start.'} Applying the strength settings to this plate:`
    return { text, calls: [{ name: 'settings.apply', args: { target: 'plate', changes: { wall_loops: 4, sparse_infill_density: 25, sparse_infill_pattern: 'gyroid', top_shell_layers: 5, bottom_shell_layers: 4, nozzle_temperature: 255, fan_max_speed: 30 }, reason: 'Strength overrides for PETG brackets. The saved profile is unchanged.' } }] }
  },
  { calls: [{ name: 'orient', args: { minSupports: true } }] },
  (msgs): ScriptStepData => {
    const ps = printers(results(msgs)).filter(free)
    const petg = ps.filter((p) => p.materials.some((x) => /petg/i.test(x)))
    const use = (petg.length ? petg : ps).slice(0, 2).map((p) => p.id)
    return { calls: [{ name: 'arrange', args: use.length ? { count: 12, printers: use, spacing: 6 } : { count: 12, plates: 2, spacing: 6 } }] }
  },
  { calls: [{ name: 'slice', args: { profile: '0.20 Standard' } }] },
  (msgs): ScriptStepData => {
    const deadline = obj(obj(last(results(msgs), 'kb.intent'))['deadline'])['date']
    return { calls: [{ name: 'estimate', args: typeof deadline === 'string' ? { deadline } : {} }] }
  },
  (msgs): ScriptStepData => {
    const arranged = obj(last(results(msgs), 'arrange'))
    const plates = Array.isArray(arranged['plates']) ? arranged['plates'].map(obj) : []
    const first = plates.find((p) => typeof p['printerId'] === 'string')
    return first ? { calls: [{ name: 'printer.queue', args: { printerId: String(first['printerId']), plate: Number(first['plate']) } }] } : { text: 'The plates are sliced. Assign them to printers to send them.' }
  },
  (msgs): ScriptStepData => {
    const arranged = obj(last(results(msgs), 'arrange'))
    const plates = Array.isArray(arranged['plates']) ? arranged['plates'].map(obj) : []
    const second = plates.filter((p) => typeof p['printerId'] === 'string')[1]
    return second ? { calls: [{ name: 'printer.queue', args: { printerId: String(second['printerId']), plate: Number(second['plate']) } }] } : {}
  },
  (msgs): ScriptStepData => {
    const est = obj(last(results(msgs), 'estimate'))
    const queued = (results(msgs).get('printer.queue') ?? []).map(obj).filter((q) => q['printerId'])
    const rows: [string, string][] = [
      ['Printers', queued.length ? queued.map((q) => String(q['printerId'])).join(', ') : 'none yet'],
      ['Settings', '4 walls, 25% gyroid, 255 C'],
    ]
    if (typeof est['grams'] === 'number') rows.push(['Filament', `${est['grams']} g PETG`])
    if (typeof est['wallClockS'] === 'number') rows.push(['Wall clock', `${Math.round(Number(est['wallClockS']) / 60)} min`])
    return { calls: [{ name: 'pilot.report', args: { title: `12 PETG brackets on ${queued.length || 'no'} printer${queued.length === 1 ? '' : 's'}`, rows } }] }
  },
  { text: 'Done. **The plates finish well before Friday.**' },
]

const DIAGNOSE: ScriptStep[] = [
  { calls: [{ name: 'printer.list', args: {} }] },
  (msgs): ScriptStepData => {
    const ps = printers(results(msgs))
    const target = ps.find((p) => p.state === 'paused' || p.state === 'error') ?? ps[0]
    return { reasoning: 'Start from the printer that stopped, then match the symptom against the layer shift guide.', calls: target ? [{ name: 'diagnose', args: { printerId: target.id, symptom: 'layer shift, top half offset sideways' } }] : [] }
  },
  { calls: [{ name: 'kb.troubleshoot', args: { symptom: 'layer shift' } }] },
  (msgs): ScriptStepData => ({
    text: `A single sharp step at one height points first at a nozzle strike or a belt skipping on a fast move. **Check the belts and look for a curled corner at the shift height before resuming.** If the belts are sound, lower acceleration${found(msgs, 'kb.troubleshoot') ? ', per the layer shift guide' : ''}.`,
  }),
]

const FIT: ScriptStep[] = [
  { calls: [{ name: 'arrange', args: { checkFit: true, printerModel: 'A1 mini' } }] },
  { reasoning: 'Compare scaling with a split before cutting anything.', calls: [{ name: 'cut', args: { printerModel: 'A1 mini', mode: 'compare' } }] },
  (msgs): ScriptStepData => {
    const cut = obj(last(results(msgs), 'cut'))
    if (cut['fits'] === true) return { text: 'It already fits the A1 mini as it is.' }
    const split = obj(cut['split'])
    return { text: 'Splitting keeps full size and puts the seam in one place. Cutting with a dovetail.', calls: [{ name: 'cut', args: { printerModel: 'A1 mini', mode: 'split', planeZ: Number(split['planeZ'] ?? 90), connector: 'dovetail' } }] }
  },
  { text: 'The model is now in parts that each fit the A1 mini. Nothing was sent to a printer.' },
]

const TUNE: ScriptStep[] = [
  { calls: [{ name: 'spoolman.list_spools', args: { material: 'PETG' } }, { name: 'kb.filament', args: { material: 'PETG' } }] },
  { reasoning: 'A new spool has no history. A temperature tower in 5 C steps, then a flow test.', calls: [{ name: 'calibrate', args: { material: 'petg', tests: ['temp-tower', 'flow'] } }] },
  (msgs): ScriptStepData => ({
    text: `Print the temperature tower and the flow test on one plate, then tell me the best block and I will write the profile.${found(msgs, 'kb.filament') ? ' Per the PETG entry, start at 240 to 245 C.' : ''}`,
  }),
]

const DEMOS: { keys: string[]; steps: ScriptStep[] }[] = [
  { keys: ['bracket', 'keychain', 'friday', 'cheapest', 'batch', 'queue', '12 '], steps: BATCH },
  { keys: ['fail', 'shift', 'why', 'diagnose', 'belt'], steps: DIAGNOSE },
  { keys: ['a1 mini', 'fit', 'split', 'cut', 'too big', 'too tall'], steps: FIT },
  { keys: ['tune', 'spool', 'calibrat', 'tower', 'flow'], steps: TUNE },
]

function pick(text: string): ScriptStep[] | null {
  const t = ` ${text.toLowerCase()} `
  let best: ScriptStep[] | null = null
  let score = 0
  for (const d of DEMOS) {
    const s = d.keys.reduce((a, k) => a + (t.includes(k) ? 1 : 0), 0)
    if (s > score) {
      score = s
      best = d.steps
    }
  }
  return best
}

const pause = (ms: number): Promise<void> => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve())

/**
 * The demo model. `delayMs` paces streaming per word and `callDelayMs` before
 * each tool call, so the surface streams the way a model does.
 */
export function createDemoClient(opts: { delayMs?: number; callDelayMs?: number } = {}): LlmClient {
  const d = opts.delayMs ?? 28
  let active: { steps: ScriptStep[]; i: number; turn: number } | null = null
  return {
    provider: 'demo',
    async *stream(req: LlmRequest): AsyncIterable<LlmEvent> {
      const users = req.messages.filter((m) => m.role === 'user')
      const turn = users.length
      const lastUser = users.at(-1)?.content ?? ''
      if (req.webSearch) {
        yield { type: 'text', delta: 'Web lookups need a model provider.' }
        yield { type: 'done', stop: 'end' }
        return
      }
      // A request ending in the user's message starts a run; one ending in tool results continues it.
      // The turn count alone repeats in a new conversation, which would resume a finished run.
      if (!active || req.messages.at(-1)?.role === 'user') {
        const steps = pick(lastUser.split('User request:').at(-1) ?? lastUser)
        active = steps ? { steps, i: 0, turn } : null
      }
      const say = async function* (text: string): AsyncIterable<LlmEvent> {
        for (const w of text.match(/\s*\S+/g) ?? [text]) {
          await pause(d)
          yield { type: 'text', delta: w }
        }
      }
      if (req.toolChoice === 'none') {
        yield* say('Stopped. Nothing was sent to a printer and no profile was changed.')
        yield { type: 'done', stop: 'end' }
        return
      }
      if (!active) {
        yield* say('No model provider is set up in this build, so mimir can only replay its showcase runs: a batch of 12 strong PETG brackets, diagnosing a layer shift, fitting a model on an A1 mini and tuning a new PETG spool. Pick one from the suggestions.')
        yield { type: 'done', stop: 'end' }
        return
      }
      const raw = active.steps[active.i++]
      if (!raw) {
        yield { type: 'done', stop: 'end' }
        return
      }
      const step = typeof raw === 'function' ? raw(req.messages) : raw
      if (step.reasoning) {
        for (const w of step.reasoning.match(/\s*\S+/g) ?? []) {
          await pause(d / 2)
          yield { type: 'reasoning', delta: w }
        }
      }
      if (step.text) yield* say(step.text)
      let n = 0
      for (const c of step.calls ?? []) {
        await pause(opts.callDelayMs ?? 350)
        yield { type: 'tool_call', call: { id: `demo_${turn}_${active.i}_${n++}`, name: c.name, arguments: JSON.stringify(c.args) } }
      }
      yield { type: 'usage', inputTokens: 1200, outputTokens: 60 + (step.text?.length ?? 0) / 4 }
      yield { type: 'done', stop: step.calls?.length ? 'tool_calls' : 'end' }
    },
  }
}
