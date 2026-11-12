// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The connected pieces of a mesh as it is held outside the geometry engine: triangles that share a corner, by vertex
// number or by place, are one piece. Places are welded to 1 micrometer, so a triangle soup (an STL's corners, each
// triangle with its own three) still connects. This is the one copy: splitting a part into pieces in the app, a file's
// separate bodies on the MCP server and the pieces of an added part a lean turns each about its own foot all use it.

/** The connected pieces of a mesh (meshPieces). */
export interface MeshPieces {
  /** Each piece's triangle numbers (triangle t is indices 3t to 3t + 2), in the order of each piece's first triangle. */
  triangles: number[][]
  /**
   * Each piece's vertex numbers, in the order of each piece's lowest vertex. A vertex no triangle uses and that shares
   * its place with no other vertex is a piece of its own here, and in no triangle list.
   */
  vertices(): number[][]
}

/** A vertex's place, welded to 1 micrometer. */
function place(p: ArrayLike<number>, v: number): string {
  return `${Math.round((p[v * 3] ?? 0) * 1000)},${Math.round((p[v * 3 + 1] ?? 0) * 1000)},${Math.round((p[v * 3 + 2] ?? 0) * 1000)}`
}

/**
 * The connected pieces of a mesh: `positions` three numbers per vertex, `indices` three vertex numbers per triangle.
 * Without `indices` the positions are a triangle soup, nine numbers per triangle.
 */
export function meshPieces(positions: ArrayLike<number>, indices?: ArrayLike<number>): MeshPieces {
  const n = Math.floor(positions.length / 3)
  const corners = indices ? indices.length : 3 * Math.floor(positions.length / 9)
  const corner = indices ? (i: number) => indices[i]! : (i: number) => i
  const root = new Int32Array(n)
  for (let v = 0; v < n; v++) root[v] = v
  const find = (a: number): number => {
    while (root[a] !== a) a = root[a] = root[root[a]!]!
    return a
  }
  const join = (a: number, b: number): void => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) root[rb] = ra
  }
  const seen = new Map<string, number>()
  for (let v = 0; v < n; v++) {
    const key = place(positions, v)
    const first = seen.get(key)
    if (first === undefined) seen.set(key, v)
    else join(first, v)
  }
  for (let t = 0; t + 2 < corners; t += 3) {
    const a = corner(t)
    join(a, corner(t + 1))
    join(a, corner(t + 2))
  }
  const triangles = new Map<number, number[]>()
  for (let t = 0; t + 2 < corners; t += 3) {
    const r = find(corner(t))
    const list = triangles.get(r)
    if (list) list.push(t / 3)
    else triangles.set(r, [t / 3])
  }
  return {
    triangles: [...triangles.values()],
    vertices: () => {
      const byRoot = new Map<number, number[]>()
      for (let v = 0; v < n; v++) {
        const r = find(v)
        const list = byRoot.get(r)
        if (list) list.push(v)
        else byRoot.set(r, [v])
      }
      return [...byRoot.values()]
    },
  }
}
