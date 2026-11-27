// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What an approved plan still needs when mimir's reply would end, read from the chat's tool calls and results: the
// plan from design.plan, the steps of the design built from it with their plan feature tags (lastStep and the step
// rows the design tools return, by step id), and design.check's verdict. Nothing here is kept between calls; the chat's
// history is the record (the run's own messages, or the earlier run's when the person asks to go on with its plan),
// with the design as it is now (DesignNow) when the run changes a plan built in an earlier run. The words for it live
// here too, so the chat's fold (ui/reduce.ts, which the phone app imports) can tell the notice apart without pulling in
// the runtime.
import { nameKey, single } from '@slicerx/contracts/feature-name'
import type { LlmMessage, LlmToolCall } from './provider/types'
import { askedToRemove, asksToRemove } from './turn-keeps'

/** The code on the chat's notice that mimir went on with the plan; a notice, never a failure (`waiting` is set). */
export const PLAN_LEFT_CODE = 'plan_left'
/** How the note to the model starts, so a scripted client and the context fit can tell it from the person's words. */
export const PLAN_LEFT_PREFIX = 'The approved plan is not finished'

/** A planned feature that a step built with no plan feature tag: the step, by id, when its name or label matches. */
export interface UntaggedFeature {
  feature: string
  step?: string
}

/** What an approved plan still needs at the end of a reply. */
export interface PlanLeft {
  planId: string
  part: string
  /** The design the plan's part is built in, when one was started. */
  design?: string
  /** The plan's part has no body: no design was started after the Go, or the one started has no parts. */
  noBody: boolean
  /** Planned features no step built, by step tag, label or name. */
  build: string[]
  /** Planned features a step built without its plan feature tag. */
  tag: UntaggedFeature[]
  /**
   * The plan's last design.check failed after the design's last change and its one fix round is open (no stop): the
   * items it failed, by name (empty when the result did not list them). Absent otherwise.
   */
  fix?: string[]
}

/** The words that tell features apart: three letters or more, not starting with a digit, plurals made single. */
const nameWords = (name: string): Set<string> => new Set(name.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !/^\d/.test(w)).map(single))

/** Calls that only read a design: their results say what the design is, not that it changed. */
const READS: ReadonlySet<string> = new Set(['design.list', 'design.steps', 'design.timeline', 'design.check', 'design.plan', 'geom.info', 'geom.faces', 'geom.edge_pick', 'geom.measure', 'geom.fit_check', 'geom.interference'])
/** Calls that build or change a design: the design tools and the modeling tools. */
const BUILDS = /^(design|geom)\./

interface Step {
  id: string
  feature?: string
  /** The planned changes (a tilt, a move) an edit of the step carried out, which build no step of their own. */
  edits?: string[]
  /** The step row says it is suppressed (turned off with design.edit_step). */
  off?: boolean
}

