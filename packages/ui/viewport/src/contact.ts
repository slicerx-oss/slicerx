// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// heimdall's contact box: the region of a part a picked strike hits, hatched in the hit color over the model and the
// toolpaths, edged by a light line on a dark halo, both a fixed width in screen pixels, so it reads on any toolpath color
// and either theme. It sits where the strike marks sit (the engine's coordinates), never moves or pulses, and shows only
// while its strike is picked.
import { BoxGeometry, Color, EdgesGeometry, Group, Mesh, ShaderMaterial } from 'three'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js'

/** The smallest side drawn, mm: one crossing on one layer is a point, and still has to show. */
export const CONTACT_MIN_MM = 1.5

/**
 * The box's look. Widths and the stripe period are screen pixels (CSS px; the drawing buffer's pixel ratio scales
 * them). The halo is the strike marks' dark outline and the line a near white, so the edge holds against any feature
 * color; the stripes take the hit color.
 */
export const CONTACT_STYLE = {
  halo: '#15161c',
  line: '#fff4f4',
  haloPx: 5,
  linePx: 2,
  stripePx: 6,
  /** Opacity of the hit-colored stripes and of the gaps between them. */
  stripeAlpha: 0.62,
  gapAlpha: 0.12,
} as const

const HATCH_VS = /* glsl */ `
void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

// Diagonal stripes fixed to the screen: the same pitch at any zoom, and nothing moves.
const HATCH_FS = /* glsl */ `
uniform vec3 uColor;
uniform float uPeriod;
uniform float uOn;
uniform float uOff;
void main() {
  float t = fract((gl_FragCoord.x + gl_FragCoord.y) / uPeriod);
  float a = mix(uOff, uOn, step(0.5, t));
  gl_FragColor = vec4(uColor, a);
}
`

export interface ContactRegion {
  min: readonly [number, number, number]
  max: readonly [number, number, number]
}

export class ContactBox {
  readonly root = new Group()
  private readonly box = new Group()
  private readonly geometry = new BoxGeometry(1, 1, 1)
  private readonly edges = new LineSegmentsGeometry().fromEdgesGeometry(new EdgesGeometry(this.geometry))
  private readonly fillMat = new ShaderMaterial({
    vertexShader: HATCH_VS,
    fragmentShader: HATCH_FS,
    uniforms: { uColor: { value: new Color('#ff4b5c') }, uPeriod: { value: CONTACT_STYLE.stripePx }, uOn: { value: CONTACT_STYLE.stripeAlpha }, uOff: { value: CONTACT_STYLE.gapAlpha } },
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  })
  private readonly haloMat = new LineMaterial({ color: new Color(CONTACT_STYLE.halo), linewidth: CONTACT_STYLE.haloPx, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false, toneMapped: false })
  private readonly lineMat = new LineMaterial({ color: new Color(CONTACT_STYLE.line), linewidth: CONTACT_STYLE.linePx, depthTest: false, depthWrite: false, toneMapped: false })

  constructor() {
    this.root.name = 'contact'
    this.root.visible = false
    this.box.name = 'contact box'
    const fill = new Mesh(this.geometry, this.fillMat)
    fill.name = 'contact fill'
    // In front of the toolpaths and the strike marks' rings: nothing it sits in hides it.
    fill.renderOrder = 9
    const halo = new LineSegments2(this.edges, this.haloMat)
    halo.name = 'contact halo'
    halo.renderOrder = 10
    const line = new LineSegments2(this.edges, this.lineMat)
    line.name = 'contact edge'
    line.renderOrder = 11
    this.box.add(fill, halo, line)
    this.root.add(this.box)
    this.setResolution(1024, 768, 1)
  }

  /** The hit color (the theme's red for strikes) of the stripes. */
  setColor(hex: string): void {
    ;(this.fillMat.uniforms['uColor']!.value as Color).set(hex)
  }

  /** The drawing buffer's size and pixel ratio, so the edge and the stripes keep their width in screen pixels. */
  setResolution(width: number, height: number, pixelRatio: number): void {
    for (const m of [this.haloMat, this.lineMat]) m.resolution.set(width, height)
    this.haloMat.linewidth = CONTACT_STYLE.haloPx * pixelRatio
    this.lineMat.linewidth = CONTACT_STYLE.linePx * pixelRatio
    this.fillMat.uniforms['uPeriod']!.value = CONTACT_STYLE.stripePx * pixelRatio
  }

  /** Fills `region`, mm; null hides it. */
  set(region: ContactRegion | null): void {
    if (!region) {
      this.root.visible = false
      return
    }
    const size = [0, 1, 2].map((i) => Math.max(CONTACT_MIN_MM, region.max[i]! - region.min[i]!))
    this.box.position.set(...([0, 1, 2].map((i) => (region.min[i]! + region.max[i]!) / 2) as [number, number, number]))
    this.box.scale.set(size[0]!, size[1]!, size[2]!)
    this.root.visible = true
  }

  dispose(): void {
    this.geometry.dispose()
    this.edges.dispose()
    this.fillMat.dispose()
    this.haloMat.dispose()
    this.lineMat.dispose()
  }
}
