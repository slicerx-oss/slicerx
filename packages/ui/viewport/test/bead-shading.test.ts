// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Toolpath beads are lit per pixel as round beads, each tool with its filament's finish.
import { describe, expect, it } from 'vitest'
import { ShaderLib, type DataTexture, type Material, type WebGLProgramParametersWithUniforms } from 'three'
import { BEAD_FINISHES, beadFinish, Toolpaths } from '../src/toolpaths'

type Inner = { material: Material; uniforms: { uFinishLut: { value: DataTexture } } }
const inner = (t: Toolpaths) => t as unknown as Inner

/** The shaders three.js would compile for the bead material (physical for the live paths, Phong for the ghost), through its own patch. */
function compiled(t: Toolpaths, lib: 'physical' | 'phong' = 'physical'): { vertex: string; fragment: string } {
  const sh = { uniforms: {}, vertexShader: ShaderLib[lib].vertexShader, fragmentShader: ShaderLib[lib].fragmentShader } as unknown as WebGLProgramParametersWithUniforms
  inner(t).material.onBeforeCompile(sh, undefined as never)
  return { vertex: sh.vertexShader, fragment: sh.fragmentShader }
}

describe('bead shading', () => {
  it('builds the bead in the vertex shader and lights it per pixel with the model view\'s physical material', () => {
    const { vertex, fragment } = compiled(new Toolpaths())
    // Every chunk the patch replaces is still in three.js's Phong shader: a renamed chunk would silently drop the bead.
    expect(vertex).toContain('sxBead(sxP, objectNormal)')
    expect(vertex).toContain('vec3 transformed = sxP;')
    expect(vertex).toContain('vProf = position.xy;')
    expect(vertex).not.toContain('#include <begin_vertex>')
    for (const chunk of ['color_fragment', 'roughnessmap_fragment', 'metalnessmap_fragment', 'normal_fragment_begin', 'aomap_fragment']) expect(fragment, chunk).not.toContain(`#include <${chunk}>`)
    expect(fragment).toContain('vec3 normal = sxKeep')
    expect(fragment).toContain('material.clearcoat = vFinish.y;')
    expect(fragment).toContain('#include <tonemapping_fragment>')
    // Stale paths dim before the output, through the same material.
    expect(fragment).toContain('* ( 1.0 - 0.35 * uStale )')
  })

  it('keeps the ghost lit per vertex', () => {
    const { vertex, fragment } = compiled(new Toolpaths(true), 'phong')
    expect(vertex).toContain('vLit = c;')
    expect(fragment).not.toContain('sxRound')
  })

  it('maps the model view finishes onto bead finishes', () => {
    expect(beadFinish('basic')).toBe('satin')
    expect(beadFinish('matte')).toBe('matte')
    expect(beadFinish('silk')).toBe('silk')
    expect(beadFinish('petg')).toBe('glossy')
    expect(beadFinish('translucent')).toBe('glossy')
    expect(beadFinish(undefined)).toBe('satin')
  })

  it('uploads one finish per tool, satin for a tool without one', () => {
    const t = new Toolpaths()
    t.setToolFinishes(['silk', 'matte'])
    const data = inner(t).uniforms.uFinishLut.value.image.data as Float32Array
    expect([...data.slice(0, 4)]).toEqual([...BEAD_FINISHES.silk].map((v) => Math.fround(v)))
    expect([...data.slice(4, 8)]).toEqual([...BEAD_FINISHES.matte].map((v) => Math.fround(v)))
    // Tools past the list take the first tool's finish, so one value covers every slot.
    expect([...data.slice(8, 12)]).toEqual([...BEAD_FINISHES.silk].map((v) => Math.fround(v)))
    t.setToolFinishes([])
    expect([...(inner(t).uniforms.uFinishLut.value.image.data as Float32Array).slice(0, 4)]).toEqual([...BEAD_FINISHES.satin].map((v) => Math.fround(v)))
  })
})
