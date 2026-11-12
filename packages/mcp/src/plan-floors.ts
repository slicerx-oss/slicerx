// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A plan's sizes against the smallest sizes the printer makes, before anything is built. The floors are the ones the
// rest of the app holds a part to: the thinnest wall is two nozzle lines (design.check's minimum wall), the smallest
// hole is the nozzle (the hole tools' customHoleProblem), and the gaps moving pieces printed in place need are the fit
// rule's (fit-facts.ts fitLimits, the limits design.check holds a print-in-place part to) for the nozzle, its layer
// height and the material. A pin is a solid as thin as its diameter, so it is held to the wall floor. design.plan
// raises a size under its floor on the card with a line saying why, so the plan the person approves is one the build
// can match; design.put_plan names such sizes and keeps the plan as the client gave it.
import { customHoleProblem } from '@slicerx/cad-history'
import { kindOf } from '@slicerx/contracts/size-kind'
import { gapWay, HEDGE_WORDS, keyWords, minWallFor, printsTogether, saysSeparately, type FitLimits, type PartPlan } from './design-check'
import { fitLimits, type FitProfile } from './fit-facts'

const MM_PER_IN = 25.4
/** The longest line a plan's assumptions take (partPlanSchema), and how many it keeps. */
const LINE_MAX = 200
const LINES_MAX = 12

/** The smallest sizes this printer makes, in mm, and the profile they are for. */
export interface PlanFloors {
  nozzleMm: number
  layerHeightMm: number
  material: string
  /** The thinnest wall, and the thinnest pin. */
  wallMm: number
  /** The smallest hole. */
  holeMm: number
  /** The smallest gap between moving pieces printed in place, side by side and above or below. */
  gapSideMm: number
  gapVerticalMm: number
}

const r3 = (v: number): number => Math.round(v * 1000) / 1000

/**
 * The floors for a print profile (the nozzle, 0.4 mm; its layer height, half the nozzle; the material, PLA), or for the
 * fit limits a run already worked out (runFitLimits), so the plan's gaps are held to the ones design.check reads.
 */
export function planFloors(p: FitProfile | FitLimits = {}): PlanFloors {
  const l = 'sideMm' in p ? p : fitLimits(p)
  return {
    nozzleMm: l.nozzleMm,
    layerHeightMm: l.layerHeightMm,
    material: l.material,
    wallMm: r3(minWallFor(l.nozzleMm)),
    // the hole tools refuse a hole narrower than the nozzle (customHoleProblem)
    holeMm: l.nozzleMm,
    gapSideMm: l.sideMm,
    gapVerticalMm: l.verticalMm,
  }
}

const UNIT_WORDS: ReadonlySet<string> = new Set(['mm', 'cm', 'in', 'inch', 'inches'])
const HOLE_WORDS: ReadonlySet<string> = new Set(['hole', 'holes', 'bore', 'bores'])
const PIN_WORDS: ReadonlySet<string> = new Set(['pin', 'pins', 'rod', 'axle', 'peg', 'shaft', 'dowel'])
/** The last word of a size that is a hole's or a pin's diameter: hole_diameter, pin_d, hinge_pin, axle. */
const ACROSS_WORDS: ReadonlySet<string> = new Set(['diameter', 'dia', 'd', 'size', 'width', 'thickness'])
/** The last word of a size that is a wall's thickness: wall, wall_thickness, lid_thickness, shell, floor. */
const WALL_HEADS: ReadonlySet<string> = new Set(['wall', 'walls', 'shell', 'thickness', 'floor'])

/** What kind of floor a size has by its name, or null for one with none (a length, a height, a count). */
export type FloorWhat = 'gap' | 'hole' | 'pin' | 'wall'

function floorWhat(key: string): FloorWhat | null {
  if (gapWay(key)) return 'gap'
  const words = keyWords(key)
  while (words.length > 1 && UNIT_WORDS.has(words.at(-1)!)) words.pop()
  const last = words.at(-1)
  if (!last) return null
  if (words.some((w) => HOLE_WORDS.has(w))) return HOLE_WORDS.has(last) || ACROSS_WORDS.has(last) || last === 'clearance' ? 'hole' : null
  if (words.some((w) => PIN_WORDS.has(w))) return PIN_WORDS.has(last) || ACROSS_WORDS.has(last) ? 'pin' : null
  return WALL_HEADS.has(last) ? 'wall' : null
}

