// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The move, rotate and scale handles take every color from the theme: tokens.css names them, the palette mirrors them
// for GL, and the gizmo code holds no color of its own.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Box3, Color, Mesh, MeshBasicMaterial, Object3D, PerspectiveCamera, Vector3 } from 'three'
import { MoveArrows } from '../src/arrows'
import { ScaleGizmo } from '../src/gizmo'
import { SCENE, resolveTheme, type HandleColors } from '../src/palette'
import { RingSet } from '../src/rings'

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const GIZMO_FILES = ['../src/gizmo.ts', '../src/arrows.ts', '../src/rings.ts']

/** The token each handle color mirrors. */
const TOKENS: Record<keyof HandleColors, string> = {
  axisX: '--axis-x',
  axisY: '--axis-y',
  axisZ: '--axis-z',
  axisUniform: '--axis-uniform',
  handleHot: '--gizmo-hot',
  handlePinned: '--gizmo-pinned',
  handleHalo: '--gizmo-halo',
}

const THEME: HandleColors = { axisX: '#aa0000', axisY: '#00aa00', axisZ: '#0000aa', axisUniform: '#00aaaa', handleHot: '#aaaa00', handlePinned: '#777777', handleHalo: '#111111' }
const hexOf = (m: Mesh) => `#${(m.material as MeshBasicMaterial).color.getHexString()}`
/** A hex as three hands it back (sRGB in, linear inside, sRGB out). */
const norm = (hex: string) => `#${new Color(hex).getHexString()}`

describe('gizmo colors', () => {
  it('the gizmo code holds no color literal', () => {
    for (const f of GIZMO_FILES) {
      const src = read(f)
      expect(src.match(/#[0-9a-fA-F]{3,8}\b/g), f).toBeNull()
      expect(src.match(/\b0x[0-9a-fA-F]{3,8}\b/g), f).toBeNull()
      expect(src.match(/\b(?:rgb|hsl)a?\(/g), f).toBeNull()
      // a named color handed to three (new Color('red'), color: 'white') is a literal too
      expect(src.match(/(?:new Color\(|color: )\s*['"`]/g), f).toBeNull()
    }
  })

  it('the palette mirrors the handle tokens in tokens.css', () => {
    const css = read('../../src/tokens.css')
    for (const [key, token] of Object.entries(TOKENS) as [keyof HandleColors, string][]) {
      const m = css.match(new RegExp(`${token}\\s*:\\s*([^;]+);`))
      expect(m?.[1]?.trim(), token).toBe(SCENE[key])
    }
  })

  it('a theme reaches every handle color, and validates like any scene color', () => {
    expect(resolveTheme({ scene: THEME }).scene).toMatchObject(THEME)
    expect(() => resolveTheme({ scene: { handleHalo: 'black' } })).toThrow(/scene.handleHalo/)
  })

  it('scale handles, stems and outlines draw with the theme, hot and pinned included', () => {
    const g = new ScaleGizmo(SCENE)
    g.setColors(THEME)
    const obj = new Object3D()
    const box = new Box3(new Vector3(0, 0, 0), new Vector3(40, 20, 10))
    const cam = new PerspectiveCamera(30, 1, 1, 2000)
    cam.position.set(200, -200, 200)
    cam.lookAt(20, 10, 5)
    cam.updateMatrixWorld()
    const opts = { layout: 'bottom' as const, pivot: 'bottom-center' as const, pinned: false }
    g.update(obj, box, cam, 800, 30, opts)
    const meshes = g.group.children as Mesh[]
    const handle = (id: string) => meshes.find((m) => m.userData['handle'] === id) as Mesh
    expect(hexOf(handle('xp'))).toBe(norm(THEME.axisX))
    expect(hexOf(handle('yp'))).toBe(norm(THEME.axisY))
    expect(hexOf(handle('zp'))).toBe(norm(THEME.axisZ))
    expect(hexOf(handle('cnn'))).toBe(norm(THEME.axisUniform))
    // every visible handle sits on an outline in the halo color, drawn before it and a little bigger
    const halos = meshes.filter((m) => m.visible && hexOf(m) === norm(THEME.handleHalo))
    for (const id of ['xp', 'yp', 'zp', 'cnn']) {
      const h = handle(id)
      const under = halos.find((m) => m.position.equals(h.position))
      expect(under, id).toBeDefined()
      expect(under!.renderOrder).toBeLessThan(h.renderOrder)
      expect(under!.scale.x).toBeGreaterThan(h.scale.x)
    }
    g.setHover('xp')
    g.update(obj, box, cam, 800, 30, opts)
    expect(hexOf(handle('xp'))).toBe(norm(THEME.handleHot))
    g.update(obj, box, cam, 800, 30, { ...opts, pinned: true })
    expect(hexOf(handle('xn'))).toBe(norm(THEME.handlePinned))
    g.dispose()
  })

  it('move arrows draw with the theme and over an outline, and the hovered one turns hot', () => {
    const a = new MoveArrows(THEME)
    a.place([0, 0, 0], 10)
    const fills = () => a.group.children.map((g) => (g.children as Mesh[]).filter((m) => m.renderOrder === 10).map(hexOf))
    expect(fills()).toEqual([THEME.axisX, THEME.axisY, THEME.axisZ].map((c) => [norm(c), norm(c)]))
    for (const g of a.group.children) expect((g.children as Mesh[]).filter((m) => m.renderOrder < 10).map(hexOf)).toEqual([norm(THEME.handleHalo), norm(THEME.handleHalo)])
    a.setHover('y')
    a.place([0, 0, 0], 10)
    expect(fills()[1]).toEqual([norm(THEME.handleHot), norm(THEME.handleHot)])
    a.setColors({ ...THEME, axisX: '#123456' })
    expect(fills()[0]).toEqual([norm('#123456'), norm('#123456')])
    a.dispose()
  })

  it('rotate rings draw with the theme over an outline, and the hovered one turns hot', () => {
    const r = new RingSet(['x', 'y', 'z'] as const, { x: THEME.axisX, y: THEME.axisY, z: THEME.axisZ }, THEME)
    for (const id of ['x', 'y', 'z'] as const) r.place(id, [0, 0, 0], [0, 0, 1], 10)
    const rings = (r.group.children as Mesh[]).filter((m) => m.renderOrder === 10)
    expect(rings.map(hexOf)).toEqual([THEME.axisX, THEME.axisY, THEME.axisZ].map(norm))
    expect((r.group.children as Mesh[]).filter((m) => m.renderOrder === 8).map(hexOf)).toEqual([THEME.handleHalo, THEME.handleHalo, THEME.handleHalo].map(norm))
    r.setHover('z')
    r.setHandleColors({ handleHot: '#fedcba', handleHalo: '#010203' })
    r.place('z', [0, 0, 0], [0, 0, 1], 10)
    expect(hexOf(rings[2]!)).toBe(norm('#fedcba'))
    r.dispose()
  })
})
