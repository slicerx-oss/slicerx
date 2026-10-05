// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Uses nothing from SlicerX but @slicerx/embed. The model is a stepped bracket
// built here as an ASCII STL, so the demo needs no files.
import { defineSlicerXElements } from '../src/index'

defineSlicerXElements()

function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): string {
  const v = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ]
  const faces = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]]
  return faces.map((f) => `facet normal 0 0 0\nouter loop\n${f.map((i) => `vertex ${v[i]?.join(' ')}`).join('\n')}\nendloop\nendfacet`).join('\n')
}

const stl = `solid bracket\n${box(0, 0, 0, 60, 30, 6)}\n${box(0, 0, 6, 12, 30, 40)}\n${box(12, 10, 6, 40, 20, 12)}\nendsolid bracket\n`
const url = URL.createObjectURL(new Blob([stl], { type: 'model/stl' }))
document.getElementById('vp')?.setAttribute('src', `${url}#bracket.stl`)

const out = document.getElementById('out')
document.getElementById('settings')?.addEventListener('change', (e) => {
  const { config } = (e as CustomEvent<{ config: Record<string, unknown> }>).detail
  const keys = ['layer_height', 'wall_loops', 'sparse_infill_density', 'outer_wall_speed', 'enable_support', 'brim_width']
  if (out) out.textContent = JSON.stringify(Object.fromEntries(keys.map((k) => [k, config[k]])), null, 2)
})