/**
 * Printing in place, as a plan states it: print in place, printed in place, prints assembled, captive, articulated or
 * flexi pieces. A hinge alone says nothing of the kind: its lid and pin may print beside the box.
 */
const IN_PLACE = /\bprint(?:s|ed|ing)?[\s-]+in[\s-]+place\b|\bprint(?:s|ed|ing)?\s+(?:fully\s+)?assembled\b|\barticulated\b|\bflexi\b|\bcaptive\b/i

type FloorPlan = Pick<PartPlan, 'part' | 'units' | 'features' | 'holes' | 'assumptions' | 'printInPlace'>

/**
 * Whether a plan's pieces print in place, so a gap above or below them has that floor: printInPlace names its pieces,
 * its pieces print together without it (printsTogether, design.check's reading), or its part, a feature's name or kind,
 * or an assumption states print in place, printed assembled, captive, articulated or flexi pieces and neither its part
 * nor an assumption says the pieces print separately. printInPlace false says they do not. Its questions are not read,
 * since a question states nothing yet. In any other plan, a gap around a hinge or a pin (printed apart) keeps the side
 * by side floor, and any other gap (a lid's lip, a lid that slides on) is the person's to pick, so it is left alone.
 */
export function printsInPlace(plan: FloorPlan & { questions?: readonly string[] }): boolean {
  if (plan.printInPlace === false) return false
  if (plan.printInPlace || printsTogether(plan)) return true
  const said = [plan.part, ...plan.features.flatMap((f) => [f.name, f.kind ?? '']), ...plan.assumptions]
  if (!said.some((t) => IN_PLACE.test(t))) return false
  return ![plan.part, ...plan.assumptions].some(saysSeparately)
}

/** A planned size under its floor: where it is, what it is, the size planned and the floor, both in the plan's units. */
export interface UnderFloor {
  /** The feature it belongs to, or null for a row of the plan's holes. */
  feature: string | null
  /** The size's key, or "diameter" for a row of holes. */
  size: string
  /** The hole row's name, for a row of holes. */
  hole?: string
  what: FloorWhat
  planned: number
  floor: number
  /** Why that is the floor, in plain words: "the smallest gap for parts printed in place with a 0.4 mm nozzle in PLA". */
  why: string
  /** For a gap beside a pin: the pin's diameter and the bore it gives at the floor (the pin plus the gap on each side). */
  pin?: number
  bore?: number
}

const mmText = (v: number): string => `${r3(v)} mm`

/** The floor in the plan's units: in mm as it is, in inches rounded up to a thousandth so it never lands under. */
const inUnits = (mm: number, units: 'mm' | 'in'): number => (units === 'in' ? Math.ceil((mm / MM_PER_IN) * 1000 - 1e-6) / 1000 : r3(mm))

function why(what: FloorWhat, f: PlanFloors, gap?: 'z' | 'in place' | 'apart'): string {
  const nozzle = `a ${mmText(f.nozzleMm)} nozzle`
  const parts = gap === 'z' ? 'above or below parts printed in place' : gap === 'in place' ? 'for parts printed in place' : 'for parts printed side by side'
  if (what === 'gap') return `the smallest gap ${parts} with ${nozzle} in ${f.material.length <= 5 ? f.material.toUpperCase() : f.material}`
  if (what === 'hole') return `the smallest hole ${nozzle} prints`
  if (what === 'pin') return `the thinnest pin ${nozzle} prints (two lines)`
  return `the thinnest wall ${nozzle} prints (two lines)`
}

/** A hinge or a pin in a plan: its part or a feature names a hinge, or a feature has a pin size. */
const HINGE = /\bhinge[sd]?\b/i
function hasJoint(plan: FloorPlan): boolean {
  return HINGE.test(plan.part) || plan.features.some((f) => HINGE.test(f.name) || Object.keys(f.sizes).some((k) => floorWhat(k) === 'pin'))
}

/** What a hinged plan that says neither how its lid prints is told: the refusal design.plan gives, and put_plan's note. */
export const LID_STATEMENT = 'say whether the lid prints assembled on its hinge (its pieces named in printInPlace) or laid apart beside the box (in an assumption)'

/** What a hinged plan that says both is told: the refusal design.plan gives, and put_plan's note. */
export const LID_ONE_WAY = 'say one way the lid prints, assembled on its hinge or laid apart beside the box; the plan says both, in its assumptions'

