// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The gantry heimdall checks: in bed coordinates a beam along x across the whole bed, at the nozzle's y and the
// profile's rod height above the tip (`extruder_clearance_height_to_rod`), as deep as the rod's distance either side
// (`extruder_clearance_dist_to_rod`). Drawn translucent with the moving head; where it runs through a part the
// engine reported a gantry strike on, that stretch is drawn in the strike color. On a bed slinger (A1, A1 mini, the
// i3 family) two uprights stand at the beam's ends, so the frame reads as one that moves with the head in bed
// coordinates.
import { BoxGeometry, Color, Group, Mesh, MeshBasicMaterial } from 'three'

export interface GantrySpec {
  /** The beam's underside above the nozzle tip, mm. */
  rod: number
  /** How far the beam reaches either side of the nozzle in y, mm. */
  reach: number
  /** The bed it spans, mm. */
  width: number
  /** The bed moves in y and the frame's uprights carry the beam: drawn beside the bed at the beam's ends. */
  slinger: boolean
}

/** A gantry strike: the layers it happens on (0-based, both ends included) and the box of the part it runs through. */
export interface GantryHit {
  layers: [number, number]
  /** `[x0, y0, x1, y1]`, mm, and the part's top. */
  box: [number, number, number, number]
  top: number
}

/** How tall the beam is drawn, mm; the check needs only its underside. */
const BEAM = 12
/** The uprights: their width, and how far beside the bed they stand, mm. */
const POST = 14
const SIDE = 22

export class GantryRig {
  readonly root = new Group()
  private readonly unit = new BoxGeometry(1, 1, 1)
  private readonly beamMat = new MeshBasicMaterial({ color: new Color('#c6cbe0'), transparent: true, opacity: 0.16, depthWrite: false })
  private readonly frameMat = new MeshBasicMaterial({ color: new Color('#8f95ab'), transparent: true, opacity: 0.32, depthWrite: false })
  private readonly hitMat = new MeshBasicMaterial({ color: new Color('#ff4b5c'), transparent: true, opacity: 0.6, depthWrite: false })
  private readonly beam = new Mesh(this.unit, this.beamMat)
  private readonly posts = [new Mesh(this.unit, this.frameMat), new Mesh(this.unit, this.frameMat)]
  private readonly hot: Mesh[] = []
  private spec: GantrySpec | null = null
  private hits: readonly GantryHit[] = []

  constructor() {
    this.root.name = 'gantry'
    this.root.renderOrder = 9
    this.beam.name = 'beam'
    this.posts.forEach((p, i) => (p.name = `upright ${i}`))
    this.root.add(this.beam, ...this.posts)
    this.root.visible = false
  }

  setSpec(spec: GantrySpec | null): void {
    this.spec = spec && spec.rod > 0 && spec.width > 0 ? spec : null
    if (!this.spec) this.root.visible = false
  }

  setHits(hits: readonly GantryHit[] | null): void {
    this.hits = hits ?? []
  }

  /** The strike color, the theme's overhang red. */
  setColor(hit: string): void {
    this.hitMat.color.set(hit)
  }

  /** True when a gantry strike happens on `layer`: the beam then shows even with the head hidden. */
  striking(layer: number): boolean {
    return this.hits.some((h) => layer >= h.layers[0] && layer <= h.layers[1])
  }

  /** Shows the beam over the nozzle at `y`, `z` on `layer`, or hides it. Returns the stretches drawn as hits. */
  place(show: boolean, y: number, z: number, layer: number): number {
    const s = this.spec
    this.root.visible = show && !!s
    if (!s || !show) return 0
    const z0 = z + s.rod
    const [y0, y1] = [y - s.reach, y + s.reach]
    const x0 = s.slinger ? -SIDE : 0
    const x1 = s.slinger ? s.width + SIDE : s.width
    box(this.beam, x0, x1, y0, y1, z0, z0 + BEAM)
    for (const [i, p] of this.posts.entries()) {
      p.visible = s.slinger
      const x = i === 0 ? x0 - POST : x1
      box(p, x, x + POST, y - POST / 2, y + POST / 2, 0, z0 + BEAM)
    }
    let n = 0
    for (const h of this.hits) {
      if (layer < h.layers[0] || layer > h.layers[1] || h.top <= z0) continue
      const ya = Math.max(y0, h.box[1])
      const yb = Math.min(y1, h.box[3])
      if (yb <= ya) continue
      const m = this.hot[n] ?? this.addHot()
      m.visible = true
      // A hair larger than the beam, so the red stretch shows over it.
      box(m, h.box[0], h.box[2], ya - 0.5, yb + 0.5, z0 - 0.5, Math.min(z0 + BEAM, h.top) + 0.5)
      n++
    }
    for (let i = n; i < this.hot.length; i++) this.hot[i]!.visible = false
    return n
  }

  private addHot(): Mesh {
    const m = new Mesh(this.unit, this.hitMat)
    m.name = `hit ${this.hot.length}`
    this.hot.push(m)
    this.root.add(m)
    return m
  }

  dispose(): void {
    this.unit.dispose()
    this.beamMat.dispose()
    this.frameMat.dispose()
    this.hitMat.dispose()
  }
}

function box(m: Mesh, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): void {
  m.scale.set(Math.max(1e-3, x1 - x0), Math.max(1e-3, y1 - y0), Math.max(1e-3, z1 - z0))
  m.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2)
}
