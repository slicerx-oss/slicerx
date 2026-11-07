// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// An object's layer height profile (layer_height_profile) as other slicers' project files keep it: one line per object,
// `object_id=N|z;h;z;h;...`, N counting the file's objects from 1, each pair a height above the object's bottom and the
// layer height there in mm, the curve straight between pairs. Written with semicolons as those files are; read with
// semicolons, commas or spaces between the numbers. The reader and writer the app and the MCP server share.

/** Where a project keeps the profiles; the second is the older name some files still use. */
export const LAYER_HEIGHTS_PART = 'Metadata/layer_heights_profile.txt'
export const LAYER_HEIGHTS_PARTS = [LAYER_HEIGHTS_PART, 'Metadata/Slic3r_PE_layer_heights_profile.txt'] as const

/** Pairs a profile line may hold before the rest is cut. */
const MAX_PAIRS = 100_000

const f = (n: number) => {
  const r = Number(n.toFixed(4))
  return Object.is(r, -0) ? '0' : String(r)
}

/** The layer height a profile gives at `z`: straight lines between pairs, the end pairs' heights past either end. */
function heightAt(points: readonly (readonly [number, number])[], z: number): number {
  if (z <= points[0]![0]) return points[0]![1]
  for (let i = 1; i < points.length; i++) {
    const [z1, h1] = points[i]!
    if (z <= z1) {
      const [z0, h0] = points[i - 1]!
      return z1 === z0 ? h1 : h0 + ((h1 - h0) * (z - z0)) / (z1 - z0)
    }
  }
  return points[points.length - 1]![1]
}

/**
 * One object's profile as a file line: the plate's curve from the object's bottom (`bottomMm`) to its top (`topMm`),
 * both above the bed, written from 0 to the object's height. It starts at 0 and ends at the object's height exactly,
 * since readers drop a profile that does not end at the top of its object. Null for an empty curve or a flat object.
 */
export function profileLine(objectNo: number, points: readonly (readonly [number, number])[], bottomMm: number, topMm: number): string | null {
  const height = topMm - bottomMm
  if (!points.length || !(height > 0)) return null
  const pairs: [number, number][] = [[0, heightAt(points, bottomMm)]]
  for (const [z, h] of points) if (z - bottomMm > 1e-4 && z - bottomMm < height - 1e-4) pairs.push([z - bottomMm, h])
  pairs.push([height, heightAt(points, topMm)])
  return `object_id=${objectNo}|${pairs.map(([z, h]) => `${f(z)};${f(h)}`).join(';')}`
}

/** The file part for the lines, or null when there are none. */
export function layerHeightsText(lines: readonly string[]): string | null {
  return lines.length ? `${lines.join('\n')}\n` : null
}

/**
 * The profiles in a file part, by object number from 1, as [z, h] pairs in the order the file gives them. Untrusted:
 * a line that is not `object_id=N|` and numbers is skipped, a pair with a number that is not finite is dropped, an odd
 * number at the end is dropped, and huge lines are cut. Limits on the heights are the caller's (the printer's).
 */
export function readLayerHeights(text: string): Map<number, [number, number][]> {
  const out = new Map<number, [number, number][]>()
  for (const line of text.split(/\r?\n/)) {
    const bar = line.indexOf('|')
    const m = /^object_id=(\d+)$/.exec(bar < 0 ? '' : line.slice(0, bar).trim())
    if (!m) continue
    const nums = line.slice(bar + 1).split(/[;,\s]+/).filter((t) => t !== '').map(Number)
    const pairs: [number, number][] = []
    for (let i = 0; i + 1 < nums.length && pairs.length < MAX_PAIRS; i += 2) {
      const z = nums[i]!
      const h = nums[i + 1]!
      if (Number.isFinite(z) && Number.isFinite(h)) pairs.push([z, h])
    }
    if (pairs.length) out.set(Number(m[1]), pairs)
  }
  return out
}
