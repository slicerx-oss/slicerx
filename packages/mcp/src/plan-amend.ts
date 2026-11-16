// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A build that finds a planned size it cannot keep asks to change the approved plan: design.plan with amends shows
// the person the plan with the changed sizes, the old value beside each, and the build's reason, and waits for Go, as
// a new plan does; design.put_plan with amends changes a client's own plan. An amend changes sizes and what a planned
// feature stands on (its on), and may add features, keeping every planned one, and gives every other field as the plan
// has it (amendDropProblem); a build's
// amend comes once per fix round, never after the round is over, and never buys a second round: the plan keeps its
// failed checks under the same planId, and its revision goes up by one. While the fix round is open, a build's amend
// adds no feature (FIX_ROUND_ADDS). A change the person asked for (asked) goes in
// with no card and is not held to the fix round (tab-tools.ts).
import type { PartPlan, PlanEntry, PlanOrigin } from './design-check'

/** The longest reason an amend takes. */
export const AMEND_REASON_MAX = 200

/** A size an amend changes, in the plan's units. */
export interface AmendChange {
  where: 'feature' | 'overall' | 'hole'
  /** The feature it belongs to; null for the overall size or a row of holes. */
  feature: string | null
  /** The size's key, x, y or z for the overall size, or the hole row's name for a row of holes. */
  size: string
  from: number
  to: number
}

type Sized = Pick<PartPlan, 'part' | 'units' | 'features' | 'overall' | 'holes' | 'openFaces'>

const sameKeys = (a: object, b: object): boolean => {
  const ka = Object.keys(a).sort()
  const kb = Object.keys(b).sort()
  return ka.length === kb.length && ka.every((k, i) => k === kb[i])
}

/** The problems an amend check found, as one refusal: each in its own words, joined as a plan refusal joins its own. */
const joined = (problems: readonly string[]): string | null => (problems.length ? problems.join('. ') : null)

/**
 * What keeps `next` from being an amend of `old`, or null: an amend keeps the part, its units, every planned feature
 * (name, kind, the sizes it has and what each measures, in order, with features it adds anywhere among them under new
 * names), whether it has an overall size, and each row of holes (name and count), and its open faces. Only the numbers
 * change, and features may be added. Every mismatch is named at once, so a plan resent with three fields off is fixed
 * in one round, not three.
 */
export function amendShapeProblem(old: Sized, next: Sized, o: { asked?: boolean } = {}): string | null {
  const only = 'an amend changes sizes and on only'
  const out: string[] = []
  if (next.part !== old.part) out.push(`part: ${only}; the part stays "${old.part}"`)
  if (next.units !== old.units) out.push(`units: ${only}; the plan stays in ${old.units}`)
  const kept = keptFeatures(old, next)
  if (!kept) out.push(`features: an amend keeps every planned feature, in order, and may add features under new names; the plan has ${old.features.map((f) => f.name).join(', ')}`)
  // a change the person asked for may change how a planned feature is made (its kind and the sizes that drive it)
  else if (!o.asked)
    for (const [i, j] of kept.entries()) {
      const f = next.features[j]!
      const was = old.features[i]!
      if ((f.kind ?? '') !== (was.kind ?? '')) out.push(`features: ${only}; feature ${i + 1} stays "${was.name}"`)
      if (!sameKeys(f.sizes, was.sizes)) out.push(`features: ${only}; ${was.name} keeps the sizes ${Object.keys(was.sizes).join(', ') || 'it has (none)'}`)
      if (JSON.stringify(Object.entries(f.kinds ?? {}).sort()) !== JSON.stringify(Object.entries(was.kinds ?? {}).sort())) out.push(`features: ${only}; ${was.name} keeps its kinds`)
    }
  out.push(...amendRestProblems(old, next))
  return joined(out)
}

/**
 * The plan's fields amendRestProblems holds an amend to: whether it has an overall size, its rows of holes by name and
 * count, and its open faces as they are. None of them can be dropped by an amend, so one left out is the plan's own.
 */
export const AMEND_PINNED = ['overall', 'holes', 'openFaces'] as const

/** The rest of amendShapeProblem: the overall size, the rows of holes and the open faces stay as they are. */
function amendRestProblems(old: Sized, next: Sized): string[] {
  const only = 'an amend changes sizes and on only'
  const out: string[] = []
  if (Boolean(next.overall) !== Boolean(old.overall)) out.push(`overall: ${only}; ${old.overall ? 'keep' : 'leave out'} the overall size`)
  const nh = next.holes ?? []
  const oh = old.holes ?? []
  if (nh.length !== oh.length || nh.some((h, i) => h.name !== oh[i]!.name || (h.count ?? 1) !== (oh[i]!.count ?? 1))) out.push(`holes: ${only}; the plan keeps its rows of holes, by name and count`)
  if (JSON.stringify(next.openFaces ?? null) !== JSON.stringify(old.openFaces ?? null)) out.push(`openFaces: ${only}; ${old.openFaces ? 'the plan keeps its openFaces as they are' : 'leave out openFaces'}`)
  return out
}

