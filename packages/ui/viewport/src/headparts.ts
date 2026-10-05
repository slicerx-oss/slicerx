// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Materials and solid-building helpers shared by the toolhead models (toolhead.ts, heads.ts). Sizes in mm.
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { BoxGeometry, Color, CylinderGeometry, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, SphereGeometry, TorusGeometry, type BufferGeometry, type Material } from 'three'

// Colors: the machines' own (brushed silver, black anodized, Snapmaker white and orange), with the app's
// tokens where the machine leaves a choice: --orange for the hot plate and lever, --cyan for the ring at
// the nozzle, the light strips white.
export const brass = new MeshStandardMaterial({ color: new Color('#d9b98a'), metalness: 0.9, roughness: 0.28 })
export const steel = new MeshStandardMaterial({ color: new Color('#b4b9c6'), metalness: 0.85, roughness: 0.3 })
export const silver = new MeshStandardMaterial({ color: new Color('#a3a6ae'), metalness: 0.7, roughness: 0.34 })
export const black = new MeshStandardMaterial({ color: new Color('#34363f'), metalness: 0.35, roughness: 0.5 })
export const deep = new MeshStandardMaterial({ color: new Color('#1d1e24'), metalness: 0.2, roughness: 0.6 })
export const sock = new MeshStandardMaterial({ color: new Color('#4a4c56'), metalness: 0.05, roughness: 0.8 })
export const white = new MeshStandardMaterial({ color: new Color('#e6e6ea'), metalness: 0.05, roughness: 0.42 })
export const graphite = new MeshStandardMaterial({ color: new Color('#44475a'), metalness: 0.35, roughness: 0.45 })
export const dark = new MeshStandardMaterial({ color: new Color('#2f3241'), metalness: 0.2, roughness: 0.6 })
export const orange = new MeshBasicMaterial({ color: new Color('#fab570') })
export const prusaOrange = new MeshStandardMaterial({ color: new Color('#f26b21'), metalness: 0.05, roughness: 0.55 })
export const amber = new MeshStandardMaterial({ color: new Color('#f5a623'), metalness: 0.1, roughness: 0.4 })
export const lightMat = new MeshBasicMaterial({ color: new Color('#f4f6ff') })
export const ringMat = new MeshBasicMaterial({ color: new Color('#8be9fd') })
export const tipMat = new MeshBasicMaterial({ color: new Color('#fff2c4') })

export const part = (geo: BufferGeometry, mat: Material, x: number, y: number, z: number, name = ''): Mesh => {
  const m = new Mesh(geo, mat)
  m.position.set(x, y, z)
  m.name = name
  return m
}
export const block = (w: number, d: number, h: number, r = 0.6) => new RoundedBoxGeometry(w, d, h, 3, r)
/** A box from its extents. */
export const slab = (mat: Material, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, name: string, r = 0): Mesh =>
  part(r > 0 ? block(x1 - x0, y1 - y0, z1 - z0, r) : new BoxGeometry(x1 - x0, y1 - y0, z1 - z0), mat, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, name)
/** A cylinder standing on z (three's cylinders stand on y). */
export const post = (r: number, h: number, seg = 32) => new CylinderGeometry(r, r, h, seg).rotateX(Math.PI / 2)

export function ring(g: Group): void {
  const r = new Mesh(new TorusGeometry(2.3, 0.22, 8, 32), ringMat)
  r.position.z = 2.1
  const tip = new Mesh(new SphereGeometry(0.4, 12, 10), tipMat)
  tip.position.z = 0.15
  g.add(r, tip)
}

/** The hot plate on a Bambu front: a black square with three orange heat waves over a short bar. */
export function hotPlate(x: number, y: number, z: number): Group {
  const g = new Group()
  g.add(slab(deep, -6, 6, -0.6, 0, -6, 6, 'plate'))
  for (const dx of [-2.2, 0, 2.2]) g.add(slab(orange, dx - 0.35, dx + 0.35, -0.9, -0.6, -1, 3, 'wave'))
  g.add(slab(orange, -3.2, 3.2, -0.9, -0.6, -3.2, -2.4, 'wave'))
  g.position.set(x, y, z)
  return g
}
