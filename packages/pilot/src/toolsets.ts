// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Which toolsets a turn sends when a provider takes fewer tools than mimir has. OpenAI-style APIs and mimir cloud's
// proxy refuse a request with more than 128 tools, so over that cap a turn sends the core tools, every tool the chat
// already called and the toolsets the turn needs, then the other toolsets by a fixed priority while they fit whole; the
// room left goes to the first toolsets in that order that did not fit, tool by tool. The toolsets left out are
// reported. Under the cap every tool goes, in the same order, exactly as before.
//
// A cloud model's capped chat keeps its toolsets from message to message (stickyCapTools): a short reply such as "yes
// please" still has what the last message and mimir's last reply asked for, the toolsets of every tool the chat called
// stay in while they fit, and the list is the same request after request until something forces a change, so the
// provider's prompt cache keeps hitting. A capped request also carries pilot.load_tools, which loads a toolset that was
// left out for the next step.
//
// A cloud turn has a kind (turnKind): building a part keeps every design tool, slicing the slicing and project tools,
// and running a printer every printer tool with send. Each of those carries the printer safety tools (SAFETY_TOOLS),
// which take the printer as an argument, so they stay four whatever the fleet's size. A turn of the same kind as the
// last sends the last list again, and while an approved plan is being built every turn is a design turn. A turn that
// is none of these alone is mixed: it picks as before, with the safety tools always in.
import type { PilotContext } from '@slicerx/contracts'
import { z } from 'zod'
import { onEveryLocalTurn, toolGroupOf, type ToolSurface } from './surfaces'
import { defineTool, type PilotTool, type Toolset } from './tool'

/**
 * The order toolsets are kept in when they do not all fit, first kept first. Core is never traded away. The design
 * tools come next because the mimir tab builds parts with them, then preparing and slicing a plate, the printers, the
 * project, the knowledge base, plate mesh edits, calibration, fleets, and what connected apps and other skills add.
 * Last, the design tools a request asks for by name (a rail), which take only room no other toolset needs.
 */
export const TOOLSET_PRIORITY: readonly Toolset[] = ['core', 'cad', 'settings', 'printers', 'project', 'kb', 'mesh', 'calibration', 'fleets', 'skills', 'theme', 'cloud', 'local_ai', 'cad_more']

type SetTool = Pick<PilotTool, 'name'> & Partial<Pick<PilotTool, 'toolset' | 'source' | 'permission' | 'plugin' | 'command' | 'printerFor' | 'approval'>>

const BY_NAME: Record<string, Toolset> = {
  text_to_part: 'cad',
  make_model: 'cad',
  threads_and_fits: 'cad',
  scale_with_tolerance: 'cad',
  fit_check: 'cad',
  cut: 'mesh',
  hollow: 'mesh',
  emboss: 'mesh',
  mesh_analyze: 'mesh',
  mesh_repair: 'mesh',
  multicolor_assign: 'mesh',
  // a rail along a design's line or edge is asked for by name ("add a railing"), so it loads on those words rather than
  // taking a place in every capped request beside the rest of the design tools
  'geom.rail': 'cad_more',
  // so is setting the filament a part already made prints with ("make the hull red", PART_FILAMENT_WORDS)
  'design.part_filament': 'cad_more',
  // painting a design in filaments goes with the project's filament tools (project.add_filament and set_filament)
  'paint.preview': 'project',
  'paint.apply': 'project',
  'paint.regions': 'project',
  'parts.lookup': 'kb',
  material_recommend: 'kb',
  calibrate: 'calibration',
  fleet_overview: 'fleets',
  schedule: 'fleets',
  overnight_readiness: 'fleets',
  'setup.look': 'theme',
  'lookup.show': 'core',
}

const BY_PREFIX: readonly [string, Toolset][] = [
  ['pilot.', 'core'],
  ['memory.', 'core'],
  ['kb.', 'kb'],
  ['project.', 'project'],
  ['settings.', 'settings'],
  ['theme.', 'theme'],
  ['fleet.', 'fleets'],
  ['localai.', 'local_ai'],
  ['cloud.', 'cloud'],
]

