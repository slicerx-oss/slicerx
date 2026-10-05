// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { gpuProfile } from '../src/gpu'

const noCaveat = () => false
const caveat = () => true

describe('gpu profile', () => {
  it('treats llvmpipe, softpipe and SwiftShader as weak and software', () => {
    for (const name of ['llvmpipe (LLVM 19.1.1, 256 bits)', 'softpipe', 'Google SwiftShader', 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)']) {
      expect(gpuProfile(name, null, noCaveat, 8), name).toMatchObject({ weak: true, software: true, fromShell: false })
    }
  })

  it('leaves a real GPU on the high tier', () => {
    expect(gpuProfile('ANGLE (NVIDIA, NVIDIA GeForce RTX 5080 Direct3D11 vs_5_0 ps_5_0, D3D11)', null, noCaveat, 24)).toMatchObject({ weak: false, software: false })
    expect(gpuProfile('Mali-400 MP', null, noCaveat, 4)).toMatchObject({ weak: true, software: false })
  })

  it('trusts the shell over the name WebKit makes up', () => {
    // WebKitGTK on llvmpipe reports "Apple GPU" and still creates a context that refuses performance caveats.
    expect(gpuProfile('Apple GPU', 'llvmpipe (LLVM 19.1.1, 256 bits)', noCaveat, 24)).toEqual({ name: 'llvmpipe (LLVM 19.1.1, 256 bits)', weak: true, software: true, fromShell: true })
    // A real GPU from the shell is not second guessed by the caveat probe.
    expect(gpuProfile('Apple GPU', 'Mesa Intel(R) UHD Graphics 770 (ADL-S GT1)', caveat, 24)).toMatchObject({ weak: false, software: false, fromShell: true })
    // Without the shell, a masked name only shows software rendering through the probe.
    expect(gpuProfile('Apple GPU', null, caveat, 24)).toMatchObject({ weak: false, software: true, fromShell: false })
  })
})