/**
 * Where each of `old`'s features is in `next` (index in next, by old index), or null when one is missing or out of
 * order. The features in between are the ones `next` adds; none of them may take a planned feature's name.
 */
function keptFeatures(old: Sized, next: Sized): number[] | null {
  const at: number[] = []
  let j = 0
  for (const o of old.features) {
    while (j < next.features.length && next.features[j]!.name !== o.name) j++
    if (j >= next.features.length) return null
    at.push(j++)
  }
  const names = new Set(old.features.map((f) => f.name))
  if (next.features.some((f, k) => !at.includes(k) && names.has(f.name))) return null
  return at
}

/**
 * The plan's fields an amend leaves as they are (amendedSizes keeps the plan's own): one the amend gives otherwise is
 * refused. The assumptions and questions are left out, since the card adds lines of its own to them and an amend may
 * say them again in other words; they stay as they are too.
 */
const KEPT_FIELDS = ['printInPlace', 'detail', 'curved', 'flat', 'proportions', 'repeats', 'colors', 'scale', 'real', 'tiers', 'ends'] as const

/** A value with its object keys in order, and a scale as its number N, so the same value written another way is the same. */
function canonical(v: unknown, key?: string): unknown {
  if (key === 'scale' && typeof v === 'string') return Number(v.split(':').pop())
  if (Array.isArray(v)) return v.map((x) => canonical(x))
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, x]) => [k, canonical(x)]))
  return v
}
const same = (a: unknown, b: unknown, key?: string): boolean => JSON.stringify(canonical(a, key)) === JSON.stringify(canonical(b, key))

/**
 * What an amend changes that amendedSizes would not keep, or null: a row of holes' recess, or a plan field among
 * KEPT_FIELDS that it gives otherwise, each one named. A field it leaves out of the plan stays as it is; recess is given
 * with its row, as a feature's kinds are. Without this, the change would be dropped while the amend reports the plan
 * changed. A planned feature's on is kept by amendedSizes (amendOns), so the part is held to what it now stands on.
 */
export function amendDropProblem(old: Sized, next: Sized, opts: { fields?: boolean } = {}): string | null {
  const only = 'an amend changes sizes and on only'
  const out: string[] = []
  for (const [i, h] of (old.holes ?? []).entries()) {
    const n = next.holes?.[i]
    if (n && (n.recess ?? false) !== (h.recess ?? false)) out.push(`holes: ${only}; ${h.name} ${h.recess ? 'keeps recess: true' : 'takes no recess'}`)
  }
  const o = old as unknown as Record<string, unknown>
  const n = next as unknown as Record<string, unknown>
  // design.plan names the plan fields it leaves as they are (amendBody); a client's amend has them refused
  for (const k of opts.fields === false ? [] : KEPT_FIELDS) {
    if (n[k] === undefined || same(n[k], o[k], k)) continue
    out.push(`${k}: ${only}; ${o[k] === undefined ? `leave out ${k}` : `the plan keeps ${k}: ${JSON.stringify(o[k])}`}`)
  }
  return joined(out)
}

/** One size an amend changes by name: a planned feature's size, the overall size's x, y or z, or a row of holes' diameter. */
export interface SizeChange {
  feature: string
  size: string
  to: number
}

/** What design.plan takes with amends: the plan fields it may send, and the changes and features it adds. */
export type AmendSent = { [K in keyof Sized]?: Sized[K] | undefined } & { changes?: readonly SizeChange[] | undefined; add?: readonly PartPlan['features'][number][] | undefined }

/**
 * The plan fields design.plan's amend leaves as the approved plan has them, whatever it sends: the ones amendedSizes
 * keeps, and the part's name. One sent otherwise is named in the result, not refused, so a plan resent whole with a
 * field put another way still changes its sizes. The person's size flag is read by a first plan's check only and is
 * never kept, so it is left out without a word.
 */
export const AMEND_IGNORED = [...KEPT_FIELDS, 'part'] as const

const sameName = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase()
const OVERALL_AXES: Record<string, 'x' | 'y' | 'z'> = { x: 'x', y: 'y', z: 'z', width: 'x', depth: 'y', height: 'z' }

/**
 * The plan an amend of `was` sends, as the amend checks read it: the approved plan's part, and its units, features,
 * overall size, rows of holes and open faces wherever the amend leaves them out; then the features in `add` after the
 * planned ones, and each size in `changes` set on it. `problems` names each change that sets no planned size;
 * `ignored` names each field in AMEND_IGNORED the amend sent otherwise than the plan has it.
 */