/**
 * The toolset a tool loads with: its own tag when it has one, else what its name, its app command or its plugin says.
 * App commands that change nothing (go to a tab, frame the view) are core; plate commands are the project; the other
 * commands that change something go with their tool group (surfaces.ts).
 */
export function toolsetOf(tool: SetTool): Toolset {
  if (tool.toolset) return tool.toolset
  if (Object.hasOwn(BY_NAME, tool.name)) return BY_NAME[tool.name]!
  const prefixed = BY_PREFIX.find(([p]) => tool.name.startsWith(p))
  if (prefixed) return prefixed[1]
  const group = toolGroupOf(tool)
  if (tool.command && group === 'slicing' && tool.command.section === 'plate') return 'project'
  switch (group) {
    case 'design':
      return 'cad'
    case 'slicing':
      return 'settings'
    case 'printers':
    case 'watch':
      return 'printers'
    case 'paint':
      return 'mesh'
    case 'web':
      return 'kb'
    default:
      return tool.source === 'skill' || tool.source === 'plugin' ? 'skills' : 'core'
  }
}

/**
 * Words that ask for a rail: a rail, railing or handrail, a guardrail (not "the guardrails of" or "for" something, a
 * limit), a fence, balustrade or banister. turnSet reads them as shaping words too.
 */
export const RAIL_WORDS = /\b(?:(?:hand)?rail(?:ing)?s?|guardrails?(?!\s+(?:of|for)\b)|fences?|balustrades?|banisters?)\b/i

/**
 * Words that put a part already made in a filament: "make the hull red", "the lower hull in filament 3". A filament
 * profile ask ("which filament", "load filament", PLA or PETG) is not one; it stays with the project and settings.
 */