/**
 * What a plan that names its pieces in printInPlace and lays one apart is told: a piece that prints in place prints on
 * its hinge, and only a lid put on after printing is laid apart.
 */
export const LID_ON_HINGE =
  'a lid that prints in place prints on its hinge: open flat on the shared hinge axis, its knuckles between the base\'s, or closed on the base; lay it apart (10 mm from the base) only when it is put on after printing, and then leave it out of printInPlace'

/** Pieces laid apart from each other on the bed, beyond a gap: laid or printed apart, or 2 mm or more apart. */
const APART_ONLY = /\blaid\s+apart\b|\bprint(?:s|ed|ing)?\s+apart\b/i
function setApart(text: string): boolean {
  if (APART_ONLY.test(text)) return true
  for (const m of text.matchAll(MM_APART)) if (Number(m[1]) >= 2) return true
  return false
}

/**
 * Printing apart, as a plan states it: laid out apart (beside the base or each other, laid apart or out, printed apart,
 * pieces 2 mm or more apart) or printed separately (not hedged), to be put together after. Printed flat or laid flat
 * says how a part lies on the bed, not that its pieces lie apart (a flexi fish printed flat on the bed prints in place),
 * and a gap's few tenths of a millimeter apart, or pieces printed in place as separate bodies, are no such statement.
 * A plan whose printInPlace names its pieces prints them assembled: a lid opened flat beside its box on the hinge is
 * no layout apart there, while pieces laid or printed apart, or 2 mm or more apart, are (LID_ON_HINGE).
 */
const APART_WORDS = /\bbeside\s+(?:the|each|it|its)\b|\blaid\s+(?:apart|out)\b|\bprint(?:s|ed|ing)?\s+apart\b/i
const SEPARATE = /\bseparately\b/gi
const MM_APART = /(\d+(?:\.\d+)?)\s*mm\s+apart\b/gi

/** The pieces laid out apart on the bed: beside, laid apart or out, printed apart, 2 mm or more apart. */
function laidApart(text: string): boolean {
  if (APART_WORDS.test(text)) return true
  for (const m of text.matchAll(MM_APART)) if (Number(m[1]) >= 2) return true
  return false
}