export function amendBody(was: PartPlan, sent: AmendSent): { next: Sized; problems: string[]; ignored: string[] } {
  const features = structuredClone([...(sent.features ?? was.features), ...(sent.add ?? [])])
  const next: Sized = {
    part: was.part,
    units: sent.units ?? was.units,
    features,
    ...Object.fromEntries(AMEND_PINNED.flatMap((k) => (sent[k] !== undefined ? [[k, structuredClone(sent[k])]] : was[k] !== undefined ? [[k, structuredClone(was[k])]] : []))),
  }
  const problems: string[] = []
  for (const c of sent.changes ?? []) {
    const f = features.find((x) => sameName(x.name, c.feature))
    if (f) {
      const key = Object.keys(f.sizes).find((k) => sameName(k, c.size))
      if (key) f.sizes[key] = c.to
      else problems.push(`changes: ${f.name} has no size named ${c.size}; change one of its sizes (${Object.keys(f.sizes).join(', ')})`)
      continue
    }
    const axis = OVERALL_AXES[c.size.trim().toLowerCase()]
    if (sameName(c.feature, 'overall') && next.overall && axis) {
      next.overall = { ...next.overall, [axis]: c.to }
      continue
    }
    const row = next.holes?.find((h) => sameName(h.name, c.feature))
    if (row && /^(diameter|d)$/i.test(c.size.trim())) {
      row.diameter = c.to
      continue
    }
    problems.push(`changes: ${c.feature} is not a planned feature, the overall size or a row of holes; name one the plan has (${[...features.map((x) => x.name), ...(next.overall ? ['overall'] : []), ...(next.holes ?? []).map((h) => h.name)].join(', ')})`)
  }
  const o = was as unknown as Record<string, unknown>
  const n = sent as unknown as Record<string, unknown>
  const ignored = AMEND_IGNORED.filter((k) => n[k] !== undefined && !same(n[k], o[k], k))
  return { next, problems, ignored }
}

/** What the result says of the fields an amend sent that it left as the plan has them. */
export const IGNORED_NOTE = (fields: readonly string[]): string =>
  `Ignored ${fields.length > 1 ? `${fields.slice(0, -1).join(', ')} and ${fields.at(-1)!}` : fields[0]!}: an amend changes sizes and on only, so the plan keeps ${fields.length === 1 ? 'it' : 'them'} as approved`

/**
 * The planned features whose on `next` changes, by name, in order: each one restated with an on other than the plan's.
 * A feature restated without an on keeps the plan's (amendedSizes).
 */
export function amendOns(old: Sized, next: Sized): string[] {
  return old.features.flatMap((f) => {
    const n = next.features.find((x) => x.name === f.name)
    return n?.on !== undefined && n.on.trim() !== '' && n.on.trim().toLowerCase() !== (f.on ?? '').trim().toLowerCase() ? [f.name] : []
  })
}

/** The features `next` adds to `old` (amendShapeProblem says it is an amend), by name, in order. */
export function amendAdded(old: Sized, next: Sized): string[] {
  const names = new Set(old.features.map((f) => f.name))
  return next.features.filter((f) => !names.has(f.name)).map((f) => f.name)
}

/** The planned features whose kind `next` changes, as "Tray made by loft, not extrude". */
export function amendKinds(old: Sized, next: Sized): string[] {
  return old.features.flatMap((f) => {
    const n = next.features.find((x) => x.name === f.name)
    return n && (n.kind ?? '') !== (f.kind ?? '') ? [`${f.name} made by ${n.kind ?? 'another feature'}, not ${f.kind ?? 'what it was'}`] : []
  })
}

/** The planned features `next` moves onto another, as "Deck on Piers, not Base plate". */
export function amendOnsText(old: Sized, next: Sized): string[] {
  return old.features.flatMap((f) => {
    const n = next.features.find((x) => x.name === f.name) as { on?: string } | undefined
    const [was, now] = [(f as { on?: string }).on?.trim() ?? '', n?.on?.trim() ?? '']
    return n && now && now.toLowerCase() !== was.toLowerCase() ? [`${f.name} on ${now}, not ${was || 'what it stood on'}`] : []
  })
}

/**
 * `old` with the sizes of `next`, the on of each feature it moves onto another (amendOns), and the features it adds
 * (amendShapeProblem says it is an amend, amendDropProblem that it changes nothing this leaves out): its assumptions
 * and questions, and every other field, stay as they are. A planned feature restated without an on keeps its own.
 */