export const PART_FILAMENT_WORDS =
  /\b(?:(?:make|turn|paint|colou?r|set)\s+(?:the|its|that|this|it)\b(?:\s+[\w-]+){0,3}?\s+(?:in\s+)?(?:red|orange|yellow|green|blue|purple|pink|black|white|gr[ae]y|brown|silver|gold)\b(?!\s+(?:pla|petg|abs|asa|tpu|nylon|filament|spool)\b)|(?:in|to|with)\s+filament\s*#?\d+\b)/i

/** Words in a request that say which toolsets it needs. */
const NEEDS: readonly [Toolset, RegExp][] = [
  ['cad', /\b(design|model|part|sketch|extrude|fillet|chamfer|hole|bracket|hook|box|lid|gear|thread|build|make|draw|cad)\w*/i],
  ['settings', /\b(slice|slicing|setting|profile|layer|infill|support|wall|brim|raft|speed|temperature|temp|nozzle|orient|arrange|estimate|strength|strong|quality|filament)\w*/i],
  ['printers', /\b(print|printer|send|queue|job|spool|ams|camera|pause|resume|cancel|bed|plug|g-?code)\w*/i],
  // painting a part in filaments is the project's paint and filament tools (BY_NAME), so a paint ask has them from its
  // first step instead of loading them mid-turn
  ['project', /\b(project|plate|open|file|export|save|stl|3mf|step|paint|colou?r|recolou?r)\w*/i],
  ['kb', /\b(why|how|which|recommend|best|troubleshoot|problem|issue|string|warp|clog|look up|source|material)\w*/i],
  ['mesh', /\b(mesh|repair|hollow|emboss|cut|split|paint|color|colour)\w*/i],
  ['cad_more', RAIL_WORDS],
  ['cad_more', PART_FILAMENT_WORDS],
  ['calibration', /\bcalibrat\w*/i],
  ['fleets', /\b(fleet|farm|schedule|overnight|tonight)\w*/i],
  ['theme', /\b(theme|look|dark mode|light mode)\b/i],
]

// Words after "print", "send" or "queue" that make it a question about a print or a printer, or something else to send:
// "print quality looks bad", "print settings", "the print failed", "send a bug report".
const NOT_A_PART = String.raw`(?:settings?|quality|speeds?|times?|status|jobs?|fail\w*|keeps|stopped|stops|is|was|went|looks?|looked|came|has|had|head|bed|profiles?|preview|history|logs?|progress|temperatures?|temps?|layers?|bug|feedback|reports?|photos?|pictures?|snapshots?|messages?|notes?|emails?|questions?|links?)\b`
// The verb, not the noun: "print" after "the", "my" or "a" is a print already going ("how's the print on Bay 2 going?").
const VERB = String.raw`(?<!\b(?:the|a|an|my|your|our|its|this|that|last|next|first|whole)\s+)\b(?:print|send|queue)`
/**
 * Asking to print or send a part: the verb and what goes ("print it", "print 3 copies", "print bracket.stl", "print the
 * lid"), or where it goes ("send to Printer 3", "print on Bay 2"), a message that starts with the verb and names a destination ("Print bracket
 * on Bay 2"), the verb at the end ("go ahead and print"), and "start the print".
 */
const PRINT_IT = new RegExp(
  [
    String.raw`${VERB}\s+(?:(?:me|us|out|over)\s+)?(?:it|this|that|them|these|those|one|both|all|\d+|two|three|four|five|six|seven|eight|nine|ten)\b`,
    String.raw`${VERB}\s+(?:(?:me|us|out|over)\s+)?[\w-]+\.(?:stl|3mf|step|stp|obj|gcode)\b`,
    String.raw`${VERB}\s+(?:(?:me|us)\s+)?(?:the|my|a|an|another|some)\s+(?!${NOT_A_PART})\w`,
    String.raw`${VERB}\s+(?:on|to)\s+(?:the\s+|my\s+)?(?:printers?|bay|farm|fleet|\w*\d\w*)\b`,
    String.raw`^\W*(?:(?:please|ok|okay|now|then)\s+)?(?:print|send|queue)\s+(?:(?:me|us)\s+)?(?!(?:(?:the|my|a|an|another|some|your)\s+)?${NOT_A_PART})[\w-]+(?:\s+[\w-]+){0,3}\s+(?:on|to)\s+(?:the\s+|my\s+)?(?:printers?|bay|farm|fleet|\w*\d\w*)\b`,
    String.raw`\b(?:and|please|just|now|then|to)\s+print\s*(?:[.!,]|$)`,
    String.raw`\bstart(?:ing)?\s+(?:the\s+|a\s+|my\s+)?print(?:ing)?\b(?!\s+${NOT_A_PART})`,
  ].join('|'),
  'i',
)

/**
 * The toolsets a turn needs besides core: the tab's own (the design tools, where the host gives them), what the request
 * asks for, and what the plate holds (a printer it is assigned to, objects on it). Used only when tools must be left out.
 * `sliceToPrint` (cloud models): a request to print or send a part needs the slicing tools as well.
 */
export function turnNeeds(message: string, opts: { designs?: boolean; context?: PilotContext; sliceToPrint?: boolean } = {}): Set<Toolset> {
  const needs = new Set<Toolset>()
  if (opts.designs) needs.add('cad')
  for (const [set, words] of NEEDS) if (words.test(message)) needs.add(set)
  // a part goes to a printer sliced: on a capped cloud request, asking to print or send one needs the slicing tools too
  // (a local model's turn sets already pick its slicing and send tools)
  if (opts.sliceToPrint && PRINT_IT.test(message)) needs.add('settings')
  if (opts.context?.printerId) needs.add('printers')
  if (opts.context?.objects?.length) needs.add('project')
  return needs
}

/**
 * What a capped cloud turn is for, by the toolsets its message asks for: building a part, slicing a plate or running a
 * printer, or mixed (none of those alone). A turn while an approved plan is still being built is a design turn whatever
 * its words, so the build's tool list holds until it ends. On the design tab a message that asks for none of the three
 * is a design turn. A mixed turn picks its tools as before kinds, with the safety tools always in.
 */
export type TurnKind = 'design' | 'slicing' | 'printer' | 'mixed'

const KIND_OF: readonly [Toolset, Exclude<TurnKind, 'mixed'>][] = [
  ['cad', 'design'],
  ['settings', 'slicing'],
  ['printers', 'printer'],
]

/**
 * The turn's kind from what its message alone needs (turnNeeds without the tab), a build going on, what mimir's last
 * reply offered (a "yes please" takes the offer's kind), and the tab.
 */
export function turnKind(messageNeeds: ReadonlySet<Toolset>, opts: { designs?: boolean; building?: boolean; offer?: ReadonlySet<Toolset> } = {}): TurnKind {
  if (opts.building) return 'design'
  const of = (sets: ReadonlySet<Toolset>) => KIND_OF.filter(([set]) => sets.has(set)).map(([, kind]) => kind)
  let kinds = of(messageNeeds)
  if (kinds.length === 0 && opts.offer) kinds = of(opts.offer)
  if (kinds.length === 1) return kinds[0]!
  return kinds.length === 0 && opts.designs ? 'design' : 'mixed'
}

/** The toolsets each kind keeps whole, after core and the protected ones. */
export const KIND_SETS: Record<Exclude<TurnKind, 'mixed'>, readonly Toolset[]> = {
  design: ['cad'],
  slicing: ['settings', 'project'],
  printer: ['printers'],
}
/** The toolsets each kind fills first with the room left, before the rest in TOOLSET_PRIORITY order. */
const KIND_FILL: Record<Exclude<TurnKind, 'mixed'>, readonly Toolset[]> = {
  design: ['cad'],
  slicing: ['settings', 'project'],
  printer: ['printers', 'settings', 'project'],
}

/**
 * The printer safety tools every capped turn of a kind carries: stop or pause any printer by its id, see it first, and
 * find its id. They take the printer as an argument, so the list is the same four whatever the fleet's size; the
 * per-printer commands (pause, send) are fill, kept as room allows.
 */
export const SAFETY_TOOLS: readonly string[] = ['printer.list', 'printer.status', 'printer.pause', 'printer.cancel']
/** What a printer turn adds to the safety tools: sending a job to any printer, and where it goes. */
export const SEND_TOOLS: readonly string[] = ['printer.queue', 'run.target']
/** The most tools a kind ever pins: the safety tools and the send tools, whatever the fleet's size. */
export const MAX_PINNED = SAFETY_TOOLS.length + SEND_TOOLS.length

/**
 * The tool names a cloud turn of this kind always carries when they are offered: the safety tools on every kind, mixed
 * included, and send on a printer turn. None without a kind (a pick made outside a cloud turn).
 */
export function pinnedFor(kind: TurnKind | undefined): ReadonlySet<string> {
  if (!kind) return new Set()
  return new Set(kind === 'printer' ? [...SAFETY_TOOLS, ...SEND_TOOLS] : SAFETY_TOOLS)
}

/** What a turn sent when tools were left out: the cap, how many tools there were and went, and the toolsets in and out. */
export interface ToolCapReport {
  cap: number
  offered: number
  sent: number
  /** Toolsets sent whole: in the order they were taken, or in priority order on a cloud model's capped chat. */
  toolsets: Toolset[]
  /** Toolsets with tools left out, in priority order. A tool the chat already called still goes. */
  leftOut: Toolset[]
  /** Of leftOut, the toolsets that still sent some of their tools, with how many of how many. */
  partial: { toolset: Toolset; sent: number; of: number }[]
  /** The tool the request carried for loading a left-out toolset (pilot.load_tools), or null when it carried none. */
  loader: string | null
}

/** The log line for a turn that left toolsets out. */
export function capLine(r: ToolCapReport, who: { assistant: string; model: string; provider: string }): string {
  const out = r.leftOut.map((s) => {
    const p = r.partial.find((x) => x.toolset === s)
    return p ? `${s} (${p.sent} of ${p.of} sent)` : s
  })
  return `${who.assistant} sent ${r.sent} of ${r.offered} tools (${who.model} on ${who.provider} takes at most ${r.cap}); left out: ${out.join(', ') || 'none'}`
}

/**
 * The tools a turn sends under `cap`. Under the cap: every tool, in order, and no report. Over it: the tools the chat
 * already called, then core, then the needed toolsets and then the rest, each in TOOLSET_PRIORITY order and only whole,
 * then the room left to the toolsets that did not fit, in the same order, tool by tool. The result keeps the tools' own
 * order. When the called tools and core alone are over the cap, the called tools go
 * first and core fills what is left.
 */
export function capTools<T extends SetTool>(tools: readonly T[], opts: { cap: number | undefined; needs: ReadonlySet<Toolset>; called: ReadonlySet<string> }): { tools: T[]; report: ToolCapReport | null } {
  const cap = opts.cap
  if (cap === undefined || tools.length <= cap) return { tools: [...tools], report: null }
  const bySet = new Map<Toolset, T[]>()
  for (const t of tools) {
    const set = toolsetOf(t)
    bySet.set(set, [...(bySet.get(set) ?? []), t])
  }
  const keep = new Set<T>()
  for (const t of tools) if (opts.called.has(t.name) && keep.size < cap) keep.add(t)
  const order = [...TOOLSET_PRIORITY.filter((s) => s === 'core'), ...TOOLSET_PRIORITY.filter((s) => s !== 'core' && opts.needs.has(s)), ...TOOLSET_PRIORITY.filter((s) => s !== 'core' && !opts.needs.has(s))]
  const whole: Toolset[] = []
  for (const set of order) {
    const members = bySet.get(set)
    if (!members) continue
    const add = members.filter((t) => !keep.has(t))
    if (keep.size + add.length <= cap) {
      for (const t of add) keep.add(t)
      whole.push(set)
    } else if (set === 'core') {
      // core is kept as far as it goes, even when it cannot all fit
      for (const t of add) if (keep.size < cap) keep.add(t)
    }
  }
  for (const set of order) for (const t of bySet.get(set) ?? []) if (keep.size < cap) keep.add(t)
  const leftOut = TOOLSET_PRIORITY.filter((s) => bySet.has(s) && !whole.includes(s))
  const partial = leftOut.flatMap((s) => {
    const members = bySet.get(s)!
    const n = members.filter((t) => keep.has(t)).length
    return n > 0 ? [{ toolset: s, sent: n, of: members.length }] : []
  })
  const sent = tools.filter((t) => keep.has(t))
  return { tools: sent, report: { cap, offered: tools.length, sent: sent.length, toolsets: whole, leftOut, partial, loader: null } }
}

/**
 * The tools a local model's turn sends on `surface`, of the `tools` it is offered, in their own order: the surface's
 * every-turn list (surfaces.ts), the app's own commands, every tool the chat already called, and the tools of each
 * toolset the turn needs (turnNeeds: its words, the plate's printer, the host's design tools). A core tool that is not
 * on the list joins no toolset, so a new one stays out until it is named there. A cloud model does not use this.
 */
export function localTurnTools<T extends SetTool>(surface: ToolSurface, tools: readonly T[], opts: { needs: ReadonlySet<Toolset>; called: ReadonlySet<string> }): T[] {
  return tools.filter((t) => {
    if (onEveryLocalTurn(surface, t.name) || t.command || opts.called.has(t.name)) return true
    const set = toolsetOf(t)
    return set !== 'core' && opts.needs.has(set)
  })
}

/** The tool a capped cloud request adds so the model can load a toolset that was left out. */
export const LOAD_TOOLS_TOOL = 'pilot.load_tools'

/** Each toolset as a person reads it, for the words mimir's chat shows (the keys are for the model and the code). */
export const TOOLSET_LABELS: Record<Exclude<Toolset, 'core'>, string> = {
  cad: 'design',
  settings: 'slicing and settings',
  printers: 'printer',
  project: 'project and plate',
  kb: 'knowledge base',
  mesh: 'mesh editing',
  cad_more: 'more design',
  calibration: 'calibration',
  fleets: 'fleet and schedule',
  skills: 'skill',
  theme: 'appearance',
  cloud: 'cloud account',
  local_ai: 'local model',
}

/** What each toolset holds, in the words pilot.load_tools uses. */
export const TOOLSET_WORDS: Record<Exclude<Toolset, 'core'>, string> = {
  cad: 'the design tools: sketches, solids, holes, fillets, the timeline',
  settings: 'slicing, print settings and profiles',
  printers: 'the printers: state, sending, pausing and canceling prints, spools, cameras, setup and the printer connectors',
  project: 'the project, its plates and files',
  kb: 'the knowledge base and lookups',
  mesh: 'plate mesh edits: cut, hollow, emboss, repair, paint',
  cad_more: 'more design tools: a rail of posts and a top bar along a line or a face edge, and the filament an existing part prints with',
  calibration: 'calibration prints',
  fleets: 'fleets and schedules',
  skills: 'connected apps and other skills',
  theme: "the app's look",
  cloud: 'cloud services',
  local_ai: 'local models',
}

/** The toolsets pilot.load_tools takes: every one but core, which always goes. */
export const LOADABLE_TOOLSETS = TOOLSET_PRIORITY.filter((s): s is Exclude<Toolset, 'core'> => s !== 'core') as [Exclude<Toolset, 'core'>, ...Exclude<Toolset, 'core'>[]]

/** What a chat's capped tool list remembers between requests. The runtime keeps one per chat. */
export interface StickyToolsets {
  /** The toolsets the chat's last request sent whole. */
  sets: Toolset[]
  /** For each toolset a tool was called from (or that was loaded), the last turn that happened and how many calls in all. */
  used: Map<Toolset, { turn: number; calls: number }>
  /** The chat's turn count; the turn going now while a run is going. */
  turn: number
  /** The toolsets a tool was called from, or that were loaded, in the last turn. These are never left out. */
  lastCalled: Set<Toolset>
  /** What the last turn's message needed. */
  lastNeeds: Set<Toolset>
  /** What mimir's last reply named: an offer ("want me to send it to the printer?") that a short "yes please" accepts. */
  lastOffer: Set<Toolset>
  /** The last turn's kind, and the tool names its last request carried: a next turn of the same kind sends them again. */
  lastKind?: TurnKind
  lastPick?: { names: Set<string>; sets: Toolset[]; report: ToolCapReport | null }
}

export function stickyToolsets(): StickyToolsets {
  return { sets: [], used: new Map(), turn: 0, lastCalled: new Set(), lastNeeds: new Set(), lastOffer: new Set() }
}

/**
 * The tools a capped cloud request sends, sticky per chat. Under the cap: every tool, in order, and no report. Over it
 * the request has room for cap - 1 tools and pilot.load_tools. It takes the union of what the chat wants: core, the
 * toolsets the last request sent whole, what this message needs, what mimir's last reply named, what the last message
 * needed, the toolsets of every tool the chat called, and `protect` (called from or loaded in the last turn or this
 * one). `loaded` (pilot.load_tools asked for it this turn) ranks above every other protected toolset, so it goes whole
 * first. While that is over the room, one toolset goes at a time, the least wanted first: never core or a protected one;
 * then a toolset nothing asks for, one only an older call asks for, one the last message needed, one the last reply
 * named, and one this message needs, in that order; among
 * those a toolset the last request did not send goes before one it sent, then the one called longest ago and least,
 * then the later one in TOOLSET_PRIORITY. Room left goes first to the wanted toolsets that went, whole where they fit and
 * then tool by tool, then to the other toolsets in priority order, whole and then tool by tool. Core goes first, then every tool the chat
 * already called. The same inputs give the same list, in the tools' own order.
 */
export function stickyCapTools<T extends SetTool>(
  tools: readonly T[],
  opts: { cap: number | undefined; needs: ReadonlySet<Toolset>; called: ReadonlySet<string>; protect: ReadonlySet<Toolset>; loaded?: ReadonlySet<Toolset>; state: Readonly<StickyToolsets>; kind?: TurnKind },
): { tools: T[]; sets: Toolset[]; report: ToolCapReport | null } {
  const bySet = new Map<Toolset, T[]>()
  for (const t of tools) {
    const set = toolsetOf(t)
    bySet.set(set, [...(bySet.get(set) ?? []), t])
  }
  const present = TOOLSET_PRIORITY.filter((s) => bySet.has(s))
  const cap = opts.cap
  if (cap === undefined || tools.length <= cap) return { tools: [...tools], sets: present, report: null }
  const room = cap - 1
  const st = opts.state
  const loaded = opts.loaded ?? new Set<Toolset>()
  const kept = (s: Toolset): boolean => opts.protect.has(s) || loaded.has(s)
  // a kind's own toolsets rank between protected and this message's needs; a mixed turn has none
  const kindSets: readonly Toolset[] = opts.kind && opts.kind !== 'mixed' ? KIND_SETS[opts.kind] : []
  const tier = (s: Toolset): number => (loaded.has(s) ? 6 : opts.protect.has(s) ? 5 : kindSets.includes(s) ? 4.5 : opts.needs.has(s) ? 4 : st.lastOffer.has(s) ? 3 : st.lastNeeds.has(s) ? 2 : st.used.has(s) ? 1 : 0)
  // a kind fills its own toolsets first, then the rest in TOOLSET_PRIORITY order
  const first: readonly Toolset[] = opts.kind && opts.kind !== 'mixed' ? KIND_FILL[opts.kind] : []
  const fillOrder = [...first, ...TOOLSET_PRIORITY.filter((s) => !first.includes(s))]
  const order = (s: Toolset): number => TOOLSET_PRIORITY.indexOf(s)
  // lower first: the toolset that goes first
  const key = (s: Toolset): number[] => [tier(s), st.sets.includes(s) ? 1 : 0, st.used.get(s)?.turn ?? -1, st.used.get(s)?.calls ?? 0, -order(s)]
  const less = (a: Toolset, b: Toolset): number => {
    const ka = key(a)
    const kb = key(b)
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i]! - kb[i]!
    return 0
  }
  const calledTools = tools.filter((t) => opts.called.has(t.name))
  const pins = pinnedFor(opts.kind)
  const pinned = tools.filter((t) => pins.has(t.name))
  const chosen = new Set<Toolset>(present.filter((s) => s === 'core' || st.sets.includes(s) || tier(s) > 0))
  const size = (sets: ReadonlySet<Toolset>): number => new Set([...pinned, ...calledTools, ...[...sets].flatMap((s) => bySet.get(s) ?? [])]).size
  const evicted: Toolset[] = []
  while (size(chosen) > room) {
    const out = [...chosen].filter((s) => s !== 'core' && !kept(s)).sort(less)[0]
    if (!out) break
    chosen.delete(out)
    evicted.push(out)
  }
  const keep = new Set<T>()
  const add = (list: readonly T[]): void => {
    for (const t of list) if (keep.size < room) keep.add(t)
  }
  // core first: a chat that called more tools than the room holds still keeps core; then the kind's pinned tools
  add(bySet.get('core') ?? [])
  add(pinned)
  add(calledTools)
  // most wanted first, so a chat whose protected toolsets alone are over the room keeps the most of them
  const whole = new Set<Toolset>(['core'])
  for (const s of [...chosen].filter((x) => x !== 'core').sort(less).reverse()) {
    const members = bySet.get(s)!
    const fits = keep.size + members.filter((t) => !keep.has(t)).length <= room
    add(members)
    if (fits) whole.add(s)
  }
  const wantedOut = evicted.filter((s) => tier(s) > 0).sort(less).reverse()
  const tryWhole = (s: Toolset): void => {
    const members = bySet.get(s)!
    if (keep.size + members.filter((t) => !keep.has(t)).length > room) return
    add(members)
    whole.add(s)
  }
  for (const s of wantedOut) tryWhole(s)
  for (const s of wantedOut) add(bySet.get(s)!)
  // the room left never goes to cad_more: its tools are asked for by name, so they come only when wanted or loaded
  const rest = fillOrder.filter((s) => bySet.has(s) && !whole.has(s) && s !== 'cad_more')
  for (const s of rest) tryWhole(s)
  for (const s of rest) add(bySet.get(s)!)
  const sets = present.filter((s) => whole.has(s) && (bySet.get(s) ?? []).every((t) => keep.has(t)))
  const leftOut = present.filter((s) => !sets.includes(s))
  const partial = leftOut.flatMap((s) => {
    const members = bySet.get(s)!
    const n = members.filter((t) => keep.has(t)).length
    return n > 0 ? [{ toolset: s, sent: n, of: members.length }] : []
  })
  const sent = tools.filter((t) => keep.has(t))
  return { tools: sent, sets, report: { cap, offered: tools.length, sent: sent.length + 1, toolsets: sets, leftOut, partial, loader: LOAD_TOOLS_TOOL } }
}

