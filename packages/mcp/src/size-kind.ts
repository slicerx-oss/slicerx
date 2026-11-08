// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What a planned size measures, read from its key: a count (teeth, segments, the number of holes), an angle (a draft,
// a twist, a lean) or, by default, a length in the plan's units. The plan card, the sizes sheet and design.check read
// sizes through it, so a count never shows in mm, an inch plan never converts a count or an angle, and a count or an
// angle is never held to a size of the body.

export type SizeKind = 'count' | 'angle' | 'length'

/** Words that make a key an angle wherever they stand in it ("lean_deg", "twist_degrees"). */
const ANGLE_UNITS = new Set(['deg', 'degs', 'degree', 'degrees'])
/** Words that make a key a length wherever they stand in it ("count_mm" is a length in mm). */
const LENGTH_UNITS = new Set(['mm', 'cm', 'in', 'inch', 'inches', 'millimeter', 'millimeters'])
/** The last word of a count's key: "count", "segment_count", "num_teeth", "spokes". */
const COUNT_HEADS = new Set([
  'count', 'counts', 'number', 'num', 'nb', 'n', 'qty', 'quantity', 'teeth', 'segments', 'sides', 'copies', 'instances', 'repeats',
  'rows', 'columns', 'cols', 'spokes', 'ribs', 'fins', 'slots', 'holes', 'pins', 'posts', 'legs', 'arms', 'blades', 'lobes', 'petals',
  'starts', 'turns', 'coils', 'loops', 'steps', 'levels', 'layers', 'pieces', 'parts', 'divisions', 'sections', 'links', 'facets',
  'grooves', 'notches', 'tabs', 'cells', 'rungs', 'bars', 'magnets', 'screws',
])
/** The first word of a count's key: "n_holes", "number_of_teeth", "count_x". */
const COUNT_LEADS = new Set(['count', 'number', 'num', 'nb', 'n', 'qty', 'quantity'])
/** The last word of an angle's key: "angle", "draft", "helix_angle". */
const ANGLE_HEADS = new Set(['angle', 'angles', 'draft', 'twist', 'tilt', 'lean', 'incline', 'inclination', 'rotation'])
/** The first word of an angle's key: "angle_step". */
const ANGLE_LEADS = new Set(['angle'])

/** A key's words, lower case: "numberOfTeeth" is number, of, teeth; "angle_deg" is angle, deg. */
function words(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

/**
 * What a size measures, from its key. A degree word anywhere makes it an angle and a length unit a length; otherwise
 * its last word, then its first, says count or angle ("tooth_height" ends in a length, so it is one). Anything else is
 * a length.
 */
export function sizeKind(key: string): SizeKind {
  const w = words(key)
  if (!w.length) return 'length'
  if (w.some((x) => ANGLE_UNITS.has(x))) return 'angle'
  if (w.some((x) => LENGTH_UNITS.has(x))) return 'length'
  const head = w.at(-1)!
  if (COUNT_HEADS.has(head)) return 'count'
  if (ANGLE_HEADS.has(head)) return 'angle'
  if (w.length > 1 && COUNT_LEADS.has(w[0]!)) return 'count'
  if (w.length > 1 && ANGLE_LEADS.has(w[0]!)) return 'angle'
  return 'length'
}

/** The unit a size of this kind shows with: none for a count, ° for an angle, else the plan's units. */
export function sizeUnit(kind: SizeKind, units: 'mm' | 'in'): '' | '°' | 'mm' | 'in' {
  return kind === 'count' ? '' : kind === 'angle' ? '°' : units
}

/** A size as it reads: "4" for a count, "30°" for an angle, "80 mm" or "3.5 in" for a length. */
export function sizeText(kind: SizeKind, value: number, units: 'mm' | 'in'): string {
  const unit = sizeUnit(kind, units)
  return unit === '' ? String(value) : unit === '°' ? `${value}°` : `${value} ${unit}`
}

/** The key to name a size by: an angle's key without the degree word it ends in, since its unit says it ("angle_deg" is "angle"). */
export function sizeLabelKey(key: string): string {
  if (sizeKind(key) !== 'angle') return key
  const bare = key.replace(/(?:[_\-.\s]+(?:deg|degs|degrees?)|(?<=[a-z0-9])(?:Deg|Degs|Degrees?))$/, '')
  return bare && bare !== key ? bare : key
}