/** The pieces printed separately, to be put together after; "could be printed separately" says nothing. */
function printedSeparately(text: string): boolean {
  for (const m of text.toLowerCase().matchAll(SEPARATE)) {
    const before = text.toLowerCase().slice(0, m.index).split(/\s+/).filter(Boolean).slice(-3)
    if (!before.some((w) => HEDGE_WORDS.has(w) || /n['\u2019]t$/.test(w))) return true
  }
  return false
}

/** A lid in a plan's part or a feature's name: a pin piece turns in one only beside a lid. */
const LID = /\blid(?:s|ded)?\b/i

/**
 * What a plan with a hinge or a pin of its own (its part or a feature names a hinge, or a feature is named as a pin,
 * rod, axle, shaft or dowel and its part or a feature names a lid) leaves the build to guess about how it prints. A pin
 * piece with no hinge and no lid is a solid part of the build (a cable hook's rod, a stand's axle), with nothing to print
 * assembled or apart. LID_STATEMENT when it says neither in place
 * (printsInPlace, which reads printInPlace too) nor apart (printInPlace false, or its part or an assumption says the
 * pieces print separately or, unless printInPlace names them, are laid out apart), LID_ONE_WAY when it says both,
 * LID_ON_HINGE when printInPlace names its pieces and the plan lays them apart (laid or printed apart, or 2 mm or more
 * apart), else null.
 */
export function jointProblem(plan: FloorPlan): string | null {
  const named = (re: RegExp) => re.test(plan.part) || plan.features.some((f) => re.test(f.name))
  const pinPiece = plan.features.some((f) => keyWords(f.name).some((w) => PIN_WORDS.has(w) && w !== 'peg'))
  if (!named(HINGE) && !(pinPiece && named(LID))) return null
  const assembled = printsInPlace(plan)
  // with its pieces named in printInPlace, a plan laid out apart prints open on its hinges; printed separately still
  // contradicts it
  const listed = Array.isArray(plan.printInPlace)
  const apart = plan.printInPlace === false || [plan.part, ...plan.assumptions].some((t) => printedSeparately(t) || (!listed && laidApart(t)))
  if (assembled && apart) return LID_ONE_WAY
  if (!assembled && !apart) return LID_STATEMENT
  // pieces that print in place print on their hinge: never laid apart from each other
  if (listed && [plan.part, ...plan.assumptions].some(setApart)) return LID_ON_HINGE
  return null
}

/** True when a hinge or pin plan says neither how it prints (jointProblem gives LID_STATEMENT). */
export const unstatedJoint = (plan: FloorPlan): boolean => jointProblem(plan) === LID_STATEMENT

/** The diameter of the pin a gap in `f` runs around: a pin size of the same feature, else the plan's first; raised to its floor. */
function pinOf(plan: FloorPlan, f: FloorPlan['features'][number], floors: PlanFloors): number | undefined {
  const pins = (g: FloorPlan['features'][number]) => Object.entries(g.sizes).filter(([k]) => kindOf(k, g.kinds?.[k]) === 'length' && floorWhat(k) === 'pin')
  const hit = pins(f)[0] ?? plan.features.flatMap(pins)[0]
  return hit ? Math.max(hit[1], inUnits(floors.wallMm, plan.units)) : undefined
}

/** A hole the hole tools would refuse as too small for the nozzle. */
const holeTooSmall = (mm: number, f: PlanFloors): boolean => customHoleProblem(mm + 1e-6, f.nozzleMm) !== null

/**
 * Each length in a plan under the printer's floor for it: a gap between pieces that print in place (printsInPlace), a
 * wall or a pin under two nozzle lines, a hole under the nozzle (the plan's holes and sizes named as a hole's diameter).
 * A size its kinds entry calls a count or an angle has no floor. Inch plans are held in mm and the floors given back in
 * inches.
 */
export function underFloors(plan: FloorPlan, floors: PlanFloors): UnderFloor[] {
  const scale = plan.units === 'in' ? MM_PER_IN : 1
  const inPlace = printsInPlace(plan)
  const joint = inPlace || hasJoint(plan)
  const out: UnderFloor[] = []
  for (const f of plan.features) {
    for (const [key, v] of Object.entries(f.sizes)) {
      if (kindOf(key, f.kinds?.[key]) !== 'length') continue
      const what = floorWhat(key)
      if (!what || (what === 'gap' && !joint)) continue
      // pieces printed apart keep the side by side floor; printed in place, a gap named no way is on every face
      const way = what === 'gap' ? gapWay(key)! : undefined
      const z = inPlace && (way === 'z' || (way === 'both' && floors.gapVerticalMm >= floors.gapSideMm))
      const needMm = what === 'gap' ? (z ? floors.gapVerticalMm : floors.gapSideMm) : what === 'hole' ? floors.holeMm : floors.wallMm
      if (what === 'hole' ? !holeTooSmall(v * scale, floors) : v * scale >= needMm - 1e-6) continue
      const floor = inUnits(needMm, plan.units)
      const gap = what === 'gap' ? (z ? (way === 'z' ? 'z' : 'in place') : inPlace ? 'in place' : 'apart') : undefined
      const u: UnderFloor = { feature: f.name, size: key, what, planned: v, floor, why: why(what, floors, gap) }
      // a gap beside a pin is a bore: give the bore it makes, so the build cuts a number rather than reading a gap
      const pin = what === 'gap' && way !== 'z' ? pinOf(plan, f, floors) : undefined
      if (pin !== undefined) Object.assign(u, { pin, bore: r3(pin + 2 * floor) })
      out.push(u)
    }
  }
  for (const h of plan.holes ?? []) {
    if (!holeTooSmall(h.diameter * scale, floors)) continue
    out.push({ feature: null, size: 'diameter', hole: h.name, what: 'hole', planned: h.diameter, floor: inUnits(floors.holeMm, plan.units), why: why('hole', floors) })
  }
  return out
}

/** A size by name, in plain words: "Hinge pin gap", "Vent hole diameter". */
export function underName(u: UnderFloor): string {
  return u.feature === null ? `${u.hole} ${u.size}` : `${u.feature} ${keyWords(u.size).join(' ')}`
}

const sized = (v: number, units: 'mm' | 'in'): string => `${r3(v)} ${units}`

/** A gap's floor as the build reads it: "0.4 mm on each side (2 mm pin, 2.8 mm bore)"; any other floor as a size. */
export function floorText(u: UnderFloor, units: 'mm' | 'in'): string {
  if (u.what !== 'gap') return sized(u.floor, units)
  return `${sized(u.floor, units)} on each side${u.bore !== undefined ? ` (${sized(u.pin!, units)} pin, ${sized(u.bore, units)} bore)` : ''}`
}

/** One line for the card: "Hinge gap raised from 0.3 mm to 0.4 mm on each side (2 mm pin, 2.8 mm bore), the smallest gap ...". */
export function raisedLine(u: UnderFloor, units: 'mm' | 'in'): string {
  const line = `${underName(u)} raised from ${sized(u.planned, units)} to ${floorText(u, units)}, ${u.why}.`
  return line.length <= LINE_MAX ? line : `${line.slice(0, LINE_MAX - 1)}…`
}

/** The same size in a short sentence for a result: "Hinge pin gap 0.3 mm is under the 0.4 mm this printer needs (...)". */
export function underLine(u: UnderFloor, units: 'mm' | 'in'): string {
  return `${underName(u)} ${sized(u.planned, units)}${u.what === 'gap' ? ' on each side' : ''} is under the ${floorText(u, units)} this printer needs (${u.why})`
}

const esc = (v: string): string => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * A line of the plan with a raised gap's old value, where it names it as a gap ("0.3 mm clearance", "clearance of 0.3
 * mm", "gap: 0.3 mm"), put as the new one on each side with the bore: "0.4 mm clearance on each side (2.8 mm bore)".
 * The same number as anything else (a 0.3 mm chamfer) is left alone, and so is a line that would grow past 200
 * characters.
 */
function restated(line: string, u: UnderFloor, units: 'mm' | 'in'): string {
  const old = esc(String(r3(u.planned)))
  const bore = u.bore !== undefined ? ` (${sized(u.bore, units)} bore)` : ''
  const now = `${r3(u.floor)} ${units}`
  const out = line
    .replace(new RegExp(`(?<![\\d.])${old}\\s*${units}(\\s+(per[- ]side\\s+)?(?:clearance|gap|play))\\b`, 'i'), (_m, word: string, per?: string) => `${now}${word}${per ? '' : ' on each side'}${bore}`)
    .replace(new RegExp(`\\b(clearance|gap|play)(\\s+of\\s+|\\s*:\\s*|\\s+)${old}\\s*${units}(?![\\w.])`, 'i'), (_m, word: string, sep: string) => `${word}${sep}${now} on each side${bore}`)
  return out.length <= LINE_MAX ? out : line
}

/**
 * The plan with every size under its floor raised to the floor, and a line per raised size first among its
 * assumptions, saying from what to what and why. When the lines do not fit beside the plan's own assumptions (12 at
 * most), one line names every raised size; with no room at all the card shows the raised sizes alone and the result
 * says why. A plan with nothing under its floors comes back as it is.
 */
export function raiseToFloors<P extends FloorPlan>(plan: P, floors: PlanFloors): { plan: P; raised: UnderFloor[] } {
  const raised = underFloors(plan, floors)
  if (!raised.length) return { plan, raised }
  const next = structuredClone(plan)
  for (const u of raised) {
    if (u.feature === null) {
      const h = next.holes?.find((x) => x.name === u.hole && x.diameter === u.planned)
      if (h) h.diameter = u.floor
      continue
    }
    const f = next.features.find((x) => x.name === u.feature && x.sizes[u.size] === u.planned)
    if (f) f.sizes[u.size] = u.floor
  }
  // the plan's own lines that name a raised gap's old value say the new one, so nothing the build reads says the old gap
  next.assumptions = next.assumptions.map((a) => raised.reduce((t, u) => (u.what === 'gap' ? restated(t, u, plan.units) : t), a))
  const room = LINES_MAX - next.assumptions.length
  let lines = raised.map((u) => raisedLine(u, plan.units))
  if (lines.length > room) {
    const all = `Raised to this printer's smallest sizes: ${raised.map((u) => `${underName(u)} ${floorText(u, plan.units)}`).join(', ')}.`
    lines = room > 0 ? [all.length <= LINE_MAX ? all : `${all.slice(0, LINE_MAX - 1)}…`] : []
  }
  next.assumptions = [...lines, ...next.assumptions]
  return { plan: next, raised }
}