/**
 * Whether `set` can go whole on a capped request beside core, the tools the chat called and every `protect` toolset,
 * so loading it leaves out none of the tools just used.
 */
export function loadFits<T extends SetTool>(tools: readonly T[], opts: { cap: number | undefined; called: ReadonlySet<string>; protect: ReadonlySet<Toolset>; set: Toolset }): boolean {
  if (opts.cap === undefined) return true
  const goes = tools.filter((t) => {
    const s = toolsetOf(t)
    return opts.called.has(t.name) || s === 'core' || s === opts.set || opts.protect.has(s)
  })
  return goes.length <= opts.cap - 1
}

/** What pilot.load_tools needs from the turn it runs in. */
export interface LoadHooks {
  /** Takes the toolset for the next step. */
  load: (set: Toolset) => void
  /** Whether the toolset can go whole beside the ones just used (loadFits). */
  fits: (set: Toolset) => boolean
  /** The toolsets loaded this turn that a request already carried. */
  loaded: ReadonlySet<Toolset>
  /** The toolsets asked for that the next step takes. */
  queued: () => ReadonlySet<Toolset>
}

/**
 * pilot.load_tools for a capped request: its description names what `report` left out, and `hooks.load` takes the
 * toolset the model asks for, which comes whole with its next step (stickyCapTools fills it first). A toolset this
 * request already sends whole, one asked for in this step, or one this chat does not have, is answered as such and
 * nothing changes. A toolset that cannot go whole beside the ones just used is refused, and so is a second load of one
 * that still went only in part, so mimir never reads "Loaded" for tools it does not get.
 */