interface Reading {
  ok: boolean
  design?: string
  steps?: number
  rows?: Step[]
  last?: { index: number; id: string; feature?: string }
  parts?: number
  accepted?: boolean
  planId?: string
  edits?: { part?: unknown; features?: unknown }
  pass?: boolean
  stop?: boolean
  /** design.check: the names of the items it failed. */
  failed?: string[]
  /** design.check: it failed only on items that were failing before the person's change (failedBefore). */
  carried?: boolean
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

/** A step row as read: its id, its plan feature tag, and the planned changes an edit of it carried out (edits). */
function stepOf(id: string, feature: unknown, edits: unknown): Step {
  const tag = str(feature)
  const done = Array.isArray(edits) ? edits.flatMap((e) => str(e) ?? []) : []
  return { id, ...(tag ? { feature: tag } : {}), ...(done.length ? { edits: done } : {}) }
}

/**
 * A tool result as the run sent it to the model. A long one was cut at 12000 characters and no longer parses: the
 * design summary's fields that come first (design, steps, lastStep) are read from the text then.
 */
function read(content: string): Reading {
  try {
    const out = JSON.parse(content) as { ok?: unknown; result?: Record<string, unknown> }
    const r = out.result ?? {}
    const reading: Reading = { ok: out.ok === true }
    const design = str(r['design'])
    if (design) reading.design = design
    if (typeof r['steps'] === 'number') reading.steps = r['steps']
    if (Array.isArray(r['steps']))
      reading.rows = r['steps'].flatMap((row) => {
        const o = row as { id?: unknown; feature?: unknown; edits?: unknown; state?: unknown }
        const id = str(o?.id)
        if (!id) return []
        return [{ ...stepOf(id, o.feature, o.edits), ...(o.state === 'suppressed' ? { off: true } : {}) }]
      })
    const ls = r['lastStep'] as { index?: unknown; id?: unknown; feature?: unknown } | undefined
    if (ls && typeof ls.index === 'number' && str(ls.id)) {
      const feature = str(ls.feature)
      reading.last = { index: ls.index, id: str(ls.id)!, ...(feature ? { feature } : {}) }
    }
    if (Array.isArray(r['parts'])) reading.parts = r['parts'].length
    if (typeof r['accepted'] === 'boolean') reading.accepted = r['accepted']
    const planId = str(r['planId'])
    if (planId) reading.planId = planId
    if (r['edits'] && typeof r['edits'] === 'object') reading.edits = r['edits'] as NonNullable<Reading['edits']>
    if (typeof r['pass'] === 'boolean') reading.pass = r['pass']
    if (str(r['stop']) || r['repeated'] === true) reading.stop = true
    if (Array.isArray(r['failedBefore'])) reading.carried = true
    if (Array.isArray(r['items'])) reading.failed = r['items'].flatMap((x) => (x && typeof x === 'object' && (x as { pass?: unknown }).pass === false ? (str((x as { name?: unknown }).name) ?? []) : []))
    return reading
  } catch {
    const reading: Reading = { ok: content.startsWith('{"ok":true') }
    const design = /"result":\{"design":"([^"]+)"/.exec(content)?.[1] ?? /"design":"([^"]+)"/.exec(content)?.[1]
    if (design) reading.design = design
    const steps = /"steps":(\d+)/.exec(content)?.[1]
    if (steps) reading.steps = Number(steps)
    const ls = /"lastStep":\{"index":(\d+),"id":"([^"]+)"([^}]*)\}/.exec(content)
    if (ls) {
      const feature = /"feature":"((?:[^"\\]|\\.)*)"/.exec(ls[3] ?? '')?.[1]
      reading.last = { index: Number(ls[1]), id: ls[2]!, ...(feature ? { feature } : {}) }
    }
    if (/"parts":\[\]/.test(content)) reading.parts = 0
    else if (/"parts":\[\{/.test(content)) reading.parts = 1
    // design.check: its own pass comes right after the nozzle; a stop is in its summary as well as at the end
    const pass = /"nozzleMm":[\d.]+,"pass":(true|false)/.exec(content)?.[1]
    if (pass) reading.pass = pass === 'true'
    if (/"stop":"|"repeated":true|The fix round is used|has had its fix round/.test(content)) reading.stop = true
    if (/"failedBefore":\[/.test(content)) reading.carried = true
    return reading
  }
}

function args(call: LlmToolCall): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(call.arguments.trim() || '{}')
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/**
 * A design as it is now, read from its host (a design.steps answer): its steps in order with their plan feature tags,
 * and how many parts it has. What the run's own results say of the design is only what it changed, so a follow-up on
 * a design built in an earlier run reads its steps here.
 */
export interface DesignNow {
  design: string
  steps: readonly { id: string; feature?: string; edits?: string[]; state?: string }[]
  parts: number
}

/** A design.steps answer as a DesignNow, or null when it is not one. Suppressed steps build nothing, as design.check reads them. */
export function designNow(content: string): DesignNow | null {
  try {
    const out = JSON.parse(content) as { ok?: unknown; result?: { design?: unknown; steps?: unknown; parts?: unknown } }
    const r = out.result
    const design = str(r?.design)
    if (out.ok === false || !design || !Array.isArray(r?.steps) || !Array.isArray(r?.parts)) return null
    const steps = r.steps.flatMap((row) => {
      const o = row as { id?: unknown; feature?: unknown; edits?: unknown; state?: unknown } | null
      const id = str(o?.id)
      if (!id || o?.state === 'suppressed') return []
      return [stepOf(id, o?.feature, o?.edits)]
    })
    return { design, steps, parts: r.parts.length }
  } catch {
    return null
  }
}

/**
 * The design the plan `planId` was checked in before message `upTo`, by the last design.check of it that answered, or
 * null: the design a follow-up's amend of that plan changes.
 */
export function checkedDesignOf(messages: readonly LlmMessage[], planId: string, upTo = messages.length): string | null {
  const calls = new Map<string, LlmToolCall>()
  let found: string | null = null
  messages.slice(0, upTo).forEach((m) => {
    if (m.role === 'assistant') for (const c of m.toolCalls ?? []) calls.set(c.id, c)
    if (m.role !== 'tool') return
    const call = calls.get(m.callId)
    if (call?.name !== 'design.check' || str(args(call)['planId']) !== planId) return
    const r = read(m.content)
    if (r.design && r.pass !== undefined) found = r.design
  })
  return found
}

const featureNames = (v: unknown): string[] => (Array.isArray(v) ? v.flatMap((f) => str((f as { name?: unknown } | null)?.name) ?? []) : [])

/**
 * What the approved plan still needs, from the run's messages after `from` (the run's first message), or from the
 * earlier run's design.plan call when the run holds no plan of its own and the person asks to go on with that one
 * (carriedPlanFrom); null when it needs nothing or nothing can be said. The plan is the last design.plan read the
 * person answered with Go (with their edits). Its
 * part is built in the first design a design or modeling call after the Go names. A feature is done when a step of that
 * design carries its name as the plan feature tag (case, punctuation and plurals aside), or, for a planned change (a
 * tilt, a move), in its edits, the rule design.check holds the part to. A feature with no tagged step is one to build, or one to tag when an untagged step was labeled with its name
 * (the call's name or label), the hint design.check gives. Null when:
 *  - no plan was approved in this run, or carried from an earlier one;
 *  - design.check stopped the plan (its fix round is used, so mimir tells the person what is off);
 *  - design.check passed after the design's last change;
 *  - the design's steps are unknown (results without lastStep or step rows) and the part has a body, and no failed
 *    check is waiting on its fix round.
 * A feature mimir took away on purpose (takenAway) is left out: never to build again, unless the person asked for it
 * since.
 * A design.check of the plan that failed after the design's last change, with its fix round still open (no stop), is
 * the plan unfinished too: its failed items are in fix, to be fixed and checked again, even with every feature built
 * and tagged. One that failed only on items failing before the person's change (failedBefore) is not.
 *
 * `now` is the design as its host has it now. It stands for the design's steps and body when it is the plan's design:
 * the one the run's calls built in, or, for a plan the run changed with amends (a plan built in an earlier run), the
 * design given when the run's calls name none. A feature built and tagged in an earlier run then counts as built.
 */
export function planLeft(messages: readonly LlmMessage[], from = 0, now?: DesignNow): PlanLeft | null {
  from = carriedPlanFrom(messages, from) ?? followedPlanFrom(messages, from) ?? from
  const calls = new Map<string, LlmToolCall>()
  let plan: { planId: string; part: string; features: string[]; amended: boolean } | undefined
  let design: string | undefined
  let started = false
  let body: boolean | undefined
  let steps: Step[] | undefined
  // what each step was called when it was made: the call's label or name, by step id
  const labels = new Map<string, string>()
  let changed = -1
  let passed = -1
  let stop = false
  // the plan's last failed check with its fix round open: where, and the items it failed
  let missed: { at: number; items: string[] } | undefined
  messages.slice(from).forEach((m, i) => {
    if (m.role === 'assistant') for (const c of m.toolCalls ?? []) calls.set(c.id, c)
    if (m.role !== 'tool') return
    const call = calls.get(m.callId)
    if (!call) return
    const r = read(m.content)
    if (call.name === 'design.plan') {
      if (!r.ok || r.accepted !== true || !r.planId) return
      const a = args(call)
      const features = featureNames(r.edits?.features ?? a['features'])
      plan = { planId: r.planId, part: str(r.edits?.part) ?? str(a['part']) ?? 'The part', features, amended: str(a['amends']) === r.planId }
      // a new plan starts over: its part is the next design built
      design = undefined
      started = false
      body = undefined
      steps = undefined
      changed = passed = -1
      stop = false
      missed = undefined
      return
    }
    if (!plan || !r.ok) return
    if (call.name === 'design.check') {
      if (str(args(call)['planId']) !== plan.planId) return
      if (r.stop) stop = true
      if (r.pass === true) passed = i
      // a follow-up's check that fails only on what failed before the change has no fix round open for it
      missed = r.pass === false && !r.stop && !r.carried ? { at: i, items: r.failed ?? [] } : undefined
      return
    }
    if (!BUILDS.test(call.name)) return
    if (!READS.has(call.name)) started = true
    if (!r.design) return
    design ??= r.design
    if (r.design !== design) return
    if (!READS.has(call.name)) changed = i
    if (r.parts !== undefined) body = r.parts > 0
    const a = args(call)
    if (r.rows) {
      steps = r.rows
    } else if (r.steps !== undefined) {
      const now: Step[] = (steps ?? []).slice(0, r.steps)
      while (now.length < r.steps) now.push({ id: '' })
      if (r.last && r.last.index >= 1 && r.last.index <= r.steps) {
        // a new step takes the call's label or name, which says what it built when no feature was given
        const label = str(a['label']) ?? str(a['name'])
        if (!READS.has(call.name) && call.name !== 'design.undo' && call.name !== 'design.redo' && call.name !== 'design.edit_step' && label && !labels.has(r.last.id)) labels.set(r.last.id, label)
        now[r.last.index - 1] = { id: r.last.id, ...(r.last.feature ? { feature: r.last.feature } : {}) }
      }
      steps = now
    }
    // a step's tag set with design.edit_step, by its id or its index from 1
    if (call.name === 'design.edit_step' && typeof a['feature'] === 'string' && steps) {
      const at = typeof a['step'] === 'number' ? a['step'] - 1 : steps.findIndex((s) => s.id === a['step'])
      const s = steps[at]
      if (s) steps[at] = stepOf(s.id, a['feature'], s.edits)
    }
  })
  if (!plan || stop) return null
  if (passed >= 0 && passed > changed) return null
  // the plan's design as its host has it now: every step built so far, in this run or an earlier one
  if (now && (design === now.design || (design === undefined && plan.amended))) {
    design = now.design
    started = true
    body = now.parts > 0
    steps = now.steps.map((x) => ({ ...x }))
  }
  const noBody = !started || body === false
  const fix = missed && missed.at > changed ? missed.items : undefined
  const left: PlanLeft = { planId: plan.planId, part: plan.part, ...(design ? { design } : {}), noBody, build: [], tag: [], ...(fix ? { fix } : {}) }
  if (!steps) return noBody || fix ? left : null
  // a feature mimir took away on purpose, in this run or an earlier one, is neither to build nor to tag
  const away = design ? takenAway(messages, design) : new Set<string>()
  // a planned change (a tilt, a move) an edit carried out counts as built, as design.check counts it
  const tagged = new Set(steps.flatMap((s) => [...(s.feature ? [s.feature] : []), ...(s.edits ?? [])].map(nameKey)))
  // the steps no feature of the plan is tagged on, with what they were called
  const keys = new Set(plan.features.map(nameKey))
  const loose = steps.filter((s) => s.id && !(s.feature && keys.has(nameKey(s.feature)))).map((s) => ({ id: s.id, name: s.feature ?? labels.get(s.id) ?? '' })).filter((s) => s.name)
  for (const feature of plan.features) {
    const key = nameKey(feature)
    if (tagged.has(key) || away.has(key)) continue
    // the step named as the feature; else the one whose name shares the most words with it
    const exact = loose.find((s) => nameKey(s.name) === key)
    const words = nameWords(feature)
    let best: { id: string; shared: number } | undefined
    if (!exact)
      for (const s of loose) {
        const shared = [...nameWords(s.name)].filter((w) => words.has(w)).length
        if (shared > 0 && shared > (best?.shared ?? 0)) best = { id: s.id, shared }
      }
    const step = exact?.id ?? best?.id
    if (step) left.tag.push({ feature, step })
    else left.build.push(feature)
  }
  return left.noBody || left.build.length || left.tag.length || left.fix ? left : null
}

// Words that ask mimir to go on with the work in hand: "keep going", "continue", "go ahead", "then build it".
const GOES_ON = /\b(?:keep (?:going|at it|building)|continue|carry on|go (?:on|ahead)|proceed|resume|finish (?:it|up|off|the|building)|(?:build|make|do) (?:it|them|that|the rest)|yes|yep|yeah|sure|ok|okay)\b/i
// Words that set the work in hand aside: "stop", "don't", "instead", "never mind", something new.
const SETS_ASIDE = /\b(?:stop|cancel|don['’]?t|do not|never ?mind|instead|forget|scrap|start over|something else|a different|another (?:part|design|one))\b/i
/** What the person wrote, from a request the run sent: the words after "User request:", without the attached files. */
const said = (content: string): string | undefined => {
  const at = content.lastIndexOf('User request:\n')
  return at < 0 ? undefined : content.slice(at + 'User request:\n'.length).replace(/\n\nAttached: [^\n]*$/, '')
}

/**
 * Where to read an approved plan from when the run's own messages hold none: the message that called design.plan in an
 * earlier run of the chat, when that call was the chat's last design.plan and the person approved it with Go, and every
 * message the person sent since asks to go on with it ("keep going", "continue", "then build it") without setting it
 * aside ("stop", "instead", "never mind"). Undefined otherwise: the run then reads only its own messages, so a plan the
 * person declined, replaced or moved away from is never pushed again. `runStart` is the first message of the run, after
 * the person's request.
 */
export function carriedPlanFrom(messages: readonly LlmMessage[], runStart: number): number | undefined {
  const calls = new Map<string, { call: LlmToolCall; at: number }>()
  let last: { at: number; approved: boolean } | undefined
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!
    if (m.role === 'assistant') for (const c of m.toolCalls ?? []) calls.set(c.id, { call: c, at: i })
    if (m.role !== 'tool') continue
    const c = calls.get(m.callId)
    if (c?.call.name !== 'design.plan') continue
    // a plan shown in this run is this run's own: planLeft reads it from the run's messages
    if (c.at >= runStart) return undefined
    const r = read(m.content)
    last = { at: c.at, approved: r.ok && r.accepted === true && r.planId !== undefined }
  }
  if (!last?.approved) return undefined
  // the designs started since the plan: the first is its part's, and one this run starts after it is another part
  let started = false
  for (let i = last.at + 1; i < messages.length; i++) {
    const m = messages[i]!
    const words = i < runStart && m.role === 'user' ? said(m.content) : undefined
    if (words !== undefined && (!GOES_ON.test(words) || SETS_ASIDE.test(words))) return undefined
    if (m.role !== 'tool' || calls.get(m.callId)?.call.name !== 'design.new' || !read(m.content).ok) continue
    if (started && i >= runStart) return undefined
    started = true
  }
  return last.at
}

/** Calls that look at a design or save it without changing it, beside READS. */
const LOOKS: ReadonlySet<string> = new Set(['design.look', 'design.render', 'design.get_plan', 'design.lookup_sizes', 'design.save', 'geom.render', 'geom.paint_regions', 'geom.face_pick', 'geom.sketch_check', 'geom.layers_plan'])

/**
 * Where to read an approved plan from for a follow-up on its design: the message that called design.plan in an earlier
 * run of the chat, when that call was the chat's last design.plan before this run and the person approved it with Go,
 * and this run changes the design its part was built in (the first design a design or modeling call named after it).
 * Undefined otherwise, as for a run that shows a plan of its own, works only on another design, or only reads.
 */
export function followedPlanFrom(messages: readonly LlmMessage[], runStart: number): number | undefined {
  const calls = new Map<string, { call: LlmToolCall; at: number }>()
  let last: { at: number; approved: boolean } | undefined
  let design: string | undefined
  let changed = false
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!
    if (m.role === 'assistant') for (const c of m.toolCalls ?? []) calls.set(c.id, { call: c, at: i })
    if (m.role !== 'tool') continue
    const c = calls.get(m.callId)
    if (!c) continue
    const r = read(m.content)
    if (c.call.name === 'design.plan') {
      // a plan shown in this run is this run's own: planLeft reads it from the run's messages
      if (c.at >= runStart) return undefined
      last = { at: c.at, approved: r.ok && r.accepted === true && r.planId !== undefined }
      design = undefined
      continue
    }
    if (!last || !BUILDS.test(c.call.name) || !r.ok || !r.design) continue
    design ??= r.design
    if (i >= runStart && r.design === design && !READS.has(c.call.name) && !LOOKS.has(c.call.name)) changed = true
  }
  return last?.approved && changed ? last.at : undefined
}

/** Calls whose answer's lastStep is a step already there, not one they built: an undo, an edit, a move of the timeline marker. */
const UNMAKES: ReadonlySet<string> = new Set(['design.undo', 'design.edit_step', 'design.roll'])

/** The step `ref` names (an index from 1, as a number or digits, or a step id) among the steps in order. */
function stepAt(steps: readonly Step[], ref: unknown): Step | undefined {
  if (typeof ref === 'number') return steps[ref - 1]
  const id = str(ref)
  if (!id) return undefined
  return steps.find((s) => s.id === id) ?? (/^\d+$/.test(id) ? steps[Number(id) - 1] : undefined)
}

// Words that ask for a feature again: add it, put it back, bring it back, build it again.
const ASKS_AGAIN = /\b(?:add|adding|back|again|restore|return|bring|put|rebuild|re-?add|redo)\b/i

/** Whether the person's words ask for the feature again: they name it (a word of its name) and ask to add it or put it back, not to remove it. */
function asksAgain(words: string, feature: string): boolean {
  if (!ASKS_AGAIN.test(words) || asksToRemove(words)) return false
  const named = nameWords(feature)
  return [...nameWords(words)].some((w) => named.has(w))
}

/**
 * The planned features mimir took away on purpose in design `design`, by name key (as nameKey compares them), read
 * from the whole chat: a step tagged with the feature that design.undo removed in the request that made it, or in a
 * later one that asks to remove it (an undo of earlier work for anything else is a rollback, its feature still to
 * build), or that design.edit_step turned off (suppressed), with no step built for it since (nor that step turned
 * back on). The design's history records both: an
 * undo's answer has fewer steps than the design had, so the steps it removed are the ones the results last named at
 * those places, and a suppressed step's row says so. Each is mimir's own call, made for the person's words ("take the
 * openings off") or to clear a check, so the note never sends mimir back to build the feature again. A message of the
 * person after the removal that asks for the feature again (it names the feature and asks to add it or put it back)
 * gives it back to the plan: it is to build again while no step makes it. A feature an amend dropped is not in the
 * plan at all.
 */
export function takenAway(messages: readonly LlmMessage[], design: string): Set<string> {
  const calls = new Map<string, LlmToolCall>()
  // the design's steps in order, as the results named them
  let known: Step[] = []
  // each feature taken away, by name key
  const away = new Map<string, string>()
  const take = (s: Step | undefined): void => {
    if (s?.feature) away.set(nameKey(s.feature), s.feature)
  }
  const give = (s: { feature?: string } | undefined): void => {
    if (s?.feature) away.delete(nameKey(s.feature))
  }
  // the person's requests so far, and their words in the latest, to tell an undo of an earlier request's work apart
  let run = 0
  let asked = ''
  // the request each step was made in, by step id, from the call that made it
  const madeIn = new Map<string, number>()
  for (const m of messages) {
    if (m.role === 'user') {
      const words = said(m.content)
      if (words !== undefined) {
        run++
        asked = words
        for (const [key, feature] of away) if (asksAgain(words, feature)) away.delete(key)
      }
      continue
    }
    if (m.role === 'assistant') for (const c of m.toolCalls ?? []) calls.set(c.id, c)
    if (m.role !== 'tool') continue
    const call = calls.get(m.callId)
    if (!call || !BUILDS.test(call.name)) continue
    const r = read(m.content)
    if (r.design !== design) continue
    const before = known
    if (r.rows) known = r.rows
    else if (r.steps !== undefined) {
      known = before.slice(0, r.steps)
      while (known.length < r.steps) known.push({ id: '' })
      if (r.last && r.last.index >= 1 && r.last.index <= r.steps) known[r.last.index - 1] = { id: r.last.id, ...(r.last.feature ? { feature: r.last.feature } : {}) }
    }
    // an undo removes the steps past the design's new count. One made for an earlier request is taken away only when
    // the person asked to remove it; otherwise it is a rollback, and its feature is still to build
    if (call.name === 'design.undo' && r.ok) for (const s of before.slice(known.length)) if (madeIn.get(s.id) === run || (s.feature && askedToRemove(asked, s.feature))) take(s)
    // a step turned off: by its row when the answer lists the steps, else by the call when it went through; turned
    // back on, it builds its feature again
    if (call.name === 'design.edit_step' && typeof args(call)['suppressed'] === 'boolean') {
      const s = stepAt(known, args(call)['step']) ?? stepAt(before, args(call)['step'])
      if (args(call)['suppressed'] === false) give(s)
      else if (s?.off || (r.ok && !r.rows)) take(s)
    }
    // a step built again for the feature (or put back with design.redo) builds it again
    if (r.ok && !READS.has(call.name) && !UNMAKES.has(call.name)) {
      give(r.last)
      // the steps this call made: new in its answer
      for (const x of known) if (x.id && !madeIn.has(x.id) && !before.some((y) => y.id === x.id)) madeIn.set(x.id, run)
    }
  }
  return new Set(away.keys())
}

/** "a", "a and b", "a, b and c". */
function list(names: readonly string[]): string {
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

/**
 * The one note mimir gets in place of ending its reply, as the user's turn: what the plan still needs, to build it
 * now rather than ask. `tools` says which design tools the run has, so the note names only those.
 */
export function planLeftNote(left: PlanLeft, tools: { editStep: boolean; check: boolean }): string {
  const lines = [`${PLAN_LEFT_PREFIX} (plan ${left.planId}, ${left.part}), so keep building now instead of ending or asking whether to go on: the person approved it with Go, and its sizes and assumptions settle what it covers.`]
  if (left.noBody) lines.push(`${left.part} has no body yet${left.design ? ` in ${left.design}` : ''}: build it.`)
  if (left.build.length) lines.push(`Still to build: ${left.build.join(', ')}. Pass feature with the feature's name from the plan on each step.`)
  if (left.tag.length) {
    const how = tools.editStep ? 'set feature on the step that built it with design.edit_step' : 'tag the step that built it with its feature'
    lines.push(`Built, but no step is tagged with the feature: ${left.tag.map((t) => `"${t.feature}"${t.step ? ` (step "${t.step}")` : ''}`).join(', ')}. Do not build these again; ${how}.`)
  }
  if (left.fix)
    lines.push(
      `Its last design.check failed${left.fix.length ? ` on ${list(left.fix)}` : ''}, and the plan's one fix round is open: fix ${left.fix.length === 1 ? 'that item' : 'those items'} now (the part to what the plan wants, or a size the build cannot keep through amends), then call design.check (planId ${left.planId}) again. Only a second failed check ends the building.`,
    )
  else if (tools.check) lines.push(`Then check the part with design.check (planId ${left.planId}).`)
  lines.push('Ask the person only about something the plan does not settle.')
  return lines.join(' ')
}

/** The short notice the chat shows when mimir goes on, in the app's words: what it went on to. */
export function planLeftNotice(left: PlanLeft, assistant: string): string {
  if (left.noBody) return `${assistant} went on to build ${left.part}, which the plan still needs.`
  if (left.build.length) return `${assistant} went on to the parts the plan still needs: ${list(left.build)}.`
  if (left.fix && !left.tag.length) return `${assistant} went on to fix what the design check found${left.fix.length ? `: ${list(left.fix)}` : ''}.`
  return `${assistant} went on to finish the plan, marking the steps that built ${list(left.tag.map((t) => t.feature))}.`
}

// A question that asks leave to go on with work: "Should I add ...?", "Want me to build the lid next?", "Shall we go on?"
const GO_ON = /\b(?:should|shall|can|may) (?:i|we)\b|\b(?:do|would) you (?:like|want) me to\b|\b(?:want|like) me to\b|\b(?:ok|okay|alright|fine) (?:if i|to|for me to)\b|\bready for me to\b|\bgo ahead\b|\b(?:continue|proceed|keep going|carry on|go on)\b/i
// A question that names the plan's own answer: "should the gears print loose, as the plan assumed, or be fixed?"
const PLAN_SAYS = /\bas (?:the plan (?:assumed|assumes|says|has)|planned|assumed)\b|\bthe plan (?:already )?(?:has|says|assumes|assumed|lists|calls for|covers)\b|\b(?:the|my|plan's) assumption\b/i
// A question that asks the person for something: a size, a name, which one
const ASKS_FOR = /^(?:what|which|how|where|when|who|whose|why)\b/i
// the endings of a question that still offers only going on or stopping
const OR_STOP = /,?\s+or (?:not|stop(?: here)?|wait|leave it(?: there| as it is)?)\b/gi

/** The sentences of a reply that end in a question mark, without list marks and bold or italic marks around them. */
function questions(text: string): string[] {
  return text
    .split(/\n+|(?<=[.!?])\s+/)
    .map((s) =>
      s
        .replace(/[*_`]+/g, '')
        .replace(/^\s*(?:[-+]|\d+[.)])\s+/, '')
        .replace(/^[^:?]{1,40}:\s+/, '')
        .trim(),
    )
    .filter((s) => /\?["')\]]*$/.test(s))
}

/**
 * The question in mimir's last words that asks the person for a decision the plan does not settle, or undefined when
 * there is none. Only sentences ending in a question mark count. A question is settled by the plan, and so is no reason
 * to stop, when it:
 *  - names the plan's own answer ("as the plan assumed", "the plan already has"); or
 *  - asks leave to go on with work ("should I", "shall we", "want me to", "continue", "go ahead"), unless it asks for
 *    something (it starts with what, which, how, where, when, who, whose or why) or offers a choice of its own (an "or"
 *    that is not "or not", "or stop" or "or wait").
 * Any other question ("What bore should the sun gear have?", "Should the lid snap on or slide in?", "Should I use 3 mm
 * or 4 mm pins?") is a decision the person makes, and the reply ends there.
 */
export function unsettledQuestion(text: string): string | undefined {
  return questions(text).find((q) => {
    if (PLAN_SAYS.test(q)) return false
    if (ASKS_FOR.test(q) || !GO_ON.test(q)) return true
    return /\bor\b/i.test(q.replace(OR_STOP, ''))
  })
}

/** An approved plan the open project holds (the project file keeps it), for a chat whose history holds no plan. */
export interface StandingPlan {
  planId: string
  /** The plan as the person approved it, with their edits, without its id: what design.plan showed on the card. */
  plan: { part: string; features: readonly { name: string }[] } & Record<string, unknown>
  /** The design its part is built in, as it is now: its steps in order with their plan feature tags, and its parts. Absent while nothing is built. */
  design?: { id: string; name: string; steps: readonly { id: string; name?: string; feature?: string }[]; parts: readonly string[] }
}

/** The line the seed opens with, as the person's turn: a request has to start with one. Never shown, never logged. */
export const PLAN_SEED_NOTE = 'This project was opened with a plan approved earlier, read back from the project file.'

/**
 * The history a chat gets for an approved plan the open project holds, so planLeft and carriedPlanFrom read it as they
 * read a plan approved earlier in the chat: the design.plan call with the plan as approved and its answer (Go), then,
 * when its part was started, the design.new that started it (empty) and a design.steps read of the design as it is
 * now (its steps with their plan feature tags, and its parts). The design.new is what tells them the part has a body
 * and is the plan's first design, so a run that starts another design leaves the plan alone. Pure: the host decides
 * whether there is such a plan (the plan open, not passed or stopped, and its design unchanged since mimir's last run).
 */
export function planSeed(s: StandingPlan): LlmMessage[] {
  const call = (id: string, name: string, args: unknown): LlmMessage => ({ role: 'assistant', content: '', toolCalls: [{ id, name, arguments: JSON.stringify(args) }] })
  const answer = (id: string, summary: string, result: unknown): LlmMessage => ({ role: 'tool', callId: id, content: JSON.stringify({ ok: true, summary, result }) })
  const out: LlmMessage[] = [
    { role: 'user', content: PLAN_SEED_NOTE },
    call('standing_plan_1', 'design.plan', s.plan),
    answer('standing_plan_1', 'Approved', { planId: s.planId, accepted: true }),
  ]
  const d = s.design
  if (!d) return out
  const parts = d.parts.map((name, index) => ({ index, name }))
  const rows = d.steps.map((st, i) => ({ index: i + 1, id: st.id, ...(st.name ? { name: st.name } : {}), ...(st.feature ? { feature: st.feature } : {}) }))
  out.push(
    call('standing_plan_2', 'design.new', { name: d.name }),
    answer('standing_plan_2', `Started ${d.name} (${d.id})`, { design: d.id, name: d.name, steps: 0, parts: [] }),
    call('standing_plan_3', 'design.steps', { design: d.id }),
    answer('standing_plan_3', `${rows.length} step${rows.length === 1 ? '' : 's'}`, { design: d.id, name: d.name, steps: rows, parts }),
  )
  return out
}
