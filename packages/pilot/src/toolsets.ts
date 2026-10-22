// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Which toolsets a turn sends when a provider takes fewer tools than mimir has. OpenAI-style APIs refuse a request
// with more than 128 tools, so over that cap a turn sends the core tools, every tool the chat already called and the
// toolsets the turn needs, then the other toolsets by a fixed priority while they fit whole; the room left goes to the
// first toolsets in that order that did not fit, tool by tool. The toolsets left out are reported. Under the cap every
// tool goes, in the same order, exactly as before.
import type { PilotContext } from '@slicerx/contracts'
import { toolGroupOf } from './surfaces'
import type { PilotTool, Toolset } from './tool'

/**
 * The order toolsets are kept in when they do not all fit, first kept first. Core is never traded away. The design
 * tools come next because the mimir tab builds parts with them, then preparing and slicing a plate, the printers, the
 * project, the knowledge base, plate mesh edits, calibration, fleets, and what connected apps and other skills add.
 */
export const TOOLSET_PRIORITY: readonly Toolset[] = ['core', 'cad', 'settings', 'printers', 'project', 'kb', 'mesh', 'calibration', 'fleets', 'skills', 'theme', 'cloud', 'local_ai']

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

/** Words in a request that say which toolsets it needs. */
const NEEDS: readonly [Toolset, RegExp][] = [
  ['cad', /\b(design|model|part|sketch|extrude|fillet|chamfer|hole|bracket|hook|box|lid|gear|thread|build|make|draw|cad)\w*/i],
  ['settings', /\b(slice|slicing|setting|profile|layer|infill|support|wall|brim|raft|speed|temperature|temp|nozzle|orient|arrange|estimate|strength|strong|quality|filament)\w*/i],
  ['printers', /\b(print|printer|send|queue|job|spool|ams|camera|pause|resume|cancel|bed|plug)\w*/i],
  ['project', /\b(project|plate|open|file|export|save|stl|3mf|step)\w*/i],
  ['kb', /\b(why|how|which|recommend|best|troubleshoot|problem|issue|string|warp|clog|look up|source)\w*/i],
  ['mesh', /\b(mesh|repair|hollow|emboss|cut|split|paint|color|colour)\w*/i],
  ['calibration', /\bcalibrat\w*/i],
  ['fleets', /\b(fleet|farm|schedule|overnight|tonight)\w*/i],
  ['theme', /\b(theme|look|dark mode|light mode)\b/i],
]

/**
 * The toolsets a turn needs besides core: the tab's own (the design tools, where the host gives them), what the request
 * asks for, and what the plate holds (a printer it is assigned to, objects on it). Used only when tools must be left out.
 */
export function turnNeeds(message: string, opts: { designs?: boolean; context?: PilotContext } = {}): Set<Toolset> {
  const needs = new Set<Toolset>()
  if (opts.designs) needs.add('cad')
  for (const [set, words] of NEEDS) if (words.test(message)) needs.add(set)
  if (opts.context?.printerId) needs.add('printers')
  if (opts.context?.objects?.length) needs.add('project')
  return needs
}

/** What a turn sent when tools were left out: the cap, how many tools there were and went, and the toolsets in and out. */
export interface ToolCapReport {
  cap: number
  offered: number
  sent: number
  /** Toolsets sent whole, in the order they were taken. */
  toolsets: Toolset[]
  /** Toolsets with tools left out, in priority order. A tool the chat already called still goes. */
  leftOut: Toolset[]
  /** Of leftOut, the toolsets that still sent some of their tools, with how many of how many. */
  partial: { toolset: Toolset; sent: number; of: number }[]
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
  return { tools: sent, report: { cap, offered: tools.length, sent: sent.length, toolsets: whole, leftOut, partial } }
}