export function loadToolsTool(report: ToolCapReport, hooks: LoadHooks): PilotTool<never> {
  const out = report.leftOut.map((s) => {
    const p = report.partial.find((x) => x.toolset === s)
    return p ? `${s} (${p.sent} of ${p.of} tools sent)` : s
  })
  const offered = new Set<Toolset>([...report.toolsets, ...report.leftOut])
  return defineTool({
    name: LOAD_TOOLS_TOOL,
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    toolset: 'core',
    description: `Load a toolset that was left out of your tools to stay under the provider's tool limit. Its tools come whole with your next step; others may be left out to make room, never the ones you used last, and a toolset that cannot fit beside those is refused. Left out now: ${out.join(', ') || 'none'}. Toolsets: ${LOADABLE_TOOLSETS.map((s) => `${s}: ${TOOLSET_WORDS[s]}`).join('; ')}.`,
    input: z.object({ toolset: z.enum(LOADABLE_TOOLSETS) }),
    args: (i) => TOOLSET_LABELS[i.toolset],
    async run(i) {
      if (!offered.has(i.toolset)) return { ok: false, summary: `This chat has no ${TOOLSET_LABELS[i.toolset]} tools`, output: { loaded: null, toolset: i.toolset } }
      if (report.toolsets.includes(i.toolset)) return { summary: `The ${TOOLSET_LABELS[i.toolset]} tools are already loaded`, output: { loaded: i.toolset, already: true } }
      if (hooks.queued().has(i.toolset)) return { summary: `The ${TOOLSET_LABELS[i.toolset]} tools come with the next step`, output: { loaded: i.toolset, already: true } }
      if (hooks.loaded.has(i.toolset)) return { ok: false, summary: `The ${TOOLSET_LABELS[i.toolset]} tools were loaded once and still went only in part`, output: { loaded: null, toolset: i.toolset, reason: 'partial' } }
      if (!hooks.fits(i.toolset)) return { ok: false, summary: `No room for the ${TOOLSET_LABELS[i.toolset]} tools without leaving out tools you just used`, output: { loaded: null, toolset: i.toolset, reason: 'no_room' } }
      hooks.load(i.toolset)
      return { summary: `Loaded the ${TOOLSET_LABELS[i.toolset]} tools for the next step`, output: { loaded: i.toolset, already: false } }
    },
  }) as PilotTool<never>
}
