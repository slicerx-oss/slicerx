// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The look lab's reading of the room's light: the room drawn into a 32 px half-float cube, read back and projected
// onto the nine spherical harmonics (src/env-sh.ts). Only the lab runs it, once per page after the view settles; the
// app's stage reads nothing back from the GPU.
import { CubeCamera, HalfFloatType, WebGLCoordinateSystem, WebGLCubeRenderTarget, type Vector3, type WebGLRenderer } from 'three'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { cubeFacesSH } from '../src/env-sh'

export function labRoomSH(renderer: WebGLRenderer): Vector3[] | null {
  const size = 32
  const room = new RoomEnvironment()
  const rt = new WebGLCubeRenderTarget(size, { type: HalfFloatType })
  try {
    new CubeCamera(0.1, 100, rt).update(renderer, room)
    const faces = Array.from({ length: 6 }, (_, face) => {
      const px = new Uint16Array(size * size * 4)
      renderer.readRenderTargetPixels(rt, 0, 0, size, size, px, face)
      return px
    })
    return cubeFacesSH(faces, size, renderer.coordinateSystem === WebGLCoordinateSystem ? -1 : 1)
  } catch (e) {
    console.warn('Environment bake failed', e)
    return null
  } finally {
    rt.dispose()
    room.dispose()
  }
}