export function amendedSizes<P extends PartPlan>(old: P, next: Sized): P {
  const out = structuredClone(old)
  const was = new Map(out.features.map((f) => [f.name, f]))
  const moved = new Set(amendOns(old, next))
  out.features = next.features.map((f) => {
    const o = was.get(f.name)
    return o ? { ...o, kind: f.kind ?? o.kind, sizes: { ...f.sizes }, ...(f.kinds ? { kinds: { ...f.kinds } } : {}), ...(moved.has(f.name) ? { on: f.on!.trim() } : {}) } : structuredClone(f)
  })
  if (out.overall && next.overall) out.overall = { ...next.overall }
  if (out.holes && next.holes) out.holes = out.holes.map((h, i) => ({ ...h, diameter: next.holes![i]!.diameter }))
  return out
}

/** Each size that differs between two plans of one shape. */
export function amendChanges(old: Sized, next: Sized): AmendChange[] {
  const out: AmendChange[] = []
  for (const f of old.features) {
    const n = next.features.find((x) => x.name === f.name)
    if (!n) continue
    for (const [k, v] of Object.entries(f.sizes)) {
      const to = n.sizes[k]
      if (to !== undefined && to !== v) out.push({ where: 'feature', feature: f.name, size: k, from: v, to })
    }
  }
  if (old.overall && next.overall) for (const a of ['x', 'y', 'z'] as const) if (old.overall[a] !== next.overall[a]) out.push({ where: 'overall', feature: null, size: a, from: old.overall[a], to: next.overall[a] })
  for (const [i, h] of (old.holes ?? []).entries()) {
    const to = next.holes![i]!.diameter
    if (to !== h.diameter) out.push({ where: 'hole', feature: null, size: h.name, from: h.diameter, to })
  }
  return out
}

/**
 * Why the plan kept as `entry` cannot be amended now by a plan of `origin`, or null: there is no such plan of that
 * origin; it was set aside (the person changed sizes on a sheet since it was approved); its part is not built yet (no
 * design is tied to it); its fix round is over (closed); or it was amended once already in this fix round (no check
 * has failed since).
 */
export function amendProblem(planId: string, entry: PlanEntry | undefined, origin: PlanOrigin): string | null {
  if (!entry || entry.origin !== origin) return `amends: there is no ${origin === 'card' ? 'plan the person approved' : 'plan of yours'} with planId ${planId}`
  if (entry.stale || entry.superseded) return 'amends: the person changed sizes since that plan was approved; make a new plan with the sizes they set'
  if (!entry.design) return `amends: the plan's part is not built yet; build to the plan, or ${origin === 'card' ? 'make a new plan' : 'put the plan again'}`
  if (entry.closed) return 'amends: the plan has used its fix round; stop and tell the person exactly what is off'
  if (entry.amendedAt === (entry.failedChecks ?? 0)) return 'amends: the plan was changed once already since its last failed check; build to it as changed'
  return null
}

/**
 * The refusal for a build's amend that adds features while its plan's fix round is open (fixRoundIsOpen). The fix
 * round is for the items the check failed, and a feature added then is one more the next check needs a step for, which
 * nothing in the round builds; a planned feature built on another one moves there with its on instead.
 */
export const FIX_ROUND_ADDS = (added: readonly string[]): string =>
  `add: the plan's fix round is open, and an amend in it adds no feature, since ${added.length > 1 ? `${added.slice(0, -1).join(', ')} and ${added.at(-1)!} would be more features` : `${added[0]!} would be one more feature`} the check needs a step tagged with its name for; fix the failed items on the part as planned, and for a planned feature built on another planned one, send the features with its on changed and no add`

/** The reason an amend gives, trimmed; a ToolInputError message when it is missing or empty. */
export function amendReason(reason: string | undefined): { why: string } | { problem: string } {
  const why = reason?.trim() ?? ''
  if (!why) return { problem: 'reason: say why the build changes the plan, in a sentence the person reads on the card' }
  if (why.length > AMEND_REASON_MAX) return { problem: `reason: at most ${AMEND_REASON_MAX} characters` }
  return { why }
}

const r3 = (v: number): number => Math.round(v * 1000) / 1000
const AXIS_WORD = { x: 'width', y: 'depth', z: 'height' } as const

/** A changed size in plain words: "Hinge clearance 0.3 mm to 0.4 mm", "Overall height 30 mm to 34 mm", "Vent diameter 3 mm to 3.4 mm". */
export function changeText(c: AmendChange, units: 'mm' | 'in'): string {
  const words = (k: string): string => k.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_\-.]+/g, ' ').toLowerCase()
  const name = c.where === 'overall' ? `Overall ${AXIS_WORD[c.size as 'x']}` : c.where === 'hole' ? `${c.size} diameter` : `${c.feature} ${words(c.size)}`
  return `${name} ${r3(c.from)} ${units} to ${r3(c.to)} ${units}`
}
