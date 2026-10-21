// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The objects a sliced Bambu Lab G-code file labels, with the rectangle each one's extrusions cover: the 3MF writer's
// plate_N.json and the printer page's skip list read them.

/** One object of a plate as the hub keeps it for printers that cannot list objects (Bambu Lab). */
export interface PlateObject { id: string; name: string; skipped: false; polygon: [number, number][] }

/**
 * The objects a Bambu Lab G-code file labels (`; start printing object, unique label id: N` before
 * `M624`), each with the rectangle its extrusions cover, so the hub can offer skipping them. Names come
 * from the comment labels when the file has them. Empty for files without Bambu object labels.
 */
export function plateObjectsFromGcode(text: string): PlateObject[] {
  if (!text.includes('unique label id:')) return []
  const boxes = new Map<number, [number, number, number, number]>()
  const names = new Map<number, string>()
  // The engine's files list their ids from 1 in a header line (the id the printer's skip dialog uses); Orca's older files count from 0.
  const firstId = /^; model label id: /m.test(text) ? 1 : 0
  let cur: number | null = null
  let x = NaN
  let y = NaN
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line.startsWith(';')) {
      const start = /^; start printing object, unique label id: (\d+)/.exec(line)
      if (start) cur = Number(start[1])
      else if (line.startsWith('; stop printing object, unique label id:')) cur = null
      else {
        const named = /^; printing object (.+) id:(\d+) copy \d+/.exec(line)
        if (named && !names.has(Number(named[2]))) names.set(Number(named[2]), named[1]!)
      }
      continue
    }
    if (!/^G[0-3] /.test(line)) continue
    const word = (l: string) => {
      const m = new RegExp(`\\b${l}(-?[\\d.]+)`).exec(line.split(';')[0]!)
      return m ? Number(m[1]) : undefined
    }
    const [px, py] = [x, y]
    x = word('X') ?? x
    y = word('Y') ?? y
    const e = word('E')
    if (cur === null || e === undefined || e <= 0) continue
    // An extrusion covers the line from where the head was to where it goes.
    for (const [qx, qy] of [[px, py], [x, y]] as const) {
      if (!Number.isFinite(qx) || !Number.isFinite(qy)) continue
      const b = boxes.get(cur)
      boxes.set(cur, b ? [Math.min(b[0], qx), Math.min(b[1], qy), Math.max(b[2], qx), Math.max(b[3], qy)] : [qx, qy, qx, qy])
    }
  }
  return [...boxes.entries()]
    .sort(([a], [b]) => a - b)
    .slice(0, 256)
    .map(([id, [x0, y0, x1, y1]]) => ({
      id: String(id),
      name: names.get(id)?.replace(/_id_\d+_copy_\d+$/, '').replace(/\.stl$/i, '').replace(/_/g, ' ') ?? `Object ${id + 1 - firstId}`,
      skipped: false as const,
      polygon: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]],
    }))
}
